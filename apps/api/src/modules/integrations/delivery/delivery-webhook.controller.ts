import { Controller, HttpCode, Param, Post, Req, UseGuards } from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";
import type { Request } from "express";

import { Public } from "../../../shared/rbac/public.decorator";
import { DeliveryWebhookService } from "./delivery-webhook.service";

/**
 * Public webhook receivers for delivery platforms — one route per (provider,
 * connection). The connection id in the path identifies which tenant/branch
 * this belongs to (there's no JWT here, it's an external caller); the
 * signature header is what actually proves the request is genuine.
 */
@Public()
@UseGuards(ThrottlerGuard)
@Controller("integrations/delivery/webhook")
export class DeliveryWebhookController {
  constructor(private readonly webhook: DeliveryWebhookService) {}

  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @HttpCode(200)
  @Post(":provider/:connectionId")
  handle(
    @Param("provider") provider: string,
    @Param("connectionId") connectionId: string,
    @Req() req: RawBodyRequest<Request>,
  ) {
    const rawBody = req.rawBody?.toString("utf8") ?? "";
    return this.webhook.handle(provider, connectionId, rawBody, req.headers);
  }
}
