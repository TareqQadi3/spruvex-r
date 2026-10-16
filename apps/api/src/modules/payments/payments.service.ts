import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import { AuditService } from "../../shared/audit/audit.service";
import { halalasToSar, sarToHalalas } from "../../shared/common/money";
import { PrismaService } from "../../shared/prisma/prisma.service";
import { TenantContextService } from "../../shared/tenancy/tenant-context.service";
import { OrderingService } from "../ordering/ordering.service";
import { RecordPaymentDto } from "./dto/payments.dto";

/** Statuses that can accept payments (confirmed and beyond, still open). */
const PAYABLE_STATUSES = ["confirmed", "preparing", "ready", "served"] as const;

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditService,
    private readonly ordering: OrderingService,
  ) {}

  /** Payment lines + balance for the POS payment screen. */
  async summary(orderId: string) {
    const order = await this.prisma.scoped.order.findFirst({
      where: { id: orderId, deletedAt: null },
      select: { id: true, total: true, status: true, customerPhone: true },
    });
    if (!order) {
      throw new NotFoundException("Order not found");
    }
    const payments = await this.prisma.scoped.payment.findMany({
      where: { orderId, status: "completed" },
      orderBy: { createdAt: "asc" },
    });
    const totalHalalas = sarToHalalas(order.total.toString());
    const paidHalalas = payments.reduce(
      (sum, payment) => sum + sarToHalalas(payment.amount.toString()),
      0,
    );
    return {
      orderId,
      status: order.status,
      customerPhone: order.customerPhone,
      total: halalasToSar(totalHalalas),
      paid: halalasToSar(paidHalalas),
      remaining: halalasToSar(Math.max(totalHalalas - paidHalalas, 0)),
      payments,
    };
  }

  /**
   * Records one payment line atomically. Rules:
   * - the cashier must have an OPEN SHIFT in the order's branch,
   * - the order must be confirmed and not closed,
   * - the amount may not exceed the remaining balance (over/duplicate
   *   payment prevention), and Idempotency-Key replays return the original,
   * - full payment auto-completes counter orders (confirmed/ready/served).
   */
  async record(orderId: string, dto: RecordPaymentDto, idempotencyKey: string) {
    const ctx = this.tenantContext.contextOrThrow;
    const tenantId = this.tenantContext.tenantIdOrThrow;

    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      throw new BadRequestException("Idempotency-Key header is required (8-128 chars)");
    }
    const amountHalalas = sarToHalalas(dto.amount);
    if (amountHalalas <= 0) {
      throw new BadRequestException("Amount must be positive");
    }

    const existing = await this.prisma.scoped.payment.findFirst({
      where: { idempotencyKey },
    });
    if (existing) {
      return { payment: existing, ...(await this.summary(existing.orderId)) };
    }

    const { payment, fullyPaid, orderStatus } = await this.prisma.scopedTransaction(
      async (tx) => {
        const order = await tx.order.findFirst({
          where: { id: orderId, deletedAt: null },
        });
        if (!order) {
          throw new NotFoundException("Order not found");
        }
        if (!(PAYABLE_STATUSES as readonly string[]).includes(order.status)) {
          throw new ConflictException(
            order.status === "new"
              ? "Confirm the order before taking payment"
              : `Order is ${order.status} — no further payments accepted`,
          );
        }

        const shift = await tx.shift.findFirst({
          where: { branchId: order.branchId, openedBy: ctx.userId, closedAt: null },
        });
        if (!shift) {
          throw new ConflictException("Open a shift before taking payments");
        }

        const paid = await tx.payment.aggregate({
          where: { orderId, status: "completed" },
          _sum: { amount: true },
        });
        const paidHalalas = sarToHalalas((paid._sum.amount ?? 0).toString());
        const totalHalalas = sarToHalalas(order.total.toString());
        const remaining = totalHalalas - paidHalalas;
        if (remaining <= 0) {
          throw new ConflictException("Order is already fully paid");
        }
        if (amountHalalas > remaining) {
          throw new BadRequestException(
            `Amount exceeds remaining balance (${halalasToSar(remaining)})`,
          );
        }

        const payment = await tx.payment.create({
          data: {
            tenantId,
            branchId: order.branchId,
            orderId,
            shiftId: shift.id,
            method: dto.method,
            amount: dto.amount,
            reference: dto.reference,
            idempotencyKey,
            createdBy: ctx.userId,
          },
        });
        return {
          payment,
          fullyPaid: paidHalalas + amountHalalas === totalHalalas,
          orderStatus: order.status,
        };
      },
    );

    await this.audit.log({
      action: "payment.recorded",
      entityType: "payment",
      entityId: payment.id,
      branchId: payment.branchId,
      meta: { orderId, method: dto.method, amount: dto.amount, reference: dto.reference ?? null },
    });

    // Full payment closes counter orders; preparing stays on the KDS and
    // completes later (guard in OrderingService still enforces full payment).
    if (fullyPaid && ["confirmed", "ready", "served"].includes(orderStatus)) {
      await this.ordering.transition(orderId, "completed");
    }

    return { payment, ...(await this.summary(orderId)) };
  }
}
