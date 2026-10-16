import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from "@nestjs/common";

import { RequirePermission } from "../../shared/rbac/require-permission.decorator";
import { actorOrNull, TenantContextService } from "../../shared/tenancy/tenant-context.service";
import { RedeemLoyaltyDto } from "./dto/redeem.dto";
import { LoyaltyCustomerService } from "./loyalty-customer.service";

@Controller("loyalty")
export class LoyaltyCustomerController {
  constructor(
    private readonly loyalty: LoyaltyCustomerService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** Cashier lookup: a customer's balance across all 4 programs, by phone. */
  @RequirePermission("loyalty.redeem")
  @Get("customers/:phone")
  getBalance(@Param("phone") phone: string) {
    return this.loyalty.getBalance(phone);
  }

  /** Manual redemption at checkout — the order's own customerPhone identifies the customer. */
  @RequirePermission("loyalty.redeem")
  @HttpCode(200)
  @Post("orders/:orderId/redeem")
  redeem(@Param("orderId", ParseUUIDPipe) orderId: string, @Body() dto: RedeemLoyaltyDto) {
    const ctx = this.tenantContext.contextOrThrow;
    return this.loyalty.redeemManually(orderId, dto.type, actorOrNull(ctx.userId));
  }
}
