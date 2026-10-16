import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { Prisma } from "@prisma/client";
import { DOMAIN_EVENTS } from "@spruvex-r/types";

import { AuditService } from "../../shared/audit/audit.service";
import { costUnitsToSar, sarToCostUnits } from "../../shared/common/money";
import { PrismaService } from "../../shared/prisma/prisma.service";
import {
  actorOrNull,
  GUEST_ACTOR,
  TenantContextService,
} from "../../shared/tenancy/tenant-context.service";
import {
  RecordAdjustmentDto,
  RecordPurchaseDto,
  RecordWasteDto,
} from "./dto/stock-movement.dto";
import { StockLocationsService } from "./stock-locations.service";

/** Line items from the order.status_changed event payload, trimmed to what deduction needs. */
export interface CompletedOrderItem {
  productId: string;
  quantity: number;
}

/** One auto-hide/auto-show decision made by reevaluateStockGating, for the caller to audit-log after commit. */
interface StockGatingEvent {
  action: "hidden" | "shown";
  productId: string;
  branchId: string;
  ingredientId: string;
}

/** One reorder-alert enter/clear decision made by reevaluateReorderAlerts, for the caller to audit-log (and, on "entered", notify) after commit. */
interface ReorderAlertEvent {
  action: "entered" | "cleared";
  ingredientId: string;
  branchId: string;
  currentQuantity: string;
  reorderLevel: string;
}

@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditService,
    private readonly locations: StockLocationsService,
    private readonly events: EventEmitter2,
  ) {}

  levels(branchId?: string, locationId?: string) {
    return this.prisma.scoped.stockLevel.findMany({
      where: {
        ...(branchId ? { branchId } : {}),
        ...(locationId ? { locationId } : {}),
      },
      include: {
        ingredient: { select: { id: true, name: true, nameEn: true, unitType: true, reorderLevel: true } },
        location: { select: { id: true, name: true, nameEn: true } },
      },
      orderBy: { updatedAt: "desc" },
    });
  }

  movements(filter: { branchId?: string; ingredientId?: string; limit?: number }) {
    return this.prisma.scoped.stockMovement.findMany({
      where: {
        ...(filter.branchId ? { branchId: filter.branchId } : {}),
        ...(filter.ingredientId ? { ingredientId: filter.ingredientId } : {}),
      },
      include: {
        ingredient: { select: { id: true, name: true, nameEn: true } },
        location: { select: { id: true, name: true, nameEn: true } },
      },
      orderBy: { createdAt: "desc" },
      take: Math.min(filter.limit ?? 100, 300),
    });
  }

  /**
   * `opts.tx` lets a caller that already holds an open transaction (e.g.
   * PurchasesService confirming a purchase invoice) fold this into the SAME
   * atomic unit instead of opening a second, independent transaction —
   * Prisma's interactive transactions don't nest, and this feature must
   * never leave stock posted for an invoice whose confirm then fails.
   * `opts.referenceType`/`referenceId` tag the resulting movement for
   * idempotent tracing back to whatever caused it (same convention as the
   * system-triggered sale_deduction rows) — omitted for the plain manual
   * "record a purchase" form, which has no such source document.
   */
  async recordPurchase(
    dto: RecordPurchaseDto,
    opts: { referenceType?: string; referenceId?: string; tx?: Prisma.TransactionClient } = {},
  ) {
    const ctx = this.tenantContext.contextOrThrow;
    const actor = actorOrNull(ctx.userId);
    const quantityBase = Number(dto.quantity);

    const run = async (tx: Prisma.TransactionClient) => {
      const ingredient = await this.ingredientOrThrow(tx, dto.ingredientId);
      const locationId = await this.resolveLocationId(tx, dto.branchId, dto.locationId);

      const movement = await this.createMovement(tx, {
        branchId: dto.branchId,
        locationId,
        ingredientId: dto.ingredientId,
        type: "purchase",
        quantity: quantityBase,
        unitCost: dto.unitCost,
        referenceType: opts.referenceType,
        referenceId: opts.referenceId,
        reason: dto.reason,
        performedBy: actor,
      });

      // Weighted moving average: (oldQty*oldCost + newQty*newCost) / (oldQty+newQty).
      const level = await this.upsertLevel(tx, dto.branchId, locationId, dto.ingredientId, quantityBase);
      const priorQty = Number(level.quantity) - quantityBase;
      await this.blendAverageCost(tx, ingredient, priorQty, quantityBase, dto.unitCost, actor);

      await this.audit.log({
        action: "stock.purchase_recorded",
        entityType: "stock_movement",
        entityId: movement.id,
        branchId: dto.branchId,
        meta: { ingredientId: dto.ingredientId, quantity: dto.quantity, unitCost: dto.unitCost },
      });

      const gatingEvents = await this.reevaluateStockGating(
        tx,
        this.tenantContext.tenantIdOrThrow,
        dto.branchId,
        dto.ingredientId,
      );
      await this.logGatingEvents(dto.branchId, gatingEvents);
      const reorderEvents = await this.reevaluateReorderAlerts(
        tx,
        this.tenantContext.tenantIdOrThrow,
        dto.branchId,
        dto.ingredientId,
      );
      await this.logReorderAlertEvents(reorderEvents);
      return movement;
    };

    if (opts.tx) return run(opts.tx);
    return this.prisma.scopedTransaction(run);
  }

  /**
   * Reverses a specific prior "purchase" movement (e.g. a purchase invoice
   * being cancelled) — never edits or deletes the original, only appends a
   * new negative `purchase_reversal` movement, mirroring how a sales credit
   * note never rewrites the original receipt.
   *
   * Refuses the reversal outright (ConflictException, quantity in the
   * message) if the location no longer holds enough of that ingredient —
   * some of it may already have been sold, wasted, or transferred out —
   * rather than silently driving the stock level negative. The caller
   * decides what to do next; this never partially reverses on its own.
   *
   * The average-cost math is the exact inverse of recordPurchase's blend:
   * `(currentQty*currentAvg - reverseQty*originalUnitCost) / (currentQty -
   * reverseQty)`. This is only well-defined while `currentQty > reverseQty`
   * (handled: skipped when it would fully drain the location, since a
   * blended average over zero units is meaningless) and is clamped at zero
   * as defense-in-depth against a inconsistent state, never expected in
   * normal operation.
   */
  async reversePurchase(
    input: { movementId: string; quantity: string; reason?: string },
    opts: { referenceType: string; referenceId: string; tx?: Prisma.TransactionClient },
  ) {
    const ctx = this.tenantContext.contextOrThrow;
    const actor = actorOrNull(ctx.userId);
    const reverseQty = Number(input.quantity);

    const run = async (tx: Prisma.TransactionClient) => {
      const original = await tx.stockMovement.findFirst({
        where: { id: input.movementId, type: "purchase" },
      });
      if (!original) {
        throw new NotFoundException("Original purchase movement not found");
      }
      if (reverseQty <= 0 || reverseQty > Number(original.quantity)) {
        throw new BadRequestException(
          `Reversal quantity (${input.quantity}) cannot exceed the original purchase quantity (${original.quantity.toString()})`,
        );
      }

      // Lock the exact (location, ingredient) balance this reversal would
      // touch before reading it, so a concurrent sale/reversal against the
      // same bucket can't race the availability check below.
      const locked = await tx.$queryRaw<{ quantity: string }[]>`
        SELECT quantity FROM stock_levels
        WHERE location_id = ${original.locationId}::uuid AND ingredient_id = ${original.ingredientId}::uuid
        FOR UPDATE
      `;
      const availableQty = locked.length > 0 ? Number(locked[0].quantity) : 0;
      if (availableQty < reverseQty) {
        throw new ConflictException(
          `Cannot reverse ${reverseQty} unit(s) of this ingredient — only ${availableQty} unit(s) remain at this location ` +
            `(some may already have been sold, wasted, or transferred out). Available: ${availableQty}, requested: ${reverseQty}.`,
        );
      }

      const ingredient = await this.ingredientOrThrow(tx, original.ingredientId);
      const movement = await this.createMovement(tx, {
        branchId: original.branchId,
        locationId: original.locationId,
        ingredientId: original.ingredientId,
        type: "purchase_reversal",
        quantity: -reverseQty,
        unitCost: original.unitCost?.toString(),
        referenceType: opts.referenceType,
        referenceId: opts.referenceId,
        reason: input.reason,
        performedBy: actor,
      });
      await this.upsertLevel(tx, original.branchId, original.locationId, original.ingredientId, -reverseQty);

      const remainingQty = availableQty - reverseQty;
      if (remainingQty > 0 && original.unitCost) {
        const currentCostUnits = sarToCostUnits(ingredient.averageCost.toString());
        const originalCostUnits = sarToCostUnits(original.unitCost.toString());
        const unblended = Math.round(
          (availableQty * currentCostUnits - reverseQty * originalCostUnits) / remainingQty,
        );
        await tx.ingredient.update({
          where: { id: original.ingredientId },
          data: { averageCost: costUnitsToSar(Math.max(0, unblended)), updatedBy: actor },
        });
      }

      await this.audit.log({
        action: "stock.purchase_reversed",
        entityType: "stock_movement",
        entityId: movement.id,
        branchId: original.branchId,
        meta: {
          ingredientId: original.ingredientId,
          originalMovementId: original.id,
          quantity: input.quantity,
          reason: input.reason,
        },
      });

      const gatingEvents = await this.reevaluateStockGating(
        tx,
        this.tenantContext.tenantIdOrThrow,
        original.branchId,
        original.ingredientId,
      );
      await this.logGatingEvents(original.branchId, gatingEvents);
      const reorderEvents = await this.reevaluateReorderAlerts(
        tx,
        this.tenantContext.tenantIdOrThrow,
        original.branchId,
        original.ingredientId,
      );
      await this.logReorderAlertEvents(reorderEvents);
      return movement;
    };

    if (opts.tx) return run(opts.tx);
    return this.prisma.scopedTransaction(run);
  }

  /**
   * The "out" leg of an inter-branch stock transfer (StockTransfersService.send).
   * Never touches Ingredient.averageCost — removing units at their existing
   * cost doesn't change the average of what remains, same reasoning as
   * recordWaste/deductForCompletedOrder. Refuses outright (ConflictException)
   * rather than driving the source location negative; the row lock on
   * stock_levels makes a concurrent sale/transfer against the same bucket
   * resolve safely instead of racing the availability check.
   */
  async recordTransferOut(
    input: { branchId: string; locationId: string; ingredientId: string; quantity: string },
    opts: { referenceType: string; referenceId: string; tx: Prisma.TransactionClient },
  ) {
    const actor = actorOrNull(this.tenantContext.contextOrThrow.userId);
    const quantityBase = Number(input.quantity);

    const locked = await opts.tx.$queryRaw<{ quantity: string }[]>`
      SELECT quantity FROM stock_levels
      WHERE location_id = ${input.locationId}::uuid AND ingredient_id = ${input.ingredientId}::uuid
      FOR UPDATE
    `;
    const availableQty = locked.length > 0 ? Number(locked[0].quantity) : 0;
    if (availableQty < quantityBase) {
      throw new ConflictException(
        `Insufficient stock to transfer: only ${availableQty} unit(s) available at the source location, ${quantityBase} requested.`,
      );
    }

    const movement = await this.createMovement(opts.tx, {
      branchId: input.branchId,
      locationId: input.locationId,
      ingredientId: input.ingredientId,
      type: "transfer_out",
      quantity: -quantityBase,
      referenceType: opts.referenceType,
      referenceId: opts.referenceId,
      performedBy: actor,
    });
    await this.upsertLevel(opts.tx, input.branchId, input.locationId, input.ingredientId, -quantityBase);

    await this.audit.log({
      action: "stock.transfer_out_recorded",
      entityType: "stock_movement",
      entityId: movement.id,
      branchId: input.branchId,
      meta: { ingredientId: input.ingredientId, quantity: input.quantity },
    });

    const gatingEvents = await this.reevaluateStockGating(
      opts.tx,
      this.tenantContext.tenantIdOrThrow,
      input.branchId,
      input.ingredientId,
    );
    await this.logGatingEvents(input.branchId, gatingEvents);
    const reorderEvents = await this.reevaluateReorderAlerts(
      opts.tx,
      this.tenantContext.tenantIdOrThrow,
      input.branchId,
      input.ingredientId,
    );
    await this.logReorderAlertEvents(reorderEvents);
    return movement;
  }

  /**
   * The "in" leg — used both for a genuine receive at the destination
   * branch AND for returning stock to the ORIGIN branch when a transfer is
   * rejected (same operation, different branch/location arguments; see
   * StockTransfersService.reject). Blends `unitCostSar` into
   * Ingredient.averageCost via the exact same weighted-average formula
   * recordPurchase uses — `unitCostSar` is normally the transfer item's
   * frozen unitCostAtSend (the ingredient's own average cost at send time),
   * so blending it back in is mathematically a no-op on the average
   * (moving already-owned inventory doesn't introduce new cost
   * information) — this is intentional, not routed around, so a future
   * change to the blend formula automatically applies here too.
   */
  async recordTransferReceipt(
    input: { branchId: string; locationId: string; ingredientId: string; quantity: string; unitCostSar: string },
    opts: { referenceType: string; referenceId: string; tx: Prisma.TransactionClient },
  ) {
    const actor = actorOrNull(this.tenantContext.contextOrThrow.userId);
    const quantityBase = Number(input.quantity);
    const ingredient = await this.ingredientOrThrow(opts.tx, input.ingredientId);

    const movement = await this.createMovement(opts.tx, {
      branchId: input.branchId,
      locationId: input.locationId,
      ingredientId: input.ingredientId,
      type: "transfer_in",
      quantity: quantityBase,
      unitCost: input.unitCostSar,
      referenceType: opts.referenceType,
      referenceId: opts.referenceId,
      performedBy: actor,
    });
    const level = await this.upsertLevel(opts.tx, input.branchId, input.locationId, input.ingredientId, quantityBase);
    const priorQty = Number(level.quantity) - quantityBase;
    await this.blendAverageCost(opts.tx, ingredient, priorQty, quantityBase, input.unitCostSar, actor);

    await this.audit.log({
      action: "stock.transfer_in_recorded",
      entityType: "stock_movement",
      entityId: movement.id,
      branchId: input.branchId,
      meta: { ingredientId: input.ingredientId, quantity: input.quantity },
    });

    const gatingEvents = await this.reevaluateStockGating(
      opts.tx,
      this.tenantContext.tenantIdOrThrow,
      input.branchId,
      input.ingredientId,
    );
    await this.logGatingEvents(input.branchId, gatingEvents);
    const reorderEvents = await this.reevaluateReorderAlerts(
      opts.tx,
      this.tenantContext.tenantIdOrThrow,
      input.branchId,
      input.ingredientId,
    );
    await this.logReorderAlertEvents(reorderEvents);
    return movement;
  }

  async recordWaste(dto: RecordWasteDto) {
    const ctx = this.tenantContext.contextOrThrow;
    const actor = actorOrNull(ctx.userId);
    const quantityBase = Number(dto.quantity);

    return this.prisma.scopedTransaction(async (tx) => {
      await this.ingredientOrThrow(tx, dto.ingredientId);
      const locationId = await this.resolveLocationId(tx, dto.branchId, dto.locationId);

      const movement = await this.createMovement(tx, {
        branchId: dto.branchId,
        locationId,
        ingredientId: dto.ingredientId,
        type: "waste",
        quantity: -quantityBase,
        reason: dto.reason,
        performedBy: actor,
      });
      await this.upsertLevel(tx, dto.branchId, locationId, dto.ingredientId, -quantityBase);

      await this.audit.log({
        action: "stock.waste_recorded",
        entityType: "stock_movement",
        entityId: movement.id,
        branchId: dto.branchId,
        meta: { ingredientId: dto.ingredientId, quantity: dto.quantity, reason: dto.reason },
      });

      const gatingEvents = await this.reevaluateStockGating(
        tx,
        this.tenantContext.tenantIdOrThrow,
        dto.branchId,
        dto.ingredientId,
      );
      await this.logGatingEvents(dto.branchId, gatingEvents);
      const reorderEvents = await this.reevaluateReorderAlerts(
        tx,
        this.tenantContext.tenantIdOrThrow,
        dto.branchId,
        dto.ingredientId,
      );
      await this.logReorderAlertEvents(reorderEvents);
      return movement;
    });
  }

  /** Reconciles the counted physical quantity — computes and records the delta. */
  async recordAdjustment(dto: RecordAdjustmentDto) {
    const ctx = this.tenantContext.contextOrThrow;
    const actor = actorOrNull(ctx.userId);
    const counted = Number(dto.countedQuantity);

    return this.prisma.scopedTransaction(async (tx) => {
      await this.ingredientOrThrow(tx, dto.ingredientId);
      const locationId = await this.resolveLocationId(tx, dto.branchId, dto.locationId);

      const existing = await tx.stockLevel.findUnique({
        where: { locationId_ingredientId: { locationId, ingredientId: dto.ingredientId } },
      });
      const current = Number(existing?.quantity ?? 0);
      const delta = counted - current;
      if (delta === 0) {
        throw new BadRequestException("Counted quantity matches the current balance — nothing to adjust");
      }

      const movement = await this.createMovement(tx, {
        branchId: dto.branchId,
        locationId,
        ingredientId: dto.ingredientId,
        type: "adjustment",
        quantity: delta,
        reason: dto.reason,
        performedBy: actor,
      });
      await this.upsertLevel(tx, dto.branchId, locationId, dto.ingredientId, delta);

      await this.audit.log({
        action: "stock.adjustment_recorded",
        entityType: "stock_movement",
        entityId: movement.id,
        branchId: dto.branchId,
        meta: {
          ingredientId: dto.ingredientId,
          countedQuantity: dto.countedQuantity,
          previousQuantity: current.toString(),
          delta: delta.toString(),
          reason: dto.reason,
        },
      });

      const gatingEvents = await this.reevaluateStockGating(
        tx,
        this.tenantContext.tenantIdOrThrow,
        dto.branchId,
        dto.ingredientId,
      );
      await this.logGatingEvents(dto.branchId, gatingEvents);
      const reorderEvents = await this.reevaluateReorderAlerts(
        tx,
        this.tenantContext.tenantIdOrThrow,
        dto.branchId,
        dto.ingredientId,
      );
      await this.logReorderAlertEvents(reorderEvents);
      return movement;
    });
  }

  /**
   * Automatic stock deduction on order completion (plan: "only if safe with
   * the order.completed event"). Safety measures:
   * - runs from an event listener, decoupled from the checkout transaction —
   *   a failure here can never roll back or block a completed sale;
   * - idempotent via the (tenant, type, referenceType, referenceId,
   *   ingredient) unique constraint — a duplicate event is a silent no-op;
   * - skips products with no recipe defined; never throws to the caller.
   */
  async deductForCompletedOrder(
    tenantId: string,
    branchId: string,
    orderId: string,
    items: CompletedOrderItem[],
  ): Promise<void> {
    // Event listeners run outside any HTTP request, so there is no ambient
    // tenant context yet — establish one (system actor) for the duration
    // of this operation so scoped queries and the audit log work normally.
    await this.tenantContext.run(
      { userId: GUEST_ACTOR, tenantId, permissions: new Set() },
      () => this.deductForCompletedOrderInContext(tenantId, branchId, orderId, items),
    );
  }

  private async deductForCompletedOrderInContext(
    tenantId: string,
    branchId: string,
    orderId: string,
    items: CompletedOrderItem[],
  ): Promise<void> {
    try {
      const alreadyDone = await this.prisma
        .forTenant(tenantId)
        .stockMovement.findFirst({
          where: { type: "sale_deduction", referenceType: "order", referenceId: orderId },
          select: { id: true },
        });
      if (alreadyDone) {
        return; // idempotent no-op — already deducted for this order
      }

      const productIds = [...new Set(items.map((item) => item.productId))];
      const recipeItems = await this.prisma.forTenant(tenantId).recipeItem.findMany({
        where: { productId: { in: productIds } },
        include: { unit: true },
      });
      if (recipeItems.length === 0) {
        return; // none of the sold products have a recipe — nothing to deduct
      }

      const { events: gatingEvents, reorderEvents } = await this.prisma.scopedTransaction(async (tx) => {
        const locationId = (await this.locations.getOrCreateDefault(branchId, tx)).id;
        const touchedIngredientIds = new Set<string>();

        for (const item of items) {
          const lines = recipeItems.filter((line) => line.productId === item.productId);
          for (const line of lines) {
            const quantityBase = Number(line.quantity) * Number(line.unit.toBaseFactor) * item.quantity;
            await this.createMovement(tx, {
              branchId,
              locationId,
              ingredientId: line.ingredientId,
              type: "sale_deduction",
              quantity: -quantityBase,
              referenceType: "order",
              referenceId: orderId,
              performedBy: null,
            });
            await this.upsertLevel(tx, branchId, locationId, line.ingredientId, -quantityBase);
            touchedIngredientIds.add(line.ingredientId);
          }
        }

        const events: StockGatingEvent[] = [];
        const reorderEvents: ReorderAlertEvent[] = [];
        for (const ingredientId of touchedIngredientIds) {
          events.push(...(await this.reevaluateStockGating(tx, tenantId, branchId, ingredientId)));
          reorderEvents.push(...(await this.reevaluateReorderAlerts(tx, tenantId, branchId, ingredientId)));
        }
        return { events, reorderEvents };
      }, tenantId);
      await this.logGatingEvents(branchId, gatingEvents);
      await this.logReorderAlertEvents(reorderEvents);
    } catch (error) {
      // Non-blocking by design: inventory failures must never affect an
      // already-completed order. Surface loudly in logs for operators.
      this.logger.error(
        `Stock deduction failed for order ${orderId}: ${(error as Error).message}`,
      );
    }
  }

  // --------------------------------------------------------------------- //

  /** Public: StockTransfersService validates ingredients and reads averageCost within its own transaction. */
  async ingredientOrThrow(tx: Prisma.TransactionClient, id: string) {
    const ingredient = await tx.ingredient.findFirst({ where: { id, deletedAt: null } });
    if (!ingredient) {
      throw new NotFoundException("Ingredient not found");
    }
    return ingredient;
  }

  /** Public: StockTransfersService resolves the from/to location the same way every other stock op does. */
  async resolveLocationId(
    tx: Prisma.TransactionClient,
    branchId: string,
    locationId?: string,
  ): Promise<string> {
    if (!locationId) {
      return (await this.locations.getOrCreateDefault(branchId, tx)).id;
    }
    const location = await tx.stockLocation.findFirst({
      where: { id: locationId, branchId, deletedAt: null },
    });
    if (!location) {
      throw new NotFoundException("Stock location not found in this branch");
    }
    return location.id;
  }

  /**
   * Weighted moving average: (priorQty*priorCost + incomingQty*incomingCost)
   * / (priorQty+incomingQty). The ONE place this math lives — recordPurchase
   * and recordTransferReceipt both call this rather than each keeping their
   * own copy, so a future change to the formula can't drift between them.
   */
  private async blendAverageCost(
    tx: Prisma.TransactionClient,
    ingredient: { id: string; averageCost: { toString(): string } },
    priorQty: number,
    incomingQty: number,
    incomingUnitCostSar: string,
    actor: string | null,
  ): Promise<void> {
    const priorCostUnits = sarToCostUnits(ingredient.averageCost.toString());
    const newCostUnits = sarToCostUnits(incomingUnitCostSar);
    const blendedUnits =
      priorQty > 0
        ? Math.round((priorQty * priorCostUnits + incomingQty * newCostUnits) / (priorQty + incomingQty))
        : newCostUnits;

    await tx.ingredient.update({
      where: { id: ingredient.id },
      data: { averageCost: costUnitsToSar(blendedUnits), updatedBy: actor },
    });
  }

  private async createMovement(
    tx: Prisma.TransactionClient,
    input: {
      branchId: string;
      locationId: string;
      ingredientId: string;
      type:
        | "purchase"
        | "waste"
        | "adjustment"
        | "sale_deduction"
        | "transfer_in"
        | "transfer_out"
        | "purchase_reversal";
      quantity: number;
      unitCost?: string;
      referenceType?: string;
      referenceId?: string;
      reason?: string;
      performedBy: string | null;
    },
  ) {
    try {
      return await tx.stockMovement.create({
        data: {
          tenantId: this.tenantContext.tenantIdOrThrow,
          branchId: input.branchId,
          locationId: input.locationId,
          ingredientId: input.ingredientId,
          type: input.type,
          quantity: input.quantity.toFixed(3),
          unitCost: input.unitCost,
          referenceType: input.referenceType,
          referenceId: input.referenceId,
          reason: input.reason,
          performedBy: input.performedBy,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException("This stock movement was already recorded");
      }
      throw error;
    }
  }

  private async upsertLevel(
    tx: Prisma.TransactionClient,
    branchId: string,
    locationId: string,
    ingredientId: string,
    delta: number,
  ) {
    return tx.stockLevel.upsert({
      where: { locationId_ingredientId: { locationId, ingredientId } },
      create: {
        tenantId: this.tenantContext.tenantIdOrThrow,
        branchId,
        locationId,
        ingredientId,
        quantity: delta.toFixed(3),
      },
      update: { quantity: { increment: delta.toFixed(3) } },
    });
  }

  // --- Automatic "86'd item" gating (critical-ingredient stockout) ------ //

  /**
   * Re-checks every product whose recipe marks `ingredientId` as critical
   * against this branch's CURRENT total stock (summed across every stock
   * location at the branch — a merchant may run more than one), and flips
   * ProductBranchSetting.isAvailable — the exact same flag POS order
   * creation and the digital menu already gate on — accordingly:
   *
   * - stock <= threshold and not already system-hidden → hide it, and
   *   record a ProductStockHide row so a later restock knows to undo this
   *   exact hide (never restocked by state we didn't create — see below);
   * - stock > threshold and a ProductStockHide row exists → show it again
   *   and delete the row.
   *
   * A product the merchant already hid manually (no ProductStockHide row,
   * isAvailable already false) is left alone — this system only ever
   * touches availability it itself is tracking, so a merchant's own manual
   * hide is never silently overwritten, and a manual re-enable (see
   * ProductsService.setBranchSetting) always wins immediately.
   *
   * Must run inside the SAME transaction as the stock movement that
   * triggered it, so the hide/show decision is always consistent with the
   * quantity actually committed. Returns the decisions made so the caller
   * can audit-log them (see logGatingEvents) — this method itself never
   * calls the audit service, since AuditService writes on ITS OWN prisma
   * connection, never through `tx`, and would otherwise land outside this
   * transaction's atomicity.
   */
  private async reevaluateStockGating(
    tx: Prisma.TransactionClient,
    tenantId: string,
    branchId: string,
    ingredientId: string,
  ): Promise<StockGatingEvent[]> {
    const criticalLinks = await tx.recipeItem.findMany({
      where: { ingredientId, isCritical: true },
      select: { productId: true, criticalThreshold: true },
    });
    if (criticalLinks.length === 0) {
      return [];
    }

    const levels = await tx.stockLevel.findMany({
      where: { branchId, ingredientId },
      select: { quantity: true },
    });
    const totalQty = levels.reduce((sum, level) => sum + Number(level.quantity), 0);

    const events: StockGatingEvent[] = [];
    for (const link of criticalLinks) {
      const threshold = link.criticalThreshold ? Number(link.criticalThreshold) : 0;
      const belowThreshold = totalQty <= threshold;

      const existingHide = await tx.productStockHide.findUnique({
        where: { productId_branchId: { productId: link.productId, branchId } },
      });

      if (belowThreshold && !existingHide) {
        const setting = await tx.productBranchSetting.findUnique({
          where: { productId_branchId: { productId: link.productId, branchId } },
        });
        if (setting && !setting.isAvailable) {
          continue; // already hidden by the merchant themselves — not ours to track
        }

        await tx.productBranchSetting.upsert({
          where: { productId_branchId: { productId: link.productId, branchId } },
          create: { tenantId, productId: link.productId, branchId, isAvailable: false },
          update: { isAvailable: false },
        });
        await tx.productStockHide.create({
          data: { tenantId, productId: link.productId, branchId, ingredientId },
        });
        events.push({ action: "hidden", productId: link.productId, branchId, ingredientId });
      } else if (!belowThreshold && existingHide) {
        await tx.productBranchSetting.update({
          where: { productId_branchId: { productId: link.productId, branchId } },
          data: { isAvailable: true },
        });
        await tx.productStockHide.delete({ where: { id: existingHide.id } });
        events.push({ action: "shown", productId: link.productId, branchId, ingredientId });
      }
    }
    return events;
  }

  private async logGatingEvents(branchId: string, events: StockGatingEvent[]): Promise<void> {
    for (const event of events) {
      await this.audit.log({
        action: event.action === "hidden" ? "product.auto_hidden_stockout" : "product.auto_shown_restocked",
        entityType: "product",
        entityId: event.productId,
        branchId,
        meta: { ingredientId: event.ingredientId },
      });
    }
  }

  /**
   * Reorder-alert crossing detector — same shape and call sites as
   * reevaluateStockGating (right beside every call to it), but comparing
   * this branch's TOTAL on-hand quantity of the ingredient (summed across
   * every stock location, same aggregation reevaluateStockGating already
   * uses for its own threshold) against Ingredient.reorderLevel instead of
   * a per-recipe criticalThreshold.
   *
   * IngredientReorderAlert is the "already notified" state: created the
   * moment the total first reaches/drops below reorderLevel (an "entered"
   * event — the ONLY case the caller should act on), deleted the moment it
   * rises back above (a "cleared" event, audit-logged but never
   * re-notified on its own — the next entry starts a fresh notification).
   * A row already existing when the total is still at/below the threshold
   * is a no-op — this is exactly the "don't repeat while still low" rule.
   *
   * Ingredients with no reorderLevel set skip entirely, same as
   * reevaluateStockGating skips ingredients with no critical recipe links.
   */
  private async reevaluateReorderAlerts(
    tx: Prisma.TransactionClient,
    tenantId: string,
    branchId: string,
    ingredientId: string,
  ): Promise<ReorderAlertEvent[]> {
    const ingredient = await tx.ingredient.findFirst({
      where: { id: ingredientId },
      select: { reorderLevel: true },
    });
    if (!ingredient?.reorderLevel) {
      return [];
    }

    const levels = await tx.stockLevel.findMany({
      where: { branchId, ingredientId },
      select: { quantity: true },
    });
    const totalQty = levels.reduce((sum, level) => sum + Number(level.quantity), 0);
    const reorderLevel = Number(ingredient.reorderLevel);
    const atOrBelow = totalQty <= reorderLevel;
    const reorderLevelStr = ingredient.reorderLevel.toString();

    const existingAlert = await tx.ingredientReorderAlert.findUnique({
      where: { branchId_ingredientId: { branchId, ingredientId } },
    });

    if (atOrBelow && !existingAlert) {
      await tx.ingredientReorderAlert.create({ data: { tenantId, branchId, ingredientId } });
      return [
        { action: "entered", ingredientId, branchId, currentQuantity: totalQty.toFixed(3), reorderLevel: reorderLevelStr },
      ];
    }
    if (!atOrBelow && existingAlert) {
      await tx.ingredientReorderAlert.delete({ where: { id: existingAlert.id } });
      return [
        { action: "cleared", ingredientId, branchId, currentQuantity: totalQty.toFixed(3), reorderLevel: reorderLevelStr },
      ];
    }
    return [];
  }

  /**
   * Audits every reorder-alert transition, and — for "entered" only — emits
   * INGREDIENT_REORDER_ALERT so a decoupled WhatsApp listener (integrations
   * module) can notify the tenant's registered number, gated by its own
   * per-tenant toggle and template-approval state. "cleared" is audited but
   * never re-notified on its own; the next crossing starts a fresh alert.
   */
  private async logReorderAlertEvents(events: ReorderAlertEvent[]): Promise<void> {
    const tenantId = this.tenantContext.tenantIdOrThrow;
    for (const event of events) {
      await this.audit.log({
        action: event.action === "entered" ? "ingredient.reorder_alert_triggered" : "ingredient.reorder_alert_cleared",
        entityType: "ingredient",
        entityId: event.ingredientId,
        branchId: event.branchId,
        meta: { currentQuantity: event.currentQuantity, reorderLevel: event.reorderLevel },
      });
      if (event.action === "entered") {
        this.events.emit(DOMAIN_EVENTS.INGREDIENT_REORDER_ALERT, {
          tenantId,
          branchId: event.branchId,
          ingredientId: event.ingredientId,
          currentQuantity: event.currentQuantity,
          reorderLevel: event.reorderLevel,
        });
      }
    }
  }

  /**
   * Called after a recipe update changes which ingredients are marked
   * critical for a product (RecipesService.set). Ingredients newly (or
   * still) critical are re-checked against real stock right away — marking
   * an already-out-of-stock ingredient critical hides the product
   * immediately, without waiting for the next stock movement. Ingredients
   * no longer critical release any hide this system was tracking for them,
   * across every branch, so a merchant unchecking "critical" never leaves a
   * product stuck invisible.
   */
  async onRecipeCriticalLinksChanged(
    productId: string,
    criticalIngredientIds: string[],
    droppedCriticalIngredientIds: string[],
  ): Promise<void> {
    if (criticalIngredientIds.length === 0 && droppedCriticalIngredientIds.length === 0) {
      return;
    }
    const tenantId = this.tenantContext.tenantIdOrThrow;
    const branches = await this.prisma.scoped.branch.findMany({
      where: { deletedAt: null },
      select: { id: true },
    });

    const gatingEvents = await this.prisma.scopedTransaction(async (tx) => {
      const events: StockGatingEvent[] = [];
      for (const branch of branches) {
        for (const ingredientId of criticalIngredientIds) {
          events.push(...(await this.reevaluateStockGating(tx, tenantId, branch.id, ingredientId)));
        }
        for (const ingredientId of droppedCriticalIngredientIds) {
          const hide = await tx.productStockHide.findUnique({
            where: { productId_branchId: { productId, branchId: branch.id } },
          });
          if (hide && hide.ingredientId === ingredientId) {
            await tx.productBranchSetting.update({
              where: { productId_branchId: { productId, branchId: branch.id } },
              data: { isAvailable: true },
            });
            await tx.productStockHide.delete({ where: { id: hide.id } });
            events.push({ action: "shown", productId, branchId: branch.id, ingredientId });
          }
        }
      }
      return events;
    });

    for (const event of gatingEvents) {
      await this.logGatingEvents(event.branchId, [event]);
    }
  }

  /** Products currently auto-hidden by the stockout engine — dashboard alert list. */
  listAutoHidden(branchId?: string) {
    return this.prisma.scoped.productStockHide.findMany({
      where: { ...(branchId ? { branchId } : {}) },
      include: {
        product: { select: { id: true, name: true, nameEn: true } },
        branch: { select: { id: true, name: true, nameEn: true } },
        ingredient: { select: { id: true, name: true, nameEn: true } },
      },
      orderBy: { hiddenAt: "desc" },
    });
  }
}
