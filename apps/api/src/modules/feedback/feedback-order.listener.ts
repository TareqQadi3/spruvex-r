import { Injectable } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";

import { DOMAIN_EVENTS } from "@spruvex-r/types";

import type { OrderEventPayload } from "../../shared/realtime/orders-realtime.listener";
import { FeedbackService } from "./feedback.service";

/** Reacts to the same order.status_changed event stock deduction and the WhatsApp order listener already do. */
@Injectable()
export class FeedbackOrderListener {
  constructor(private readonly feedback: FeedbackService) {}

  @OnEvent(DOMAIN_EVENTS.ORDER_STATUS_CHANGED)
  async onStatusChanged(payload: OrderEventPayload): Promise<void> {
    if (payload.order.status !== "completed") return;
    await this.feedback.createRequestForCompletedOrder(payload.tenantId, payload.branchId, payload.order.id);
  }
}
