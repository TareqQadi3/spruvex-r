import { Module } from "@nestjs/common";

import { OrderingModule } from "../ordering/ordering.module";
import { LoyaltyConfigController } from "./loyalty-config.controller";
import { LoyaltyConfigService } from "./loyalty-config.service";
import { LoyaltyCustomerController } from "./loyalty-customer.controller";
import { LoyaltyCustomerService } from "./loyalty-customer.service";
import { LoyaltyOrderListener } from "./loyalty-order.listener";

/**
 * Loyalty program: stamp cards, spend-threshold discounts, points-per-riyal,
 * and membership tiers — a tenant enables one or more, tenant-wide or
 * overridden per branch. Every earn/redeem is a real order mutation through
 * OrderingService (a real discount or a real $0 line), never a parallel
 * price — see LoyaltyCustomerService's doc comment for the full design.
 */
@Module({
  imports: [OrderingModule],
  controllers: [LoyaltyConfigController, LoyaltyCustomerController],
  providers: [LoyaltyConfigService, LoyaltyCustomerService, LoyaltyOrderListener],
  exports: [LoyaltyCustomerService],
})
export class LoyaltyModule {}
