import { Injectable } from "@nestjs/common";

import { AuditService } from "../../shared/audit/audit.service";
import { PrismaService } from "../../shared/prisma/prisma.service";
import { TenantContextService } from "../../shared/tenancy/tenant-context.service";
import { UpdateReorderAlertSettingsDto } from "./dto/reorder-alert-settings.dto";

export interface ReorderAlertSupplier {
  id: string;
  name: string;
  nameEn: string | null;
  /** Net unit price (base unit, SAR) on that most recent CONFIRMED purchase invoice line. */
  lastUnitPrice: string;
  lastPurchasedAt: string;
}

export interface ReorderAlertRow {
  ingredientId: string;
  ingredientName: string;
  ingredientNameEn: string | null;
  unitType: string;
  branchId: string;
  branchName: string;
  branchNameEn: string | null;
  locationId: string;
  locationName: string;
  locationNameEn: string | null;
  currentQuantity: string;
  reorderLevel: string;
  /** max(reorderLevel - currentQuantity, 0), in the ingredient's base unit — the starting point for a reorder line, still editable. */
  suggestedQuantity: string;
  /** Extracted from existing purchase-invoice history for this ingredient (most recent CONFIRMED invoice, tenant-wide) — null if never purchased that way. */
  lastSupplier: ReorderAlertSupplier | null;
}

/**
 * Reorder alerts — every stock level at or below its ingredient's
 * reorderLevel (the same field IngredientsPage already lets a merchant set;
 * no new threshold was added for this feature), most critical first.
 *
 * "Most critical" is judged RELATIVELY (currentQuantity / reorderLevel,
 * ascending) rather than by absolute deficit — a 1kg-into-a-20kg threshold
 * item is a more urgent stockout risk than a 9kg-into-a-10kg one, even
 * though the second has a smaller absolute number. Both a bare quantity
 * comparison AND this ratio are still available on each row, so a caller
 * doesn't have to trust the server's chosen order.
 *
 * Deliberately scoped: this compares a live balance against a merchant-set
 * FIXED threshold only — no consumption-rate estimate, no "days remaining"
 * forecast. Each row already exposes everything an average-consumption-rate
 * feature would need (currentQuantity, reorderLevel, ingredientId) to add
 * an `estimatedDaysRemaining` field later without restructuring this
 * endpoint or its row shape.
 */
@Injectable()
export class ReorderAlertsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------ //
  // WhatsApp notification settings — same Tenant.settings JSON-blob
  // convention FeedbackService already uses for feedbackDelayMinutes,
  // rather than a new dedicated settings table/columns.
  // ------------------------------------------------------------------ //

  async getWhatsappSettings() {
    const tenant = await this.prisma.scoped.tenant.findFirst({
      where: { deletedAt: null },
      select: { settings: true, contactPhone: true },
    });
    const settings = (tenant?.settings ?? {}) as { reorderAlertsWhatsappEnabled?: boolean };
    return {
      // Off by default — an existing tenant must opt in, never surprised by a message it never asked for.
      whatsappEnabled: settings.reorderAlertsWhatsappEnabled ?? false,
      // The number a "true" here will actually notify — Tenant.contactPhone,
      // the restaurant's own registered contact number (see IngredientReorderAlert's
      // doc comment on why this field, not a new one, was reused).
      recipientPhone: tenant?.contactPhone ?? null,
    };
  }

  async updateWhatsappSettings(dto: UpdateReorderAlertSettingsDto) {
    const ctx = this.tenantContext.contextOrThrow;
    const tenant = await this.prisma.scoped.tenant.findFirst({
      where: { deletedAt: null },
      select: { settings: true },
    });
    const current = (tenant?.settings ?? {}) as Record<string, unknown>;
    await this.prisma.scoped.tenant.update({
      where: { id: this.tenantContext.tenantIdOrThrow },
      data: {
        settings: { ...current, reorderAlertsWhatsappEnabled: dto.whatsappEnabled },
        updatedBy: ctx.userId,
      },
    });
    await this.audit.log({
      action: "tenant.settings_updated",
      entityType: "tenant",
      meta: { reorderAlertsWhatsappEnabled: dto.whatsappEnabled },
    });
    return this.getWhatsappSettings();
  }

  async list(branchId: string | undefined): Promise<ReorderAlertRow[]> {
    const levels = await this.prisma.scoped.stockLevel.findMany({
      where: {
        ...(branchId ? { branchId } : {}),
        ingredient: { reorderLevel: { not: null }, deletedAt: null, isActive: true },
      },
      include: {
        ingredient: { select: { id: true, name: true, nameEn: true, unitType: true, reorderLevel: true } },
        branch: { select: { id: true, name: true, nameEn: true } },
        location: { select: { id: true, name: true, nameEn: true } },
      },
    });

    const critical = levels.filter((level) => Number(level.quantity) <= Number(level.ingredient.reorderLevel));
    if (critical.length === 0) {
      return [];
    }

    const ingredientIds = [...new Set(critical.map((level) => level.ingredientId))];
    const purchaseHistory = await this.prisma.scoped.purchaseInvoiceItem.findMany({
      where: {
        ingredientId: { in: ingredientIds },
        purchaseInvoice: { status: "confirmed" },
      },
      select: {
        ingredientId: true,
        unitPrice: true,
        purchaseInvoice: {
          select: {
            invoiceDate: true,
            supplier: { select: { id: true, name: true, nameEn: true } },
          },
        },
      },
      orderBy: { purchaseInvoice: { invoiceDate: "desc" } },
    });

    // Results are already ordered newest-first, so the first hit per
    // ingredient is its most recent CONFIRMED purchase — no further sorting needed.
    const lastSupplierByIngredient = new Map<string, ReorderAlertSupplier>();
    for (const item of purchaseHistory) {
      if (lastSupplierByIngredient.has(item.ingredientId!)) continue;
      lastSupplierByIngredient.set(item.ingredientId!, {
        id: item.purchaseInvoice.supplier.id,
        name: item.purchaseInvoice.supplier.name,
        nameEn: item.purchaseInvoice.supplier.nameEn,
        lastUnitPrice: item.unitPrice.toString(),
        lastPurchasedAt: item.purchaseInvoice.invoiceDate.toISOString().slice(0, 10),
      });
    }

    const rows: ReorderAlertRow[] = critical.map((level) => {
      const quantity = Number(level.quantity);
      const reorderLevel = Number(level.ingredient.reorderLevel);
      const deficit = reorderLevel - quantity;
      return {
        ingredientId: level.ingredient.id,
        ingredientName: level.ingredient.name,
        ingredientNameEn: level.ingredient.nameEn,
        unitType: level.ingredient.unitType,
        branchId: level.branch.id,
        branchName: level.branch.name,
        branchNameEn: level.branch.nameEn,
        locationId: level.location.id,
        locationName: level.location.name,
        locationNameEn: level.location.nameEn,
        currentQuantity: level.quantity.toString(),
        reorderLevel: level.ingredient.reorderLevel!.toString(),
        suggestedQuantity: (deficit > 0 ? deficit : 0).toFixed(3),
        lastSupplier: lastSupplierByIngredient.get(level.ingredientId) ?? null,
      };
    });

    rows.sort((a, b) => criticalityRatio(a) - criticalityRatio(b));
    return rows;
  }
}

/** currentQuantity / reorderLevel — 0 (maximally critical) when reorderLevel is itself 0. */
function criticalityRatio(row: ReorderAlertRow): number {
  const reorderLevel = Number(row.reorderLevel);
  if (reorderLevel <= 0) return 0;
  return Number(row.currentQuantity) / reorderLevel;
}
