import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";

import { AuditService } from "../../shared/audit/audit.service";
import { sarToHalalas } from "../../shared/common/money";
import { PrismaService } from "../../shared/prisma/prisma.service";
import { ONLINE_PAYMENTS_ACTOR } from "../../shared/tenancy/tenant-context.service";
import { OrderingService } from "../ordering/ordering.service";

/**
 * Records a payment for money a delivery platform or payment gateway
 * collected on the tenant's behalf (never cash, never a cashier's own card
 * terminal) and completes the order exactly like a fully-paid counter order
 * does. PaymentsService.record() is POS-shaped — it requires the calling
 * user to have an open cashier shift, which doesn't apply here: a webhook
 * has no cashier at all. Every branch gets one perpetual "online payments"
 * shift (never closed, opened by the ONLINE_PAYMENTS_ACTOR sentinel, never
 * counted in cash reconciliation since it only ever holds `online` payments)
 * that this money attaches to instead.
 */
@Injectable()
export class OnlinePaymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly ordering: OrderingService,
  ) {}

  private async getOrCreateOnlineShift(tx: Prisma.TransactionClient, tenantId: string, branchId: string) {
    const existing = await tx.shift.findFirst({
      where: { branchId, openedBy: ONLINE_PAYMENTS_ACTOR, closedAt: null },
    });
    if (existing) return existing;
    return tx.shift.create({
      data: { tenantId, branchId, openedBy: ONLINE_PAYMENTS_ACTOR, openingCash: "0" },
    });
  }

  /**
   * Idempotent: a retried webhook with the same idempotencyKey returns the
   * original payment rather than double-recording it.
   */
  async recordAndComplete(params: {
    tenantId: string;
    orderId: string;
    amount: string;
    reference: string;
    idempotencyKey: string;
  }) {
    const existing = await this.prisma.forTenant(params.tenantId).payment.findFirst({
      where: { idempotencyKey: params.idempotencyKey },
    });
    if (existing) return existing;

    const { payment, fullyPaid, orderStatus } = await this.prisma.scopedTransaction(
      async (tx) => {
        const order = await tx.order.findFirst({ where: { id: params.orderId, deletedAt: null } });
        if (!order) {
          throw new Error("Order not found");
        }
        const shift = await this.getOrCreateOnlineShift(tx, params.tenantId, order.branchId);

        const paid = await tx.payment.aggregate({
          where: { orderId: params.orderId, status: "completed" },
          _sum: { amount: true },
        });
        const paidHalalas = sarToHalalas((paid._sum.amount ?? 0).toString());
        const totalHalalas = sarToHalalas(order.total.toString());
        const amountHalalas = sarToHalalas(params.amount);

        const created = await tx.payment.create({
          data: {
            tenantId: params.tenantId,
            branchId: order.branchId,
            orderId: params.orderId,
            shiftId: shift.id,
            method: "online",
            amount: params.amount,
            reference: params.reference,
            idempotencyKey: params.idempotencyKey,
            // Payment.createdBy has no nullable "no human actor" option
            // (unlike Order/Shift) — store the sentinel value itself.
            createdBy: ONLINE_PAYMENTS_ACTOR,
          },
        });
        return {
          payment: created,
          fullyPaid: paidHalalas + amountHalalas >= totalHalalas,
          orderStatus: order.status,
        };
      },
      params.tenantId,
    );

    await this.audit.log({
      tenantId: params.tenantId,
      action: "payment.recorded",
      entityType: "payment",
      entityId: payment.id,
      branchId: payment.branchId,
      meta: { orderId: params.orderId, method: "online", amount: params.amount, reference: params.reference },
    });

    if (fullyPaid && ["confirmed", "ready", "served"].includes(orderStatus)) {
      await this.ordering.transition(params.orderId, "completed", { tenantId: params.tenantId });
    }

    return payment;
  }
}
