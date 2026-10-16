import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";

import { Public } from "../../../shared/rbac/public.decorator";
import { CreateGatewayCheckoutDto } from "./dto/gateway-checkout.dto";
import { GatewayService } from "./gateway.service";

/**
 * Guest-accessible: creates a hosted payment-gateway checkout for an order
 * the customer already placed through the normal (unauthenticated) ordering
 * flow. orderId is an unguessable UUID — the same capability-token pattern
 * /public/orders/:orderId/track already uses.
 */
@Public()
@UseGuards(ThrottlerGuard)
@Controller("integrations/payment-gateway/checkout")
export class GatewayCheckoutController {
  constructor(private readonly gateway: GatewayService) {}

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post()
  create(@Body() dto: CreateGatewayCheckoutDto) {
    return this.gateway.createCheckout(dto.orderId);
  }
}
