import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { AuditService } from "../../shared/audit/audit.service";
import { halalasToSar, sarToHalalas, vatFromGross } from "../../shared/common/money";
import { PrismaService } from "../../shared/prisma/prisma.service";
import {
  actorOrNull,
  TenantContextService,
} from "../../shared/tenancy/tenant-context.service";
import { ZatcaInvoiceService } from "./zatca/zatca-invoice.service";

const NUMBER_CONFLICT_RETRIES = 3;

/**
 * Receipt foundation: sequential per-branch numbering with a frozen snapshot
 * of restaurant info, order lines, VAT fields and payments. Idempotent
 * get-or-create — the POS fetches the receipt after completing an order.
 * ZatcaInvoiceService fills in the QR/hash-chain/XML/signature (Phase 1
 * always; Phase 2 only for tenants who opted in and have CSID credentials
 * configured — see docs on the /tenant/zatca-settings endpoint).
 * Thermal print layouts consume `payload`.
 */
@Injectable()
export class ReceiptsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditService,
    private readonly zatca: ZatcaInvoiceService,
  ) {}

  async getOrCreate(orderId: string) {
    const existing = await this.prisma.scoped.receipt.findUnique({
      where: { orderId },
    });
    if (existing) {
      return existing;
    }
    return this.issue(orderId);
  }

  private async issue(orderId: string) {
    const ctx = this.tenantContext.contextOrThrow;
    const tenantId = this.tenantContext.tenantIdOrThrow;

    for (let attempt = 1; ; attempt++) {
      try {
        const { receipt, pendingSubmission } = await this.prisma.scopedTransaction(async (tx) => {
          // Concurrent issuance guard: re-check inside the transaction.
          const raced = await tx.receipt.findUnique({ where: { orderId } });
          if (raced) {
            return { receipt: raced, pendingSubmission: null };
          }

          const order = await tx.order.findFirst({
            where: { id: orderId, deletedAt: null },
            include: {
              items: { include: { modifiers: true } },
              table: { select: { number: true } },
            },
          });
          if (!order) {
            throw new NotFoundException("Order not found");
          }
          if (order.status !== "completed") {
            throw new ConflictException("Receipts are issued for completed orders only");
          }

          const [tenant, branch, payments] = await Promise.all([
            tx.tenant.findFirst({ where: { id: tenantId } }),
            tx.branch.findFirst({ where: { id: order.branchId } }),
            tx.payment.findMany({
              where: { orderId, status: "completed" },
              orderBy: { createdAt: "asc" },
            }),
          ]);
          if (!tenant) {
            throw new NotFoundException("Tenant not found");
          }

          const last = await tx.receipt.findFirst({
            where: { branchId: order.branchId },
            orderBy: { receiptNumber: "desc" },
            select: { receiptNumber: true },
          });

          const issuedAt = new Date();
          const receiptNumber = (last?.receiptNumber ?? 0) + 1;
          const totalBeforeVat = halalasToSar(
            sarToHalalas(order.total.toString()) - sarToHalalas(order.vatAmount.toString()),
          );
          const vatRatePercent = Number(order.vatRate.toString());

          const zatcaFields = await this.zatca.issue(tx, {
            tenant,
            branchId: order.branchId,
            kind: "invoice",
            documentNumber: receiptNumber,
            issueDateTime: issuedAt,
            lines: order.items.map((item) => {
              const lineTotalHalalas = sarToHalalas(item.lineTotal.toString());
              const lineVatHalalas = vatFromGross(lineTotalHalalas, vatRatePercent);
              return {
                nameAr: (item.productSnapshot as { name: string }).name,
                nameEn: (item.productSnapshot as { nameEn: string | null }).nameEn,
                quantity: item.quantity,
                unitPriceExclVat: halalasToSar(
                  Math.round((lineTotalHalalas - lineVatHalalas) / item.quantity),
                ),
                lineExtensionAmount: halalasToSar(lineTotalHalalas - lineVatHalalas),
                vatRate: order.vatRate.toString(),
                vatAmount: halalasToSar(lineVatHalalas),
              };
            }),
            subtotal: totalBeforeVat,
            vatRate: order.vatRate.toString(),
            vatAmount: order.vatAmount.toString(),
            total: order.total.toString(),
          });
          const { pendingSubmission, ...zatcaColumns } = zatcaFields;

          const receipt = await tx.receipt.create({
            data: {
              tenantId,
              branchId: order.branchId,
              orderId,
              receiptNumber,
              vatRate: order.vatRate,
              vatAmount: order.vatAmount,
              total: order.total,
              issuedAt,
              issuedBy: actorOrNull(ctx.userId),
              ...zatcaColumns,
              payload: {
                restaurant: {
                  name: tenant.name,
                  nameEn: tenant.nameEn,
                  legalName: tenant.legalName ?? tenant.name,
                  vatNumber: tenant.vatNumber,
                  crNumber: tenant.crNumber,
                  address: tenant.address,
                  logoUrl: tenant.logoUrl,
                  currency: tenant.currency,
                  themeColor: tenant.themeColor,
                  // Snapshotted as of issuance — changing these later never
                  // retroactively alters an already-issued invoice.
                  receiptTemplate: tenant.receiptTemplate,
                  receiptLogoPosition: tenant.receiptLogoPosition,
                  receiptLogoSize: tenant.receiptLogoSize,
                  receiptHeaderNote: tenant.receiptHeaderNote,
                  receiptFooterNote: tenant.receiptFooterNote,
                },
                branch: {
                  name: branch?.name,
                  nameEn: branch?.nameEn,
                  address: branch?.address,
                  phone: branch?.phone,
                },
                order: {
                  orderNumber: order.orderNumber,
                  type: order.type,
                  table: order.table?.number ?? null,
                  createdAt: order.createdAt.toISOString(),
                  lines: order.items.map((item) => ({
                    name: (item.productSnapshot as { name: string }).name,
                    nameEn: (item.productSnapshot as { nameEn: string | null }).nameEn,
                    quantity: item.quantity,
                    unitPrice: item.unitPrice.toString(),
                    lineTotal: item.lineTotal.toString(),
                    modifiers: item.modifiers.map((modifier) => ({
                      name: (modifier.modifierSnapshot as { name: string }).name,
                      priceAdjustment: modifier.priceAdjustment.toString(),
                    })),
                  })),
                },
                totals: {
                  subtotal: order.subtotal.toString(),
                  discount: order.discount.toString(),
                  totalBeforeVat,
                  vatRate: order.vatRate.toString(),
                  vatAmount: order.vatAmount.toString(),
                  total: order.total.toString(),
                },
                payments: payments.map((payment) => ({
                  method: payment.method,
                  amount: payment.amount.toString(),
                  reference: payment.reference,
                })),
              },
            },
          });
          return { receipt, pendingSubmission };
        });

        await this.audit.log({
          action: "receipt.issued",
          entityType: "receipt",
          entityId: receipt.id,
          branchId: receipt.branchId,
          meta: { receiptNumber: receipt.receiptNumber, orderId },
        });

        if (pendingSubmission) {
          await this.zatca.submitAndRecordResult(tenantId, pendingSubmission, receipt.id);
        }

        return receipt;
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
}
