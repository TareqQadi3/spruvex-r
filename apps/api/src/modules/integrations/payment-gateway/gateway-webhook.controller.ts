import { Controller, HttpCode, Param, Post, Req, UseGuards } from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import type { Request } from "express";

import { Public } from "../../../shared/rbac/public.decorator";
import { GatewayService } from "./gateway.service";

@Public()
@UseGuards(ThrottlerGuard)
@Controller("integrations/payment-gateway/webhook")
export class GatewayWebhookController {
  constructor(private readonly gateway: GatewayService) {}

  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @HttpCode(200)
  @Post(":provider/:connectionId")
  handle(
    @Param("provider") provider: string,
    @Param("connectionId") connectionId: string,
    @Req() req: RawBodyRequest<Request>,
  ) {
    const rawBody = req.rawBody?.toString("utf8") ?? "";
    return this.gateway.handleWebhook(provider, connectionId, rawBody, req.headers);
  }
}
