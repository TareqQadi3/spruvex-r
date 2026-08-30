import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { Prisma } from "@prisma/client";

import {
  canTransition,
  DOMAIN_EVENTS,
  ORDER_STATUS_TRANSITIONS,
  type OrderSource,
  type OrderStatus,
} from "@spruvex-r/types";

import { AuditService } from "../../shared/audit/audit.service";
import { LimitsService } from "../../shared/billing/limits.service";
import { calculateRecipeCostUnits } from "../../shared/common/food-cost";
import { costUnitsToSar, halalasToSar, sarToHalalas, vatFromGross } from "../../shared/common/money";
import { PrismaService } from "../../shared/prisma/prisma.service";
import {
  actorOrNull,
  TenantContextService,
} from "../../shared/tenancy/tenant-context.service";
import { CreateOrderDto, OrderItemInputDto } from "./dto/order.dto";

export const ORDER_INCLUDE = {
  items: { include: { modifiers: true }, orderBy: { createdAt: "asc" } },
  table: { select: { id: true, number: true } },
  statusHistory: { orderBy: { createdAt: "asc" } },
  payments: { where: { status: "completed" }, orderBy: { createdAt: "asc" } },
} satisfies Prisma.OrderInclude;

/** Default cap for discounts; overridable per tenant via settings.maxDiscountPercent. */
const DEFAULT_MAX_DISCOUNT_PERCENT = 20;

interface CreateOrderContext {
  source: OrderSource;
  /** Overrides for the guest flow (no authenticated user). */
  tenantId?: string;
  /** Set only when a delivery-platform webhook is the caller (never public HTTP input). */
  delivery?: {
    externalOrderId: string;
    provider: string;
    commission: string | null;
  };
}

const NUMBER_CONFLICT_RETRIES = 3;

@Injectable()
export class OrderingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditService,
    private readonly events: EventEmitter2,
    private readonly limits: LimitsService,
  ) {}

  list(filter: { branchId?: string; statuses?: OrderStatus[]; limit?: number }) {
    return this.prisma.scoped.order.findMany({
      where: {
        deletedAt: null,
        ...(filter.branchId ? { branchId: filter.branchId } : {}),
        ...(filter.statuses?.length ? { status: { in: filter.statuses } } : {}),
      },
      orderBy: { createdAt: "asc" },
      take: Math.min(filter.limit ?? 100, 200),
      include: ORDER_INCLUDE,
    });
  }

  async get(id: string) {
    const order = await this.prisma.scoped.order.findFirst({
      where: { id, deletedAt: null },
      include: ORDER_INCLUDE,
    });
    if (!order) {
      throw new NotFoundException("Order not found");
    }
    return order;
  }

  /**
   * Creates an order atomically: validates products/modifiers against the
   * catalog, freezes price/name snapshots, computes totals in halalas,
   * assigns the daily sequential number, and (for dine-in) attaches the
   * order to the table's open session — opening one when none exists.
   */
  async create(dto: CreateOrderDto, opts: CreateOrderContext, idempotencyKey: string) {
    const ctx = this.tenantContext.contextOrThrow;
    const tenantId = opts.tenantId ?? this.tenantContext.tenantIdOrThrow;
    const actor = actorOrNull(ctx.userId);

    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      throw new BadRequestException("Idempotency-Key header is required (8-128 chars)");
    }

    // Idempotent replay: return the original order.
    const existing = await this.prisma.forTenant(tenantId).order.findFirst({
      where: { idempotencyKey },
      include: ORDER_INCLUDE,
    });
    if (existing) {
      return existing;
    }

    await this.limits.assertCanCreateOrder(tenantId);

    for (let attempt = 1; ; attempt++) {
      try {
        const order = await this.prisma.scopedTransaction(async (tx) => {
          return this.createInTransaction(tx, dto, opts, tenantId, actor, idempotencyKey);
        }, tenantId);

        await this.audit.log({
          tenantId,
          action: "order.created",
          entityType: "order",
          entityId: order.id,
          branchId: order.branchId,
          meta: { orderNumber: order.orderNumber, source: opts.source, total: order.total.toString() },
        });
        this.events.emit(DOMAIN_EVENTS.ORDER_CREATED, {
          tenantId,
          branchId: order.branchId,
          order,
        });

        if (dto.confirm) {
          return this.transition(order.id, "confirmed", { tenantId });
        }
        return order;
      } catch (error) {
        // Daily-number race: retry the whole transaction.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002" &&
          attempt < NUMBER_CONFLICT_RETRIES
        ) {
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * The single, central place status changes happen. Validates the transition
   * against the state machine, records history (who/when/why), audits, and
   * emits the domain event.
   */
  async transition(
    id: string,
    to: OrderStatus,
    opts: { reason?: string; tenantId?: string } = {},
  ) {
    const ctx = this.tenantContext.contextOrThrow;
    const tenantId = opts.tenantId ?? this.tenantContext.tenantIdOrThrow;
    const actor = actorOrNull(ctx.userId);

    if (to === "cancelled" && !ctx.permissions.has("orders.void")) {
      throw new ForbiddenException("Cancelling an order requires the orders.void permission");
    }
    if (to === "refunded" && !ctx.permissions.has("payments.refund")) {
      throw new ForbiddenException("Refunding an order requires the payments.refund permission");
    }

    const order = await this.prisma.scopedTransaction(async (tx) => {
      const current = await tx.order.findFirst({ where: { id, deletedAt: null } });
      if (!current) {
        throw new NotFoundException("Order not found");
      }
      if (!canTransition(current.status, to)) {
        throw new ConflictException(
          `Invalid transition ${current.status} -> ${to}. Allowed: ${
            ORDER_STATUS_TRANSITIONS[current.status].join(", ") || "none"
          }`,
        );
      }

      // Checkout guards (Phase 5): completion requires full payment;
      // cancellation is blocked once money has been taken.
      const paid = await tx.payment.aggregate({
        where: { orderId: id, status: "completed" },
        _sum: { amount: true },
      });
      const paidHalalas = sarToHalalas((paid._sum.amount ?? 0).toString());
      if (to === "completed" && paidHalalas < sarToHalalas(current.total.toString())) {
        throw new ConflictException("Cannot complete an order without full payment");
      }
      if (to === "cancelled" && paidHalalas > 0) {
        throw new ConflictException(
          "Order has recorded payments — it cannot be cancelled (refund via credit note later)",
        );
      }

      const updated = await tx.order.update({
        where: { id },
        data: {
          status: to,
          updatedBy: actor,
          ...(to === "cancelled" ? { cancelledReason: opts.reason } : {}),
        },
        include: ORDER_INCLUDE,
      });
      await tx.orderStatusHistory.create({
        data: {
          tenantId,
          orderId: id,
          fromStatus: current.status,
          toStatus: to,
          changedBy: actor,
          reason: opts.reason,
        },
      });
      return updated;
    }, tenantId);

    await this.audit.log({
      tenantId,
      action: to === "cancelled" ? "order.cancelled" : "order.status_changed",
      entityType: "order",
      entityId: id,
      branchId: order.branchId,
      meta: { to, reason: opts.reason ?? null, orderNumber: order.orderNumber },
    });
    this.events.emit(
      to === "cancelled" ? DOMAIN_EVENTS.ORDER_CANCELLED : DOMAIN_EVENTS.ORDER_STATUS_CHANGED,
      { tenantId, branchId: order.branchId, order },
    );
    return order;
  }

  /**
   * Applies (or replaces) a discount. Requires orders.discount (guard) and:
   * - the order is open and has NO recorded payments,
   * - the discount does not exceed the tenant's configurable cap
   *   (settings.maxDiscountPercent, default 20%) — unless `opts.bypassCap` is
   *   set, used exclusively by LoyaltyService for a merchant-configured
   *   reward (never reachable from the HTTP DTO, which has no such field):
   *   the cap exists to bound a cashier's discretionary discount, not the
   *   tenant's own loyalty program economics.
   * Totals + VAT are recomputed; who/why is stored and audited.
   */
  async applyDiscount(
    id: string,
    dto: { type: "percentage" | "fixed"; value: string; reason: string },
    opts: { bypassCap?: boolean } = {},
  ) {
    const ctx = this.tenantContext.contextOrThrow;
    const tenantId = this.tenantContext.tenantIdOrThrow;
    const actor = actorOrNull(ctx.userId);

    const order = await this.prisma.scopedTransaction(async (tx) => {
      const current = await tx.order.findFirst({ where: { id, deletedAt: null } });
      if (!current) {
        throw new NotFoundException("Order not found");
      }
      if (["completed", "cancelled"].includes(current.status)) {
        throw new ConflictException("Order is closed — discount not possible");
      }
      const paid = await tx.payment.count({
        where: { orderId: id, status: "completed" },
      });
      if (paid > 0) {
        throw new ConflictException("Order already has payments — discount not possible");
      }

      const tenant = await tx.tenant.findFirst({ where: { id: tenantId } });
      const settings = (tenant?.settings ?? {}) as { maxDiscountPercent?: number };
      const maxPercent = settings.maxDiscountPercent ?? DEFAULT_MAX_DISCOUNT_PERCENT;

      const subtotalHalalas = sarToHalalas(current.subtotal.toString());
      const valueHalalas = sarToHalalas(dto.value);
      let discountHalalas: number;
      if (dto.type === "percentage") {
        const pct = Number(dto.value);
        if (pct <= 0 || (!opts.bypassCap && pct > maxPercent)) {
          throw new BadRequestException(
            `Discount must be between 0 and ${maxPercent}% (restaurant limit)`,
          );
        }
        discountHalalas = Math.floor((subtotalHalalas * pct) / 100 + 0.5);
      } else {
        if (valueHalalas <= 0 || valueHalalas > subtotalHalalas) {
          throw new BadRequestException("Fixed discount must be positive and below the subtotal");
        }
        const pctEquivalent = (valueHalalas / subtotalHalalas) * 100;
        if (!opts.bypassCap && pctEquivalent > maxPercent) {
          throw new BadRequestException(
            `Discount exceeds the restaurant limit (${maxPercent}%)`,
          );
        }
        discountHalalas = valueHalalas;
      }

      const totalHalalas = subtotalHalalas - discountHalalas;
      const vatRate = Number(current.vatRate);
      return tx.order.update({
        where: { id },
        data: {
          discount: halalasToSar(discountHalalas),
          discountType: dto.type,
          discountValue: dto.value,
          discountReason: dto.reason,
          discountBy: actor,
          vatAmount: halalasToSar(vatFromGross(totalHalalas, vatRate)),
          total: halalasToSar(totalHalalas),
          updatedBy: actor,
        },
        include: ORDER_INCLUDE,
      });
    });

    await this.audit.log({
      action: "order.discount_applied",
      entityType: "order",
      entityId: id,
      branchId: order.branchId,
      meta: {
        type: dto.type,
        value: dto.value,
        discount: order.discount.toString(),
        reason: dto.reason,
      },
    });
    this.events.emit(DOMAIN_EVENTS.ORDER_STATUS_CHANGED, {
      tenantId,
      branchId: order.branchId,
      order,
    });
    return order;
  }

  /** Removes the discount (same rules as applying). */
  async removeDiscount(id: string) {
    const ctx = this.tenantContext.contextOrThrow;
    const tenantId = this.tenantContext.tenantIdOrThrow;
    const actor = actorOrNull(ctx.userId);

    const order = await this.prisma.scopedTransaction(async (tx) => {
      const current = await tx.order.findFirst({ where: { id, deletedAt: null } });
      if (!current) {
        throw new NotFoundException("Order not found");
      }
      if (["completed", "cancelled"].includes(current.status)) {
        throw new ConflictException("Order is closed");
      }
      const paid = await tx.payment.count({ where: { orderId: id, status: "completed" } });
      if (paid > 0) {
        throw new ConflictException("Order already has payments");
      }

      const subtotalHalalas = sarToHalalas(current.subtotal.toString());
      return tx.order.update({
        where: { id },
        data: {
          discount: "0",
          discountType: null,
          discountValue: null,
          discountReason: null,
          discountBy: null,
          vatAmount: halalasToSar(vatFromGross(subtotalHalalas, Number(current.vatRate))),
          total: halalasToSar(subtotalHalalas),
          updatedBy: actor,
        },
        include: ORDER_INCLUDE,
      });
    });

    await this.audit.log({
      action: "order.discount_removed",
      entityType: "order",
      entityId: id,
      branchId: order.branchId,
    });
    this.events.emit(DOMAIN_EVENTS.ORDER_STATUS_CHANGED, {
      tenantId,
      branchId: order.branchId,
      order,
    });
    return order;
  }

  /**
   * Appends a genuinely free line to an open, unpaid order — used for
   * loyalty stamp-card rewards. The product's real recipe cost is still
   * snapshotted (a free item still costs the restaurant real money, and
   * food-cost/margin reports must show that), but unitPrice/lineTotal are
   * forced to zero: a real $0 invoice line, not a hidden discount, so VAT
   * on it is correctly zero (zero consideration) and stock deduction still
   * fires normally on completion via the usual productId+quantity path.
   */
  async addComplimentaryItem(id: string, productId: string, reason: string) {
    const ctx = this.tenantContext.contextOrThrow;
    const tenantId = this.tenantContext.tenantIdOrThrow;
    const actor = actorOrNull(ctx.userId);

    const order = await this.prisma.scopedTransaction(async (tx) => {
      const current = await tx.order.findFirst({ where: { id, deletedAt: null } });
      if (!current) {
        throw new NotFoundException("Order not found");
      }
      if (["completed", "cancelled"].includes(current.status)) {
        throw new ConflictException("Order is closed — cannot add a complimentary item");
      }
      const paid = await tx.payment.count({ where: { orderId: id, status: "completed" } });
      if (paid > 0) {
        throw new ConflictException("Order already has payments — cannot add a complimentary item");
      }

      const [priced] = await this.priceItems(tx, [{ productId, quantity: 1 } as OrderItemInputDto], current.branchId);

      await tx.orderItem.create({
        data: {
          tenantId,
          orderId: id,
          productId: priced.productId,
          productSnapshot: { ...priced.productSnapshot, price: "0.00", complimentary: true },
          quantity: 1,
          unitPrice: "0",
          lineTotal: "0",
          unitCost: priced.unitCostUnits !== null ? costUnitsToSar(priced.unitCostUnits) : null,
          lineCost: priced.lineCostUnits !== null ? costUnitsToSar(priced.lineCostUnits) : null,
          notes: reason,
        },
      });

      // The free line contributes 0 to subtotal/VAT/total — nothing else to recompute.
      return tx.order.update({
        where: { id },
        data: { updatedBy: actor },
        include: ORDER_INCLUDE,
      });
    });

    await this.audit.log({
      action: "order.complimentary_item_added",
      entityType: "order",
      entityId: id,
      branchId: order.branchId,
      meta: { productId, reason },
    });
    this.events.emit(DOMAIN_EVENTS.ORDER_STATUS_CHANGED, {
      tenantId,
      branchId: order.branchId,
      order,
    });
    return order;
  }

  /**
   * Replaces the item list of a NOT-YET-CONFIRMED order (status = new).
   * Items are re-validated and re-priced against the catalog; totals and
   * any existing percentage discount are recomputed.
   */
  async editItems(id: string, items: OrderItemInputDto[]) {
    const ctx = this.tenantContext.contextOrThrow;
    const tenantId = this.tenantContext.tenantIdOrThrow;
    const actor = actorOrNull(ctx.userId);

    const order = await this.prisma.scopedTransaction(async (tx) => {
      const current = await tx.order.findFirst({ where: { id, deletedAt: null } });
      if (!current) {
        throw new NotFoundException("Order not found");
      }
      if (current.status !== "new") {
        throw new ConflictException(
          "Items can only be changed before the order is confirmed",
        );
      }

      const priced = await this.priceItems(tx, items, current.branchId);
      const subtotalHalalas = priced.reduce((sum, item) => sum + item.lineTotalHalalas, 0);

      let discountHalalas = 0;
      if (current.discountType === "percentage" && current.discountValue) {
        discountHalalas = Math.floor(
          (subtotalHalalas * Number(current.discountValue)) / 100 + 0.5,
        );
      } else if (current.discountType === "fixed" && current.discountValue) {
        discountHalalas = sarToHalalas(current.discountValue.toString());
        if (discountHalalas > subtotalHalalas) {
          throw new ConflictException("Existing fixed discount exceeds the new subtotal — remove it first");
        }
      }
      const totalHalalas = subtotalHalalas - discountHalalas;

      await tx.orderItemModifier.deleteMany({ where: { orderItem: { orderId: id } } });
      await tx.orderItem.deleteMany({ where: { orderId: id } });
      return tx.order.update({
        where: { id },
        data: {
          subtotal: halalasToSar(subtotalHalalas),
          discount: halalasToSar(discountHalalas),
          vatAmount: halalasToSar(vatFromGross(totalHalalas, Number(current.vatRate))),
          total: halalasToSar(totalHalalas),
          updatedBy: actor,
          items: {
            create: priced.map((item) => ({
              tenantId,
              productId: item.productId,
              productSnapshot: item.productSnapshot,
              quantity: item.quantity,
              unitPrice: halalasToSar(item.unitPriceHalalas),
              lineTotal: halalasToSar(item.lineTotalHalalas),
              unitCost: item.unitCostUnits !== null ? costUnitsToSar(item.unitCostUnits) : null,
              lineCost: item.lineCostUnits !== null ? costUnitsToSar(item.lineCostUnits) : null,
              notes: item.notes,
              modifiers: {
                create: item.modifiers.map((modifier) => ({
                  tenantId,
                  modifierId: modifier.modifierId,
                  modifierSnapshot: modifier.snapshot,
                  priceAdjustment: halalasToSar(modifier.adjustmentHalalas),
                })),
              },
            })),
          },
        },
        include: ORDER_INCLUDE,
      });
    });

    await this.audit.log({
      action: "order.items_updated",
      entityType: "order",
      entityId: id,
      branchId: order.branchId,
      meta: { itemCount: items.length, total: order.total.toString() },
    });
    this.events.emit(DOMAIN_EVENTS.ORDER_STATUS_CHANGED, {
      tenantId,
      branchId: order.branchId,
      order,
    });
    return order;
  }

  /**
   * Appends a new round of items to an ALREADY-EXISTING order — the shared
   * table-session case: several phones, each scanning the same table's QR,
   * keep adding to the SAME real order over the course of one meal, rather
   * than each opening its own separate order/receipt.
   *
   * Concurrency: two phones submitting at the same instant is the expected
   * case here, not an edge case, so this takes a real row lock
   * (`SELECT ... FOR UPDATE`) on the order for the duration of the
   * transaction instead of the optimistic read-then-write every other
   * mutation in this file uses — with two participants racing, optimistic
   * writes would let the second call silently clobber the first's items
   * (a lost update). The lock serializes the two calls; the second one
   * proceeds against the first's already-committed totals, so both rounds
   * always land. Idempotency (`OrderAppendLog`) is checked AFTER acquiring
   * the lock, so a retried request for a round already applied is a no-op
   * rather than a second lock/append.
   *
   * Deliberately rejects if a discount is already on the order: a
   * percentage discount would need re-deriving against a growing subtotal
   * on every single append, which either drifts under rounding or requires
   * yet another moving part — simpler and safer to require discounts be
   * applied once, at checkout, after the table stops ordering (removeDiscount
   * un-blocks this if it must be re-opened).
   *
   * If the kitchen/floor had already marked the ticket `ready`/`served`,
   * new items reopen it to `confirmed` — the same physical ticket picks up
   * a new line rather than silently sitting in a "done" column.
   */
  async appendItems(
    orderId: string,
    items: OrderItemInputDto[],
    participantPhone: string | null,
    idempotencyKey: string,
  ) {
    const ctx = this.tenantContext.contextOrThrow;
    const tenantId = this.tenantContext.tenantIdOrThrow;
    const actor = actorOrNull(ctx.userId);

    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      throw new BadRequestException("Idempotency-Key header is required (8-128 chars)");
    }

    const order = await this.prisma.scopedTransaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM orders WHERE id = ${orderId}::uuid FOR UPDATE
      `;
      if (locked.length === 0) {
        throw new NotFoundException("Order not found");
      }

      // Idempotent replay: a round already applied under this key is a no-op.
      try {
        await tx.orderAppendLog.create({ data: { tenantId, orderId, idempotencyKey } });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          return tx.order.findFirstOrThrow({ where: { id: orderId }, include: ORDER_INCLUDE });
        }
        throw error;
      }

      const current = await tx.order.findFirst({ where: { id: orderId, deletedAt: null } });
      if (!current) {
        throw new NotFoundException("Order not found");
      }
      // A cashier appending on behalf of a specific diner (not just the
      // guest QR flow, which already does this itself) still needs that
      // phone registered as a participant — otherwise an equal split or
      // the open-sessions view would silently miss them.
      if (participantPhone && current.tableSessionId) {
        await tx.tableSessionParticipant.upsert({
          where: { tableSessionId_phone: { tableSessionId: current.tableSessionId, phone: participantPhone } },
          update: { lastActivityAt: new Date() },
          create: {
            tenantId,
            branchId: current.branchId,
            tableSessionId: current.tableSessionId,
            phone: participantPhone,
          },
        });
      }
      return this.appendItemsCore(tx, tenantId, actor, current, items, participantPhone);
    });

    await this.audit.log({
      action: "order.items_appended",
      entityType: "order",
      entityId: orderId,
      branchId: order.branchId,
      meta: { itemCount: items.length, participantPhone, total: order.total.toString() },
    });
    this.events.emit(DOMAIN_EVENTS.ORDER_STATUS_CHANGED, {
      tenantId,
      branchId: order.branchId,
      order,
    });
    return order;
  }

  /**
   * Core append math, shared by `appendItems` (its own row-lock + idempotency
   * check above) and `orderForTable` (whose table-row-lock already serializes
   * everything for that table, so no separate order lock is needed there).
   */
  private async appendItemsCore(
    tx: Prisma.TransactionClient,
    tenantId: string,
    actor: string | null,
    current: { id: string; branchId: string; status: OrderStatus; discountType: string | null; subtotal: Prisma.Decimal; vatRate: Prisma.Decimal },
    items: OrderItemInputDto[],
    participantPhone: string | null,
  ) {
    if (["completed", "cancelled", "refunded"].includes(current.status)) {
      throw new ConflictException(
        "Order is closed — this table's bill was already settled, start a new session",
      );
    }
    if (current.discountType) {
      throw new ConflictException(
        "Remove the order's discount before adding more items, then reapply it at checkout",
      );
    }

    const priced = await this.priceItems(tx, items, current.branchId);
    const deltaSubtotalHalalas = priced.reduce((sum, item) => sum + item.lineTotalHalalas, 0);
    const newSubtotalHalalas = sarToHalalas(current.subtotal.toString()) + deltaSubtotalHalalas;
    const newTotalHalalas = newSubtotalHalalas; // no discount possible here (blocked above)
    const newVatHalalas = vatFromGross(newTotalHalalas, Number(current.vatRate));

    const reopen = current.status === "ready" || current.status === "served";

    return tx.order.update({
      where: { id: current.id },
      data: {
        subtotal: halalasToSar(newSubtotalHalalas),
        vatAmount: halalasToSar(newVatHalalas),
        total: halalasToSar(newTotalHalalas),
        updatedBy: actor,
        ...(reopen ? { status: "confirmed" } : {}),
        items: {
          create: priced.map((item) => ({
            tenantId,
            productId: item.productId,
            productSnapshot: item.productSnapshot,
            quantity: item.quantity,
            unitPrice: halalasToSar(item.unitPriceHalalas),
            lineTotal: halalasToSar(item.lineTotalHalalas),
            unitCost: item.unitCostUnits !== null ? costUnitsToSar(item.unitCostUnits) : null,
            lineCost: item.lineCostUnits !== null ? costUnitsToSar(item.lineCostUnits) : null,
            notes: item.notes,
            participantPhone,
            modifiers: {
              create: item.modifiers.map((modifier) => ({
                tenantId,
                modifierId: modifier.modifierId,
                modifierSnapshot: modifier.snapshot,
                priceAdjustment: halalasToSar(modifier.adjustmentHalalas),
              })),
            },
          })),
        },
        ...(reopen
          ? {
              statusHistory: {
                create: {
                  tenantId,
                  fromStatus: current.status,
                  toStatus: "confirmed",
                  changedBy: actor,
                  reason: "New items added to the order",
                },
              },
            }
          : {}),
      },
      include: ORDER_INCLUDE,
    });
  }

  /**
   * The single entry point for shared table-session ordering — used by both
   * the guest QR flow and a cashier's "add to this table" action from the
   * POS. Locks the TABLE row for the duration of the transaction (not just
   * the order): two phones scanning the same table's QR at the same instant
   * must never both conclude "no session/order exists yet" and each create
   * their own — the loser has to see the winner's session and order and
   * append to it instead. `Order.idempotencyKey` is checked BEFORE deciding
   * create-vs-append (not just inside the create branch), which is what
   * makes a network retry safe even though the retry might now see a
   * different state (an order that didn't exist on the first attempt) than
   * the original call did.
   */
  async orderForTable(
    tableId: string,
    items: OrderItemInputDto[],
    participantPhone: string,
    opts: { source: OrderSource; customerName?: string; notes?: string },
    idempotencyKey: string,
  ) {
    const ctx = this.tenantContext.contextOrThrow;
    const tenantId = this.tenantContext.tenantIdOrThrow;
    const actor = actorOrNull(ctx.userId);

    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      throw new BadRequestException("Idempotency-Key header is required (8-128 chars)");
    }

    // Retried create: this exact key already produced an order (any table/session).
    const existingByKey = await this.prisma.forTenant(tenantId).order.findFirst({
      where: { idempotencyKey },
    });
    if (existingByKey) {
      const session = existingByKey.tableSessionId
        ? await this.prisma.forTenant(tenantId).tableSession.findUnique({ where: { id: existingByKey.tableSessionId } })
        : null;
      return { order: await this.get(existingByKey.id), session, created: true };
    }

    await this.limits.assertCanCreateOrder(tenantId);

    for (let attempt = 1; ; attempt++) {
      try {
        const result = await this.prisma.scopedTransaction(async (tx) => {
          const lockedTable = await tx.$queryRaw<{ id: string; branch_id: string; status: string }[]>`
            SELECT id, branch_id, status FROM tables WHERE id = ${tableId}::uuid FOR UPDATE
          `;
          if (lockedTable.length === 0) {
            throw new NotFoundException("Table not found");
          }
          if (lockedTable[0].status === "disabled") {
            throw new ConflictException("Table is disabled");
          }
          const branchId = lockedTable[0].branch_id;

          let session = await tx.tableSession.findFirst({ where: { tableId, closedAt: null } });
          if (!session) {
            try {
              session = await tx.tableSession.create({
                data: { tenantId, branchId, tableId, openedBy: actor },
              });
            } catch (error) {
              if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
                session = await tx.tableSession.findFirstOrThrow({ where: { tableId, closedAt: null } });
              } else {
                throw error;
              }
            }
          }
          if (lockedTable[0].status !== "occupied") {
            await tx.table.update({ where: { id: tableId }, data: { status: "occupied" } });
          }

          await tx.tableSessionParticipant.upsert({
            where: { tableSessionId_phone: { tableSessionId: session.id, phone: participantPhone } },
            update: { lastActivityAt: new Date(), ...(opts.customerName ? { name: opts.customerName } : {}) },
            create: {
              tenantId,
              branchId,
              tableSessionId: session.id,
              phone: participantPhone,
              name: opts.customerName,
            },
          });
          await tx.tableSession.update({
            where: { id: session.id },
            data: { lastActivityAt: new Date(), staleFlaggedAt: null },
          });

          const activeOrder = await tx.order.findFirst({
            where: { tableSessionId: session.id, status: { notIn: ["completed", "cancelled", "refunded"] } },
          });

          if (!activeOrder) {
            const created = await this.createInTransaction(
              tx,
              {
                type: "dine_in",
                tableId,
                items,
                customerName: opts.customerName,
                customerPhone: participantPhone,
              },
              { source: opts.source },
              tenantId,
              actor,
              idempotencyKey,
            );
            await tx.orderItem.updateMany({ where: { orderId: created.id }, data: { participantPhone } });
            return { orderId: created.id, sessionId: session.id, created: true as const };
          }

          try {
            await tx.orderAppendLog.create({
              data: { tenantId, orderId: activeOrder.id, idempotencyKey },
            });
          } catch (error) {
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
              return { orderId: activeOrder.id, sessionId: session.id, created: false as const };
            }
            throw error;
          }
          await this.appendItemsCore(tx, tenantId, actor, activeOrder, items, participantPhone);
          return { orderId: activeOrder.id, sessionId: session.id, created: false as const };
        });

        const order = await this.get(result.orderId);
        if (result.created) {
          await this.audit.log({
            tenantId,
            action: "order.created",
            entityType: "order",
            entityId: order.id,
            branchId: order.branchId,
            meta: { orderNumber: order.orderNumber, source: opts.source, total: order.total.toString() },
          });
          this.events.emit(DOMAIN_EVENTS.ORDER_CREATED, { tenantId, branchId: order.branchId, order });
        } else {
          await this.audit.log({
            tenantId,
            action: "order.items_appended",
            entityType: "order",
            entityId: order.id,
            branchId: order.branchId,
            meta: { itemCount: items.length, participantPhone, total: order.total.toString() },
          });
          this.events.emit(DOMAIN_EVENTS.ORDER_STATUS_CHANGED, { tenantId, branchId: order.branchId, order });
        }
        return { order, sessionId: result.sessionId };
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002" &&
          attempt < NUMBER_CONFLICT_RETRIES
        ) {
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * Read-only bill-split suggestion for a shared table-session order — the
   * cashier still charges each amount through the existing multi-tender
   * `POST /orders/:id/payments` (one call per person); this only computes
   * how much. Items with no `participantPhone` (e.g. a cashier-added round
   * with nobody picked) are pooled into an implicit "shared" share split
   * equally among everyone, in both modes.
   */
  async computeSplit(orderId: string, mode: "equal" | "by_item") {
    const order = await this.prisma.scoped.order.findFirst({
      where: { id: orderId, deletedAt: null },
      include: {
        items: { select: { lineTotal: true, participantPhone: true, refundedQuantity: true, quantity: true } },
      },
    });
    if (!order) {
      throw new NotFoundException("Order not found");
    }

    const participants = order.tableSessionId
      ? await this.prisma.scoped.tableSessionParticipant.findMany({
          where: { tableSessionId: order.tableSessionId },
          orderBy: { joinedAt: "asc" },
          select: { phone: true, name: true },
        })
      : [];
    // A refund never rewrites Order.total (the original issued amount is
    // immutable, same as any invoice) — it's tracked separately as a credit
    // note against the order's receipt. The split must reflect what's
    // actually still owed, so net any credit notes out of the total here.
    const receipt = await this.prisma.scoped.receipt.findUnique({
      where: { orderId },
      select: { id: true },
    });
    const creditNotes = receipt
      ? await this.prisma.scoped.creditNote.aggregate({
          where: { receiptId: receipt.id },
          _sum: { total: true },
        })
      : null;
    const refundedHalalas = creditNotes?._sum.total ? sarToHalalas(creditNotes._sum.total.toString()) : 0;
    const totalHalalas = sarToHalalas(order.total.toString()) - refundedHalalas;

    if (participants.length === 0) {
      // No session (or nobody recorded as a participant) — nothing to split.
      return {
        mode,
        total: halalasToSar(totalHalalas),
        participants: [
          { phone: order.customerPhone, name: order.customerName, amount: halalasToSar(totalHalalas) },
        ],
      };
    }

    if (mode === "equal") {
      const count = participants.length;
      const base = Math.floor(totalHalalas / count);
      let remainder = totalHalalas - base * count;
      const shares = participants.map((p) => {
        const extra = remainder > 0 ? 1 : 0;
        if (remainder > 0) remainder -= 1;
        return { phone: p.phone, name: p.name, amountHalalas: base + extra };
      });
      return {
        mode,
        total: halalasToSar(totalHalalas),
        participants: shares.map((s) => ({ phone: s.phone, name: s.name, amount: halalasToSar(s.amountHalalas) })),
      };
    }

    // by_item: each participant pays for their own (unrefunded) lines, plus
    // an equal share of anything nobody was tagged for. A discount changes
    // the order's total relative to the raw item sum, so every share is
    // scaled by that same ratio to spread the discount fairly.
    const rawByPhone = new Map<string, number>();
    let sharedRawHalalas = 0;
    let rawSubtotalHalalas = 0;
    for (const item of order.items) {
      const unitHalalas = Math.round(
        sarToHalalas(item.lineTotal.toString()) / item.quantity,
      );
      const outstandingQuantity = item.quantity - item.refundedQuantity;
      const outstandingHalalas = unitHalalas * outstandingQuantity;
      rawSubtotalHalalas += outstandingHalalas;
      if (item.participantPhone) {
        rawByPhone.set(item.participantPhone, (rawByPhone.get(item.participantPhone) ?? 0) + outstandingHalalas);
      } else {
        sharedRawHalalas += outstandingHalalas;
      }
    }
    const sharedPerHeadHalalas = participants.length > 0 ? sharedRawHalalas / participants.length : 0;
    const ratio = rawSubtotalHalalas > 0 ? totalHalalas / rawSubtotalHalalas : 1;

    let allocated = 0;
    const shares = participants.map((p, index) => {
      const rawShare = (rawByPhone.get(p.phone) ?? 0) + sharedPerHeadHalalas;
      const isLast = index === participants.length - 1;
      const amountHalalas = isLast
        ? totalHalalas - allocated
        : Math.round(rawShare * ratio);
      if (!isLast) allocated += amountHalalas;
      return { phone: p.phone, name: p.name, amountHalalas };
    });

    return {
      mode,
      total: halalasToSar(totalHalalas),
      participants: shares.map((s) => ({ phone: s.phone, name: s.name, amount: halalasToSar(s.amountHalalas) })),
    };
  }

  /**
   * Attaches/updates a customer on an already-created, still-open order —
   * the POS "add customer at checkout" action, for a walk-in who wasn't
   * identified when the order was first created. This is what lets the
   * loyalty program's manual redemption (which reads the order's own
   * customerPhone) work for a dine-in/walk-in sale, not just guest/delivery
   * orders that already collect a phone number up front.
   */
  async setCustomer(id: string, customerPhone: string, customerName: string | undefined) {
    const ctx = this.tenantContext.contextOrThrow;
    const tenantId = this.tenantContext.tenantIdOrThrow;
    const actor = actorOrNull(ctx.userId);

    const order = await this.prisma.scopedTransaction(async (tx) => {
      const current = await tx.order.findFirst({ where: { id, deletedAt: null } });
      if (!current) {
        throw new NotFoundException("Order not found");
      }
      if (["completed", "cancelled"].includes(current.status)) {
        throw new ConflictException("Order is closed");
      }
      return tx.order.update({
        where: { id },
        data: { customerPhone, customerName, updatedBy: actor },
        include: ORDER_INCLUDE,
      });
    });

    await this.audit.log({
      action: "order.customer_set",
      entityType: "order",
      entityId: id,
      branchId: order.branchId,
      meta: { customerPhone },
    });
    this.events.emit(DOMAIN_EVENTS.ORDER_STATUS_CHANGED, {
      tenantId,
      branchId: order.branchId,
      order,
    });
    return order;
  }

  // --------------------------------------------------------------------- //

  private async createInTransaction(
    tx: Prisma.TransactionClient,
    dto: CreateOrderDto,
    opts: CreateOrderContext,
    tenantId: string,
    actor: string | null,
    idempotencyKey: string,
  ) {
    // Resolve branch + table/session.
    let branchId: string;
    let tableId: string | null = null;
    let tableSessionId: string | null = null;

    if (dto.type === "dine_in") {
      if (!dto.tableId) {
        throw new BadRequestException("tableId is required for dine-in orders");
      }
      const table = await tx.table.findFirst({
        where: { id: dto.tableId, deletedAt: null },
      });
      if (!table) {
        throw new NotFoundException("Table not found");
      }
      if (table.status === "disabled") {
        throw new ConflictException("Table is disabled");
      }
      branchId = table.branchId;
      tableId = table.id;

      // Orders join the table's open session; open one if none exists.
      const session =
        (await tx.tableSession.findFirst({
          where: { tableId: table.id, closedAt: null },
        })) ??
        (await tx.tableSession.create({
          data: { tenantId, branchId, tableId: table.id, openedBy: actor },
        }));
      tableSessionId = session.id;
      if (table.status !== "occupied") {
        await tx.table.update({ where: { id: table.id }, data: { status: "occupied" } });
      }
    } else {
      if (!dto.branchId) {
        throw new BadRequestException("branchId is required for non-dine-in orders");
      }
      const branch = await tx.branch.findFirst({
        where: { id: dto.branchId, deletedAt: null },
      });
      if (!branch) {
        throw new NotFoundException("Branch not found");
      }
      branchId = branch.id;
    }

    const priced = await this.priceItems(tx, dto.items, branchId);

    const tenant = await tx.tenant.findFirst({ where: { id: tenantId } });
    const vatRate = Number(tenant?.vatRate ?? 15);
    const subtotalHalalas = priced.reduce((sum, item) => sum + item.lineTotalHalalas, 0);
    const vatHalalas = vatFromGross(subtotalHalalas, vatRate);

    // Daily sequential number per branch.
    const today = new Date();
    const orderDate = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
    );
    const last = await tx.order.findFirst({
      where: { branchId, orderDate },
      orderBy: { orderNumber: "desc" },
      select: { orderNumber: true },
    });

    const order = await tx.order.create({
      data: {
        tenantId,
        branchId,
        orderNumber: (last?.orderNumber ?? 0) + 1,
        orderDate,
        type: dto.type,
        source: opts.source,
        tableId,
        tableSessionId,
        customerName: dto.customerName,
        customerPhone: dto.customerPhone,
        notes: dto.notes,
        subtotal: halalasToSar(subtotalHalalas),
        discount: "0",
        vatRate: vatRate.toFixed(2),
        vatAmount: halalasToSar(vatHalalas),
        total: halalasToSar(subtotalHalalas),
        idempotencyKey,
        placedBy: actor,
        createdBy: actor,
        ...(opts.delivery
          ? {
              externalOrderId: opts.delivery.externalOrderId,
              deliveryProvider: opts.delivery.provider,
              deliveryCommission: opts.delivery.commission,
            }
          : {}),
        items: {
          create: priced.map((item) => ({
            tenantId,
            productId: item.productId,
            productSnapshot: item.productSnapshot,
            quantity: item.quantity,
            unitPrice: halalasToSar(item.unitPriceHalalas),
            lineTotal: halalasToSar(item.lineTotalHalalas),
            unitCost: item.unitCostUnits !== null ? costUnitsToSar(item.unitCostUnits) : null,
            lineCost: item.lineCostUnits !== null ? costUnitsToSar(item.lineCostUnits) : null,
            notes: item.notes,
            modifiers: {
              create: item.modifiers.map((modifier) => ({
                tenantId,
                modifierId: modifier.modifierId,
                modifierSnapshot: modifier.snapshot,
                priceAdjustment: halalasToSar(modifier.adjustmentHalalas),
              })),
            },
          })),
        },
        statusHistory: {
          create: { tenantId, fromStatus: null, toStatus: "new", changedBy: actor },
        },
      },
      include: ORDER_INCLUDE,
    });
    return order;
  }

  /** Validates items against the catalog and freezes snapshots + prices. */
  private async priceItems(
    tx: Prisma.TransactionClient,
    items: OrderItemInputDto[],
    branchId: string,
  ) {
    const productIds = [...new Set(items.map((item) => item.productId))];
    const products = await tx.product.findMany({
      where: { id: { in: productIds }, deletedAt: null, isActive: true },
      include: {
        branchSettings: { where: { branchId } },
        modifierGroups: {
          include: {
            group: {
              include: { modifiers: { where: { deletedAt: null, isActive: true } } },
            },
          },
        },
        // Food-cost snapshot (Phase 7): products without a recipe simply have
        // an empty array here, and unitCost/lineCost stay null below.
        recipeItems: { include: { ingredient: true, unit: true } },
      },
    });
    const productById = new Map(products.map((product) => [product.id, product]));

    return items.map((item) => {
      const product = productById.get(item.productId);
      if (!product) {
        throw new NotFoundException(`Product not found or inactive: ${item.productId}`);
      }
      const branchSetting = product.branchSettings[0];
      if (branchSetting && !branchSetting.isAvailable) {
        throw new ConflictException(`Product "${product.name}" is not available in this branch`);
      }

      const unitPriceHalalas = sarToHalalas(
        (branchSetting?.priceOverride ?? product.basePrice).toString(),
      );

      // Validate selected modifiers against the product's attached groups.
      const selectedIds = item.modifierIds ?? [];
      if (new Set(selectedIds).size !== selectedIds.length) {
        throw new BadRequestException("Duplicate modifier selection");
      }
      const attachedGroups = product.modifierGroups
        .map((link) => link.group)
        .filter((group) => group.deletedAt === null && group.isActive);
      const modifierIndex = new Map(
        attachedGroups.flatMap((group) =>
          group.modifiers.map((modifier) => [modifier.id, { modifier, group }] as const),
        ),
      );

      const resolved = selectedIds.map((modifierId) => {
        const entry = modifierIndex.get(modifierId);
        if (!entry) {
          throw new BadRequestException(
            `Modifier ${modifierId} is not available for product "${product.name}"`,
          );
        }
        return entry;
      });

      // Enforce group selection rules (min/max, required).
      for (const group of attachedGroups) {
        const count = resolved.filter((entry) => entry.group.id === group.id).length;
        const min = group.isRequired ? Math.max(group.minSelect, 1) : group.minSelect;
        if (count < min) {
          throw new BadRequestException(
            `Group "${group.name}" requires at least ${min} selection(s) for "${product.name}"`,
          );
        }
        if (group.maxSelect != null && count > group.maxSelect) {
          throw new BadRequestException(
            `Group "${group.name}" allows at most ${group.maxSelect} selection(s)`,
          );
        }
      }

      const modifiers = resolved.map(({ modifier, group }) => ({
        modifierId: modifier.id,
        adjustmentHalalas: sarToHalalas(modifier.priceAdjustment.toString()),
        snapshot: {
          name: modifier.name,
          nameEn: modifier.nameEn,
          groupName: group.name,
          groupNameEn: group.nameEn,
        },
      }));

      const adjustments = modifiers.reduce((sum, m) => sum + m.adjustmentHalalas, 0);
      const lineTotalHalalas = (unitPriceHalalas + adjustments) * item.quantity;

      // Food-cost snapshot: frozen from the recipe as it stands right now.
      // null when the product has no recipe defined yet.
      const unitCostUnits =
        product.recipeItems.length > 0
          ? calculateRecipeCostUnits(
              product.recipeItems.map((recipeItem) => ({
                quantity: recipeItem.quantity.toString(),
                unitToBaseFactor: recipeItem.unit.toBaseFactor.toString(),
                ingredientAverageCost: recipeItem.ingredient.averageCost.toString(),
              })),
            )
          : null;

      return {
        productId: product.id,
        quantity: item.quantity,
        notes: item.notes,
        unitPriceHalalas,
        lineTotalHalalas,
        unitCostUnits,
        lineCostUnits: unitCostUnits !== null ? unitCostUnits * item.quantity : null,
        productSnapshot: {
          name: product.name,
          nameEn: product.nameEn,
          sku: product.sku,
          price: halalasToSar(unitPriceHalalas),
        },
        modifiers,
      };
    });
  }
}
