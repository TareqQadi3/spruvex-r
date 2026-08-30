import { Injectable } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";

import { DOMAIN_EVENTS } from "@spruvex-r/types";

import type { OrderEventPayload } from "../../shared/realtime/orders-realtime.listener";
import { LoyaltyCustomerService, type LoyaltyOrderLike } from "./loyalty-customer.service";

interface OrderItemLike {
  productId: string;
  quantity: number;
}

/**
 * Reacts to the same order domain events stock deduction, WhatsApp
 * notifications and feedback requests already do:
 * - order.created -> try an automatic redemption for a phone-identified customer;
 * - order.status_changed -> completed -> earn stamps/spend/points/tier;
 * - order.status_changed -> refunded, and order.cancelled -> reverse any
 *   ledger entries tied to that order (both earned and redeemed).
 * Every handler is best-effort/non-blocking by design — see
 * LoyaltyCustomerService's own doc comments.
 */
@Injectable()
export class LoyaltyOrderListener {
  constructor(private readonly loyalty: LoyaltyCustomerService) {}

  @OnEvent(DOMAIN_EVENTS.ORDER_CREATED)
  async onCreated(payload: OrderEventPayload): Promise<void> {
    await this.loyalty.autoApplyOnOrderCreated(this.toOrderLike(payload));
  }

  @OnEvent(DOMAIN_EVENTS.ORDER_STATUS_CHANGED)
  async onStatusChanged(payload: OrderEventPayload): Promise<void> {
    if (payload.order.status === "completed") {
      await this.loyalty.earnForCompletedOrder(payload.tenantId, this.toOrderLike(payload));
    } else if (payload.order.status === "refunded") {
      await this.loyalty.reverseForOrder(payload.tenantId, payload.order.id);
    }
  }

  @OnEvent(DOMAIN_EVENTS.ORDER_CANCELLED)
  async onCancelled(payload: OrderEventPayload): Promise<void> {
    await this.loyalty.reverseForOrder(payload.tenantId, payload.order.id);
  }

  private toOrderLike(payload: OrderEventPayload): LoyaltyOrderLike {
    const order = payload.order as unknown as {
      id: string;
      status: string;
      subtotal: unknown;
      total: unknown;
      vatRate: unknown;
      customerName: string | null;
      customerPhone: string | null;
      items?: OrderItemLike[];
    };
    return {
      id: order.id,
      branchId: payload.branchId,
      status: order.status,
      subtotal: order.subtotal,
      total: order.total,
      vatRate: order.vatRate,
      customerName: order.customerName,
      customerPhone: order.customerPhone,
      items: (order.items ?? []).map((item) => ({ productId: item.productId, quantity: item.quantity })),
    };
  }
}
