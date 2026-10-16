import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";

import { AuditService } from "../../shared/audit/audit.service";
import { halalasToSar, sarToHalalas, vatFromGross } from "../../shared/common/money";
import { PrismaService } from "../../shared/prisma/prisma.service";
import { actorOrNull, TenantContextService } from "../../shared/tenancy/tenant-context.service";
import { IssueDebitNoteDto } from "./dto/payments.dto";
import { ZatcaInvoiceService } from "./zatca/zatca-invoice.service";

/**
 * Corrects an under-billed receipt (extra amount owed) — same append-only,
 * ZATCA-chained shape as a credit note, just adding rather than subtracting.
 * Rare in a POS context (mostly a B2B correction); collecting the extra
 * amount from the customer is a manual follow-up outside this system, same
 * as how subscription billing itself is handled (plan MVP decision).
 */
@Injectable()
export class DebitNotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditService,
    private readonly zatca: ZatcaInvoiceService,
  ) {}

  async issue(orderId: string, dto: IssueDebitNoteDto) {
    const ctx = this.tenantContext.contextOrThrow;
    const tenantId = this.tenantContext.tenantIdOrThrow;

    const amountHalalas = sarToHalalas(dto.amount);
    if (amountHalalas <= 0) {
      throw new ConflictException("Amount must be positive");
    }

    const { debitNote, pendingSubmission } = await this.prisma.scopedTransaction(async (tx) => {
      const receipt = await tx.receipt.findUnique({ where: { orderId } });
      if (!receipt) {
        throw new NotFoundException("Order has no issued receipt to correct");
      }

      const tenant = await tx.tenant.findFirst({ where: { id: tenantId } });
      if (!tenant) {
        throw new NotFoundException("Tenant not found");
      }

      const vatRatePercent = Number(receipt.vatRate.toString());
      const vatAmountHalalas = vatFromGross(amountHalalas, vatRatePercent);
      const subtotalHalalas = amountHalalas - vatAmountHalalas;

      // Row-locks the branch for the duration of the read-then-increment
      // below — same race (and same fix) as RefundsService.refund's
      // creditNoteNumber and OrderingService.createInTransaction's orderNumber.
      await tx.$queryRaw`SELECT id FROM branches WHERE id = ${receipt.branchId}::uuid FOR UPDATE`;
      const last = await tx.debitNote.findFirst({
        where: { branchId: receipt.branchId },
        orderBy: { debitNoteNumber: "desc" },
        select: { debitNoteNumber: true },
      });
      const debitNoteNumber = (last?.debitNoteNumber ?? 0) + 1;
      const issuedAt = new Date();
      const receiptPayload = receipt.payload as {
        restaurant: Record<string, unknown>;
        branch: Record<string, unknown>;
      };

      const zatcaFields = await this.zatca.issue(tx, {
        tenant,
        branchId: receipt.branchId,
        kind: "debit_note",
        documentNumber: debitNoteNumber,
        issueDateTime: issuedAt,
        lines: [
          {
            nameAr: "تصحيح فاتورة",
            nameEn: "Invoice correction",
            quantity: 1,
            unitPriceExclVat: halalasToSar(subtotalHalalas),
            lineExtensionAmount: halalasToSar(subtotalHalalas),
            vatRate: receipt.vatRate.toString(),
            vatAmount: halalasToSar(vatAmountHalalas),
          },
        ],
        subtotal: halalasToSar(subtotalHalalas),
        vatRate: receipt.vatRate.toString(),
        vatAmount: halalasToSar(vatAmountHalalas),
        total: halalasToSar(amountHalalas),
        precedingDocumentUuid: receipt.documentUuid,
      });
      const { pendingSubmission, ...zatcaColumns } = zatcaFields;

      const debitNote = await tx.debitNote.create({
        data: {
          tenantId,
          branchId: receipt.branchId,
          receiptId: receipt.id,
          debitNoteNumber,
          reason: dto.reason,
          payload: {
            restaurant: receiptPayload.restaurant,
            branch: receiptPayload.branch,
            reason: dto.reason,
            originalReceiptNumber: receipt.receiptNumber,
          } as Prisma.InputJsonObject,
          subtotal: halalasToSar(subtotalHalalas),
          vatRate: receipt.vatRate,
          vatAmount: halalasToSar(vatAmountHalalas),
          total: halalasToSar(amountHalalas),
          issuedAt,
          issuedBy: actorOrNull(ctx.userId),
          ...zatcaColumns,
        },
      });

      return { debitNote, pendingSubmission };
    });

    await this.audit.log({
      action: "debit_note.issued",
      entityType: "debit_note",
      entityId: debitNote.id,
      branchId: debitNote.branchId,
      meta: { orderId, amount: dto.amount, reason: dto.reason },
    });

    if (pendingSubmission) {
      await this.zatca.submitAndRecordResult(tenantId, pendingSubmission, debitNote.id);
    }

    return debitNote;
  }
}
