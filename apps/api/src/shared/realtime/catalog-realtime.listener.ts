import { Injectable } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";

import { DOMAIN_EVENTS } from "@spruvex-r/types";

import { RealtimeGateway } from "./realtime.gateway";
import { RT_EVENTS, rtRooms } from "./rooms";

export interface AvailabilityEventPayload {
  tenantId: string;
  branchId: string;
  productId?: string;
  modifierId?: string;
  isAvailable: boolean;
}

export interface ChannelStatusEventPayload {
  tenantId: string;
  branchId: string;
  channel: string;
  open: boolean;
  reason: string;
}

/**
 * Bridges catalog-availability and branch-channel-status domain events to
 * the realtime layer, so POS/dashboard screens already watching a branch's
 * "catalog" room update the instant a merchant (or the system) flips an
 * item's availability or pauses a channel — the single-source-of-truth
 * requirement item 2/1 of the menu-channels round asks for (no separate
 * polling loop needed on those screens; the guest-facing menu still
 * short-polls, see apps/ordering).
 */
@Injectable()
export class CatalogRealtimeListener {
  constructor(private readonly gateway: RealtimeGateway) {}

  @OnEvent(DOMAIN_EVENTS.PRODUCT_AVAILABILITY_CHANGED)
  onAvailabilityChanged(payload: AvailabilityEventPayload): void {
    this.gateway.emitToRooms([rtRooms.branchCatalog(payload.branchId)], RT_EVENTS.AVAILABILITY_CHANGED, payload);
  }

  @OnEvent(DOMAIN_EVENTS.BRANCH_CHANNEL_STATUS_CHANGED)
  onChannelStatusChanged(payload: ChannelStatusEventPayload): void {
    this.gateway.emitToRooms(
      [rtRooms.branchCatalog(payload.branchId)],
      RT_EVENTS.CHANNEL_STATUS_CHANGED,
      payload,
    );
  }
}
