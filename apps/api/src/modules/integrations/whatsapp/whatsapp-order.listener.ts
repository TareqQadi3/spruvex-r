import { Injectable } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";

import { DOMAIN_EVENTS } from "@spruvex-r/types";

import { LoyaltyCustomerService } from "../../loyalty/loyalty-customer.service";
import { PrismaService } from "../../../shared/prisma/prisma.service";
import type { OrderEventPayload } from "../../../shared/realtime/orders-realtime.listener";
import { WhatsappService } from "./whatsapp.service";

interface OrderLike {
  id: string;
  orderNumber: number;
  status: string;
  type: string;
  source: string;
  customerName: string | null;
  customerPhone: string | null;
}

function orderingBaseUrl(): string {
  return (process.env.ORDERING_BASE_URL ?? "http://localhost:5174").replace(/\/+$/, "");
}

/**
 * Reacts to the same order/invoice domain events the realtime layer and
 * stock deduction already do — sends the matching customer-facing WhatsApp
 * template (never blocking or failing the order/receipt pipeline itself;
 * see WhatsappService's doc comment on why every send here is best-effort).
 */
@Injectable()
export class WhatsappOrderListener {
  constructor(
    private readonly whatsapp: WhatsappService,
    private readonly prisma: PrismaService,
    private readonly loyalty: LoyaltyCustomerService,
  ) {}

  @OnEvent(DOMAIN_EVENTS.ORDER_CREATED)
  async onOrderCreated(payload: OrderEventPayload): Promise<void> {
    const order = payload.order as unknown as OrderLike;
    // Only digital-menu orders (QR table / external pickup link) — a
    // walk-in standing at the counter, or a delivery-platform order the
    // platform itself already confirmed to the customer, doesn't need this.
    if (order.source !== "qr" && order.source !== "external_link") return;

    const tenant = await this.prisma.scoped.tenant.findUnique({
      where: { id: payload.tenantId },
      select: { name: true },
    });
    await this.whatsapp.sendTemplate("order_received", order.customerPhone, {
      customerName: order.customerName ?? "",
      orderNumber: String(order.orderNumber),
      restaurantName: tenant?.name ?? "",
      total: String(payload.order.total),
    });
  }

  @OnEvent(DOMAIN_EVENTS.ORDER_STATUS_CHANGED)
  async onStatusChanged(payload: OrderEventPayload): Promise<void> {
    const order = payload.order as unknown as OrderLike;
    if (order.status !== "preparing" && order.status !== "ready") return;

    const tenant = await this.prisma.scoped.tenant.findUnique({
      where: { id: payload.tenantId },
      select: { name: true },
    });
    await this.whatsapp.sendTemplate(
      order.status === "preparing" ? "order_preparing" : "order_ready",
      order.customerPhone,
      { orderNumber: String(order.orderNumber), restaurantName: tenant?.name ?? "" },
    );
  }

  @OnEvent(DOMAIN_EVENTS.INVOICE_ISSUED)
  async onInvoiceIssued(payload: {
    tenantId: string;
    branchId: string;
    receiptId: string;
    orderId: string;
  }): Promise<void> {
    const [tenant, receipt, order] = await Promise.all([
      this.prisma.scoped.tenant.findUnique({ where: { id: payload.tenantId }, select: { name: true } }),
      this.prisma.scoped.receipt.findUnique({
        where: { id: payload.receiptId },
        select: { receiptNumber: true, total: true },
      }),
      this.prisma.scoped.order.findUnique({
        where: { id: payload.orderId },
        select: { customerPhone: true },
      }),
    ]);
    if (!receipt || !order?.customerPhone) return;

    const loyaltyStatus = await this.loyalty.getWhatsappStatusLine(
      payload.tenantId,
      payload.branchId,
      order.customerPhone,
    );

    await this.whatsapp.sendTemplate("invoice_sent", order.customerPhone, {
      restaurantName: tenant?.name ?? "",
      receiptNumber: String(receipt.receiptNumber),
      total: String(receipt.total),
      receiptLink: `${orderingBaseUrl()}/receipt/${payload.receiptId}`,
      loyaltyStatus,
    });
  }
}
