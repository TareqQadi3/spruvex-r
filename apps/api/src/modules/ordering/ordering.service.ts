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
   *   (settings.maxDiscountPercent, default 20%).
   * Totals + VAT are recomputed; who/why is stored and audited.
   */
  async applyDiscount(
    id: string,
    dto: { type: "percentage" | "fixed"; value: string; reason: string },
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
        if (pct <= 0 || pct > maxPercent) {
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
        if (pctEquivalent > maxPercent) {
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
