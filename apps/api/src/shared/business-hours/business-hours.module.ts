import { Module } from "@nestjs/common";

import { BusinessHoursService } from "./business-hours.service";

/**
 * Business-hours/channel-pause/delivery-settings resolution — a shared,
 * cross-module service: TenancyController exposes the CRUD, OrderingModule
 * uses assertChannelOpen() as the real server-side order-creation guard.
 */
@Module({
  providers: [BusinessHoursService],
  exports: [BusinessHoursService],
})
export class BusinessHoursModule {}
