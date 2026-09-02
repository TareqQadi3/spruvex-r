import { Global, Module } from "@nestjs/common";

import { CatalogRealtimeListener } from "./catalog-realtime.listener";
import { OrdersRealtimeListener } from "./orders-realtime.listener";
import { RealtimeGateway } from "./realtime.gateway";

/**
 * Realtime layer: Socket.io gateway (+ Redis adapter in main.ts) and the
 * domain-event listeners that fan updates out to POS/KDS rooms.
 */
@Global()
@Module({
  providers: [RealtimeGateway, OrdersRealtimeListener, CatalogRealtimeListener],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
