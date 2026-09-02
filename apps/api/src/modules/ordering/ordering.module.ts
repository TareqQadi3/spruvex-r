import { Module } from "@nestjs/common";
import { ThrottlerModule } from "@nestjs/throttler";

import { BusinessHoursModule } from "../../shared/business-hours/business-hours.module";
import { GuestOrderingController } from "./guest-ordering.controller";
import { GuestOrderingService } from "./guest-ordering.service";
import { OrderingService } from "./ordering.service";
import { OrdersController } from "./orders.controller";

/**
 * Ordering module — the heart of the system. Orders with frozen snapshots,
 * the central status state machine, daily numbering, table-session linkage
 * and the public guest (QR) ordering endpoints.
 */
@Module({
  imports: [
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }]),
    BusinessHoursModule,
  ],
  controllers: [OrdersController, GuestOrderingController],
  providers: [OrderingService, GuestOrderingService],
  exports: [OrderingService],
})
export class OrderingModule {}
