import { Module } from "@nestjs/common";

import { CouponsController } from "./coupons.controller";
import { CouponsService } from "./coupons.service";

/** Marketing — discount coupon codes for the digital ordering checkout. */
@Module({
  controllers: [CouponsController],
  providers: [CouponsService],
  exports: [CouponsService],
})
export class MarketingModule {}
