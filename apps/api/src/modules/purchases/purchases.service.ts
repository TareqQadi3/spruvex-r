import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { AuditService } from "../../shared/audit/audit.service";
import { halalasToSar, sarToHalalas } from "../../shared/common/money";
import { InventoryService } from "../inventory/inventory.service";
import { PrismaService } from "../../shared/prisma/prisma.service";
import { actorOrNull, TenantContextService } from "../../shared/tenancy/tenant-context.service";
import { PrivateFileCategory, UploadsService } from "../uploads/uploads.service";
import {
  CancelPurchaseInvoiceDto,
  CreatePurchaseInvoiceDto,
  ListPurchaseInvoicesQueryDto,
  PurchaseInvoiceItemDto,
  UpdatePurchaseSettingsDto,
} from "./dto/purchases.dto";

/** Absolute last resort when neither settings.defaultPurchaseVatRate nor the
 * tenant's own vatRate is set — the actual rate applied always comes from
 * settings/the line item, never this constant (same reasoning as
 * OrderingService's DEFAULT_MAX_DISCOUNT_PERCENT). */
const FALLBACK_VAT_RATE_PERCENT = "15";

const ATTACHMENT_CATEGORY: PrivateFileCategory = "purchase-invoices";

const INVOICE_INCLUDE = {
  supplier: { select: { id: true, name: true, nameEn: true, vatNumber: true } },
  items: { orderBy: { createdAt: "asc" } },
} satisfies Prisma.PurchaseInvoiceInclude;

interface LinePricing {
  quantity: number;
  unitPriceHalalas: number;
  vatRatePercent: string;
  lineSubtotalHalalas: number;
  lineVatHalalas: number;
  lineTotalHalalas: number;
}

@Injectable()
export class PurchasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditService,
    private readonly inventory: InventoryService,
    private readonly uploads: UploadsService,
  ) {}

  // ------------------------------------------------------------------ //
  // Settings — the per-tenant default VAT rate pre-filled on new lines.
  // ------------------------------------------------------------------ //

  async getSettings() {
    const tenant = await this.prisma.scoped.tenant.findFirst({
      where: { deletedAt: null },
      select: { settings: true, vatRate: true },
    });
    const settings = (tenant?.settings ?? {}) as { defaultPurchaseVatRate?: string };
    return {
      defaultPurchaseVatRate:
        settings.defaultPurchaseVatRate ?? tenant?.vatRate?.toString() ?? FALLBACK_VAT_RATE_PERCENT,
    };
  }

  async updateSettings(dto: UpdatePurchaseSettingsDto) {
    const ctx = this.tenantContext.contextOrThrow;
    const tenant = await this.prisma.scoped.tenant.findFirst({
      where: { deletedAt: null },
      select: { settings: true },
    });
    const current = (tenant?.settings ?? {}) as Record<string, unknown>;
    await this.prisma.scoped.tenant.update({
      where: { id: this.tenantContext.tenantIdOrThrow },
      data: {
        settings: { ...current, defaultPurchaseVatRate: dto.defaultPurchaseVatRate },
        updatedBy: ctx.userId,
      },
    });
    await this.audit.log({
      action: "purchases.settings_updated",
      entityType: "tenant",
      meta: { defaultPurchaseVatRate: dto.defaultPurchaseVatRate },
    });
    return this.getSettings();
  }

  // ------------------------------------------------------------------ //
  // Purchase invoices
  // ------------------------------------------------------------------ //

  list(query: ListPurchaseInvoicesQueryDto) {
    return this.prisma.scoped.purchaseInvoice.findMany({
      where: {
        deletedAt: null,
        ...(query.branchId ? { branchId: query.branchId } : {}),
        ...(query.supplierId ? { supplierId: query.supplierId } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.from || query.to
          ? {
              invoiceDate: {
                ...(query.from ? { gte: new Date(query.from) } : {}),
                ...(query.to ? { lte: new Date(query.to) } : {}),
              },
            }
          : {}),
      },
      include: { supplier: { select: { id: true, name: true, nameEn: true } } },
      orderBy: { invoiceDate: "desc" },
    });
  }

  async get(id: string) {
    const invoice = await this.prisma.scoped.purchaseInvoice.findFirst({
      where: { id, deletedAt: null },
      include: {
        ...INVOICE_INCLUDE,
        reversals: {
          orderBy: { createdAt: "asc" },
          include: { items: { orderBy: { createdAt: "asc" } } },
        },
      },
    });
    if (!invoice) {
      throw new NotFoundException("Purchase invoice not found");
    }
    if (invoice.reversals.length === 0) {
      return invoice;
    }

    // Resolve each reversal item's resulting StockMovement/Expense for
    // traceability — same referenceType/referenceId lookup convention used
    // throughout, not a duplicate FK column.
    const reversalItemIds = invoice.reversals.flatMap((r) => r.items.map((i) => i.id));
    const [movements, expenses] = await Promise.all([
      this.prisma.scoped.stockMovement.findMany({
        where: { referenceType: "purchase_invoice_reversal_item", referenceId: { in: reversalItemIds } },
        select: { id: true, referenceId: true, quantity: true, unitCost: true },
      }),
      this.prisma.scoped.expense.findMany({
        where: { referenceType: "purchase_invoice_reversal_item", referenceId: { in: reversalItemIds } },
        select: { id: true, referenceId: true, amount: true, vatAmount: true, total: true },
      }),
    ]);
    const movementByRefId = new Map(movements.map((m) => [m.referenceId, m]));
    const expenseByRefId = new Map(expenses.map((e) => [e.referenceId, e]));

    return {
      ...invoice,
      reversals: invoice.reversals.map((r) => ({
        ...r,
        items: r.items.map((ri) => ({
          ...ri,
          stockMovement: movementByRefId.get(ri.id) ?? null,
          expense: expenseByRefId.get(ri.id) ?? null,
        })),
      })),
    };
  }

  async create(dto: CreatePurchaseInvoiceDto) {
    const ctx = this.tenantContext.contextOrThrow;
    const tenantId = this.tenantContext.tenantIdOrThrow;
    const actor = actorOrNull(ctx.userId);
    const settings = await this.getSettings();

    const supplier = await this.prisma.scoped.supplier.findFirst({
      where: { id: dto.supplierId, deletedAt: null },
    });
    if (!supplier) {
      throw new NotFoundException("Supplier not found");
    }
    const branch = await this.prisma.scoped.branch.findFirst({
      where: { id: dto.branchId, deletedAt: null },
    });
    if (!branch) {
      throw new NotFoundException("Branch not found");
    }

    const stockIngredientIds = [
      ...new Set(dto.items.filter((i) => i.itemType === "stock").map((i) => i.ingredientId!)),
    ];
    if (stockIngredientIds.length > 0) {
      const found = await this.prisma.scoped.ingredient.findMany({
        where: { id: { in: stockIngredientIds }, deletedAt: null },
        select: { id: true },
      });
      if (found.length !== stockIngredientIds.length) {
        throw new NotFoundException("One or more ingredients were not found");
      }
    }

    const priced = dto.items.map((item) => priceLine(item, settings.defaultPurchaseVatRate));
    const subtotalHalalas = priced.reduce((sum, p) => sum + p.lineSubtotalHalalas, 0);
    const vatHalalas = priced.reduce((sum, p) => sum + p.lineVatHalalas, 0);
    const totalHalalas = subtotalHalalas + vatHalalas;

    let invoice;
    try {
      invoice = await this.prisma.scopedTransaction(async (tx) => {
        const created = await tx.purchaseInvoice.create({
          data: {
            tenantId,
            branchId: dto.branchId,
            supplierId: dto.supplierId,
            supplierInvoiceNumber: dto.supplierInvoiceNumber,
            invoiceDate: new Date(dto.invoiceDate),
            notes: dto.notes,
            subtotal: halalasToSar(subtotalHalalas),
            vatAmount: halalasToSar(vatHalalas),
            total: halalasToSar(totalHalalas),
            createdBy: actor,
            items: {
              create: dto.items.map((item, index) => ({
                tenantId,
                description: item.description,
                itemType: item.itemType,
                quantity: item.quantity,
                unitPrice: item.unitPrice,
                vatRatePercent: priced[index].vatRatePercent,
                lineSubtotal: halalasToSar(priced[index].lineSubtotalHalalas),
                lineVat: halalasToSar(priced[index].lineVatHalalas),
                lineTotal: halalasToSar(priced[index].lineTotalHalalas),
                ingredientId: item.itemType === "stock" ? item.ingredientId : null,
                locationId: item.itemType === "stock" ? item.locationId : null,
                expenseCategory: item.itemType === "expense" ? item.expenseCategory : null,
              })),
            },
          },
          include: INVOICE_INCLUDE,
        });
        return created;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException(
          `Supplier invoice ${dto.supplierInvoiceNumber} was already entered for this supplier`,
        );
      }
      throw error;
    }

    await this.audit.log({
      action: "purchase_invoice.created",
      entityType: "purchase_invoice",
      entityId: invoice.id,
      branchId: invoice.branchId,
      meta: { supplierInvoiceNumber: dto.supplierInvoiceNumber, total: invoice.total.toString() },
    });

    if (dto.confirm) {
      return this.confirm(invoice.id);
    }
    return invoice;
  }

  /**
   * Posts every line to the SAME real ledgers everything else uses — stock
   * lines through InventoryService.recordPurchase (updates the moving
   * average cost, not a separate number), expense lines as a real Expense
   * row — inside ONE transaction with the status flip, so a failure never
   * leaves stock/expenses posted for an invoice that didn't actually
   * confirm. The row lock also makes a double-confirm race resolve to a
   * clean 409 on the loser rather than double-posting.
   */
  async confirm(id: string) {
    const ctx = this.tenantContext.contextOrThrow;
    const tenantId = this.tenantContext.tenantIdOrThrow;
    const actor = actorOrNull(ctx.userId);

    const invoice = await this.prisma.scopedTransaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM purchase_invoices WHERE id = ${id}::uuid FOR UPDATE
      `;
      if (locked.length === 0) {
        throw new NotFoundException("Purchase invoice not found");
      }
      const current = await tx.purchaseInvoice.findFirst({
        where: { id, deletedAt: null },
        include: { items: true },
      });
      if (!current) {
        throw new NotFoundException("Purchase invoice not found");
      }
      if (current.status !== "draft") {
        throw new ConflictException(`Invoice is already ${current.status}`);
      }

      for (const item of current.items) {
        if (item.itemType === "stock") {
          if (!item.ingredientId) {
            throw new BadRequestException(`Stock line ${item.id} is missing its ingredient`);
          }
          await this.inventory.recordPurchase(
            {
              branchId: current.branchId,
              ingredientId: item.ingredientId,
              locationId: item.locationId ?? undefined,
              quantity: item.quantity.toString(),
              unitCost: item.unitPrice.toString(),
              reason: `Purchase invoice ${current.supplierInvoiceNumber} — ${item.description}`,
            },
            { referenceType: "purchase_invoice_item", referenceId: item.id, tx },
          );
        } else {
          await tx.expense.create({
            data: {
              tenantId,
              branchId: current.branchId,
              category: item.expenseCategory,
              description: item.description,
              amount: item.lineSubtotal,
              vatAmount: item.lineVat,
              total: item.lineTotal,
              incurredAt: current.invoiceDate,
              referenceType: "purchase_invoice_item",
              referenceId: item.id,
              createdBy: actor,
            },
          });
        }
      }

      return tx.purchaseInvoice.update({
        where: { id },
        data: { status: "confirmed", confirmedAt: new Date(), confirmedBy: actor, updatedBy: actor },
        include: INVOICE_INCLUDE,
      });
    });

    await this.audit.log({
      action: "purchase_invoice.confirmed",
      entityType: "purchase_invoice",
      entityId: invoice.id,
      branchId: invoice.branchId,
      meta: { supplierInvoiceNumber: invoice.supplierInvoiceNumber, total: invoice.total.toString() },
    });
    return invoice;
  }

  /**
   * Cancelling a DRAFT is a true no-op (nothing was ever posted). Cancelling
   * an already-CONFIRMED invoice posts a full PurchaseInvoiceReversal first
   * (see reverseConfirmedInvoice) — the stock received and the expense
   * posted are both actually undone, not just excluded from a future VAT
   * return. Row-locked exactly like confirm(), so a racing or repeated
   * cancel on the same invoice resolves to one success and a clean 409,
   * never a double reversal.
   */
  async cancel(id: string, dto: CancelPurchaseInvoiceDto) {
    const ctx = this.tenantContext.contextOrThrow;
    const tenantId = this.tenantContext.tenantIdOrThrow;
    const actor = actorOrNull(ctx.userId);

    const invoice = await this.prisma.scopedTransaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM purchase_invoices WHERE id = ${id}::uuid FOR UPDATE
      `;
      if (locked.length === 0) {
        throw new NotFoundException("Purchase invoice not found");
      }
      const current = await tx.purchaseInvoice.findFirst({
        where: { id, deletedAt: null },
        include: { items: true },
      });
      if (!current) {
        throw new NotFoundException("Purchase invoice not found");
      }
      if (current.status === "cancelled") {
        throw new ConflictException("Invoice is already cancelled");
      }

      if (current.status === "confirmed") {
        await this.reverseConfirmedInvoice(tx, tenantId, actor, current, dto.reason);
      }

      return tx.purchaseInvoice.update({
        where: { id },
        data: {
          status: "cancelled",
          cancelledAt: new Date(),
          cancelledBy: actor,
          cancelReason: dto.reason,
          updatedBy: actor,
        },
        include: INVOICE_INCLUDE,
      });
    });

    await this.audit.log({
      action: "purchase_invoice.cancelled",
      entityType: "purchase_invoice",
      entityId: invoice.id,
      branchId: invoice.branchId,
      meta: { reason: dto.reason, wasConfirmed: invoice.confirmedAt !== null },
    });
    return invoice;
  }

  /**
   * Posts one PurchaseInvoiceReversal undoing every item's FULL quantity —
   * the general mechanism (see the model's schema doc comment) a future
   * partial supplier-credit-note feature can reuse by posting a lesser
   * quantity per item instead of building a parallel one. Stock lines
   * reverse through InventoryService.reversePurchase (same weighted-average
   * math as the original purchase, in reverse — refuses outright if the
   * location no longer holds enough to reverse, e.g. because it was already
   * sold, rather than driving stock negative). Expense lines get a negative
   * counter-entry, never an edit to the original row. All inside the
   * caller's already-locked transaction, so a failure on any line rolls
   * back every line reversed so far in this same call — no partial state.
   */
  private async reverseConfirmedInvoice(
    tx: Prisma.TransactionClient,
    tenantId: string,
    actor: string | null,
    invoice: Prisma.PurchaseInvoiceGetPayload<{ include: { items: true } }>,
    reason: string,
  ) {
    const reversal = await tx.purchaseInvoiceReversal.create({
      data: { tenantId, purchaseInvoiceId: invoice.id, reversalType: "cancellation", reason, createdBy: actor },
    });

    for (const item of invoice.items) {
      const reversalItem = await tx.purchaseInvoiceReversalItem.create({
        data: { tenantId, reversalId: reversal.id, purchaseInvoiceItemId: item.id, quantity: item.quantity },
      });

      if (item.itemType === "stock") {
        const originalMovement = await tx.stockMovement.findFirst({
          where: { tenantId, type: "purchase", referenceType: "purchase_invoice_item", referenceId: item.id },
        });
        if (!originalMovement) {
          throw new ConflictException(
            `No stock movement found for item "${item.description}" — cannot verify what to reverse`,
          );
        }
        await this.inventory.reversePurchase(
          {
            movementId: originalMovement.id,
            quantity: item.quantity.toString(),
            reason: `Cancelled purchase invoice ${invoice.supplierInvoiceNumber}`,
          },
          { referenceType: "purchase_invoice_reversal_item", referenceId: reversalItem.id, tx },
        );
      } else {
        await tx.expense.create({
          data: {
            tenantId,
            branchId: invoice.branchId,
            category: item.expenseCategory,
            description: `Reversal: ${item.description}`,
            amount: negateDecimal(item.lineSubtotal),
            vatAmount: negateDecimal(item.lineVat),
            total: negateDecimal(item.lineTotal),
            // Booked today (when the correction actually happens), not
            // backdated to the original invoice date, so a closed
            // accounting period is never silently altered.
            incurredAt: new Date(),
            referenceType: "purchase_invoice_reversal_item",
            referenceId: reversalItem.id,
            createdBy: actor,
          },
        });
      }
    }
  }

  // ------------------------------------------------------------------ //
  // Attachment (private storage — never the public /uploads/ route)
  // ------------------------------------------------------------------ //

  async attach(id: string, file: Express.Multer.File) {
    const ctx = this.tenantContext.contextOrThrow;
    const actor = actorOrNull(ctx.userId);
    await this.get(id);
    const { filename } = await this.uploads.savePrivateFile(
      this.tenantContext.tenantIdOrThrow,
      ATTACHMENT_CATEGORY,
      file,
    );
    const invoice = await this.prisma.scoped.purchaseInvoice.update({
      where: { id },
      data: { attachmentFilename: filename, updatedBy: actor },
    });
    await this.audit.log({
      action: "purchase_invoice.attachment_uploaded",
      entityType: "purchase_invoice",
      entityId: id,
      branchId: invoice.branchId,
    });
    return { attached: true };
  }

  async getAttachment(id: string) {
    const invoice = await this.get(id);
    if (!invoice.attachmentFilename) {
      throw new NotFoundException("This invoice has no attachment");
    }
    return this.uploads.readPrivateFile(
      this.tenantContext.tenantIdOrThrow,
      ATTACHMENT_CATEGORY,
      invoice.attachmentFilename,
    );
  }
}

/** Server-side line pricing — never trusts a client-submitted total. Money
 * math follows the codebase's established integer-halalas + float
 * intermediate convention (same as InventoryService's own quantity math),
 * not a new precision model. */
function priceLine(item: PurchaseInvoiceItemDto, defaultVatRate: string): LinePricing {
  const quantity = Number(item.quantity);
  const unitPrice = Number(item.unitPrice);
  const vatRatePercent = item.vatRatePercent ?? defaultVatRate;
  const rate = Number(vatRatePercent);
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
    throw new BadRequestException(`Invalid VAT rate: ${vatRatePercent}`);
  }

  const lineSubtotalHalalas = Math.round(quantity * unitPrice * 100);
  const lineVatHalalas = Math.round((lineSubtotalHalalas * rate) / 100);
  const lineTotalHalalas = lineSubtotalHalalas + lineVatHalalas;

  return {
    quantity,
    unitPriceHalalas: Math.round(unitPrice * 100),
    vatRatePercent,
    lineSubtotalHalalas,
    lineVatHalalas,
    lineTotalHalalas,
  };
}

/** Flips the sign of a stored money amount — the negative counter-entry for a reversed expense line. */
function negateDecimal(value: { toString(): string }): string {
  return halalasToSar(-sarToHalalas(value.toString()));
}
