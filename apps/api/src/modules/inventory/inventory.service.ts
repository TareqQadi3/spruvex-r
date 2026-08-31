import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";

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

@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditService,
    private readonly locations: StockLocationsService,
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
      const priorCostUnits = sarToCostUnits(ingredient.averageCost.toString());
      const newCostUnits = sarToCostUnits(dto.unitCost);
      const blendedUnits =
        priorQty > 0
          ? Math.round((priorQty * priorCostUnits + quantityBase * newCostUnits) / (priorQty + quantityBase))
          : newCostUnits;

      await tx.ingredient.update({
        where: { id: dto.ingredientId },
        data: { averageCost: costUnitsToSar(blendedUnits), updatedBy: actor },
      });

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
      return movement;
    };

    if (opts.tx) return run(opts.tx);
    return this.prisma.scopedTransaction(run);
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

      const gatingEvents = await this.prisma.scopedTransaction(async (tx) => {
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
        for (const ingredientId of touchedIngredientIds) {
          events.push(...(await this.reevaluateStockGating(tx, tenantId, branchId, ingredientId)));
        }
        return events;
      }, tenantId);
      await this.logGatingEvents(branchId, gatingEvents);
    } catch (error) {
      // Non-blocking by design: inventory failures must never affect an
      // already-completed order. Surface loudly in logs for operators.
      this.logger.error(
        `Stock deduction failed for order ${orderId}: ${(error as Error).message}`,
      );
    }
  }

  // --------------------------------------------------------------------- //

  private async ingredientOrThrow(tx: Prisma.TransactionClient, id: string) {
    const ingredient = await tx.ingredient.findFirst({ where: { id, deletedAt: null } });
    if (!ingredient) {
      throw new NotFoundException("Ingredient not found");
    }
    return ingredient;
  }

  private async resolveLocationId(
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

  private async createMovement(
    tx: Prisma.TransactionClient,
    input: {
      branchId: string;
      locationId: string;
      ingredientId: string;
      type: "purchase" | "waste" | "adjustment" | "sale_deduction" | "transfer_in" | "transfer_out";
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
