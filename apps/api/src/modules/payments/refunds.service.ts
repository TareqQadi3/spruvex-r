import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import type { Prisma } from "@prisma/client";

import { AuditService } from "../../shared/audit/audit.service";
import { halalasToSar, sarToHalalas, vatFromGross } from "../../shared/common/money";
import { PrismaService } from "../../shared/prisma/prisma.service";
import { actorOrNull, TenantContextService } from "../../shared/tenancy/tenant-context.service";
import { OrderingService } from "../ordering/ordering.service";
import { RefundOrderDto } from "./dto/payments.dto";
import { ZatcaInvoiceService } from "./zatca/zatca-invoice.service";

@Injectable()
export class RefundsService {
  private readonly logger = new Logger(RefundsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditService,
    private readonly ordering: OrderingService,
    private readonly zatca: ZatcaInvoiceService,
  ) {}

  /**
   * Refunds (fully or partially) a completed order's receipt. Rules:
   * - the order must be `completed` and have an issued receipt,
   * - the amount may not exceed what's left to refund (receipt total minus
   *   already-issued credit notes),
   * - the caller must have an OPEN SHIFT in the order's branch (same
   *   precondition as taking a payment) — that shift is what actually hands
   *   the cash/card refund back, and is what shift close reconciles against,
   * - a full refund (amount === remaining) also transitions the order to
   *   `refunded`; a partial refund leaves it `completed`.
   */
  async refund(orderId: string, dto: RefundOrderDto) {
    const ctx = this.tenantContext.contextOrThrow;
    const tenantId = this.tenantContext.tenantIdOrThrow;

    const amountHalalas = sarToHalalas(dto.amount);
    if (amountHalalas <= 0) {
      throw new BadRequestException("Amount must be positive");
    }

    const { creditNote, refund, isFullRefund, pendingSubmission } =
      await this.prisma.scopedTransaction(async (tx) => {
        const order = await tx.order.findFirst({ where: { id: orderId, deletedAt: null } });
        if (!order) {
          throw new NotFoundException("Order not found");
        }
        if (order.status !== "completed") {
          throw new ConflictException(
            `Only completed orders can be refunded (current status: ${order.status})`,
          );
        }

        const receipt = await tx.receipt.findUnique({ where: { orderId } });
        if (!receipt) {
          throw new ConflictException("Order has no issued receipt to refund against");
        }

        const shift = await tx.shift.findFirst({
          where: { branchId: order.branchId, openedBy: ctx.userId, closedAt: null },
        });
        if (!shift) {
          throw new ConflictException("Open a shift before processing a refund");
        }

        const alreadyRefunded = await tx.creditNote.aggregate({
          where: { receiptId: receipt.id },
          _sum: { total: true },
        });
        const refundedHalalas = sarToHalalas((alreadyRefunded._sum.total ?? 0).toString());
        const receiptTotalHalalas = sarToHalalas(receipt.total.toString());
        const remainingHalalas = receiptTotalHalalas - refundedHalalas;
        if (remainingHalalas <= 0) {
          throw new ConflictException("This receipt has already been fully refunded");
        }
        if (amountHalalas > remainingHalalas) {
          throw new BadRequestException(
            `Amount exceeds the remaining refundable balance (${halalasToSar(remainingHalalas)})`,
          );
        }

        const vatRatePercent = Number(receipt.vatRate.toString());
        const vatAmountHalalas = vatFromGross(amountHalalas, vatRatePercent);
        const subtotalHalalas = amountHalalas - vatAmountHalalas;

        const tenant = await tx.tenant.findFirst({ where: { id: tenantId } });
        if (!tenant) {
          throw new NotFoundException("Tenant not found");
        }

        const last = await tx.creditNote.findFirst({
          where: { branchId: order.branchId },
          orderBy: { creditNoteNumber: "desc" },
          select: { creditNoteNumber: true },
        });
        const creditNoteNumber = (last?.creditNoteNumber ?? 0) + 1;
        const issuedAt = new Date();

        const receiptPayload = receipt.payload as {
          restaurant: Record<string, unknown>;
          branch: Record<string, unknown>;
        };

        const zatcaFields = await this.zatca.issue(tx, {
          tenant,
          branchId: order.branchId,
          kind: "credit_note",
          documentNumber: creditNoteNumber,
          issueDateTime: issuedAt,
          lines: [
            {
              nameAr: "استرداد",
              nameEn: "Refund",
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
        const { pendingSubmission: _pendingSubmission, ...zatcaColumns } = zatcaFields;

        const creditNote = await tx.creditNote.create({
          data: {
            tenantId,
            branchId: order.branchId,
            receiptId: receipt.id,
            creditNoteNumber,
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

        const refund = await tx.refund.create({
          data: {
            tenantId,
            branchId: order.branchId,
            orderId,
            receiptId: receipt.id,
            creditNoteId: creditNote.id,
            shiftId: shift.id,
            method: dto.method,
            amount: dto.amount,
            reference: dto.reference,
            createdBy: ctx.userId,
          },
        });

        return {
          creditNote,
          refund,
          isFullRefund: amountHalalas === remainingHalalas,
          pendingSubmission: zatcaFields.pendingSubmission,
        };
      });

    await this.audit.log({
      action: "refund.issued",
      entityType: "credit_note",
      entityId: creditNote.id,
      branchId: creditNote.branchId,
      meta: {
        orderId,
        amount: dto.amount,
        method: dto.method,
        reason: dto.reason,
        isFullRefund,
      },
    });

    if (isFullRefund) {
      try {
        await this.ordering.transition(orderId, "refunded", { reason: dto.reason, tenantId });
      } catch (error) {
        // The credit note + refund are already the source of truth for the
        // money; a status-flip failure here is a reconciliation gap, not a
        // financial one. Logged loudly rather than swallowed.
        this.logger.error(
          `Order ${orderId} fully refunded (credit note ${creditNote.id}) but failed to transition to 'refunded'`,
          error as Error,
        );
      }
    }

    if (pendingSubmission) {
      await this.zatca.submitAndRecordResult(tenantId, pendingSubmission, creditNote.id);
    }

    return { creditNote, refund };
  }
}
