import { Body, Controller, HttpCode, Post, Req, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Request } from "express";

import { Public } from "../../shared/rbac/public.decorator";
import { PublicTrialSignupDto } from "./dto/site-public.dto";
import { SiteApiKeyGuard } from "./site-api-key.guard";
import { SitePublicService } from "./site-public.service";

@Controller("public")
export class SitePublicController {
  constructor(private readonly site: SitePublicService) {}

  @Public()
  @UseGuards(SiteApiKeyGuard)
  // The most sensitive endpoint in the system: unauthenticated, and it
  // provisions a real tenant. 5/hour per IP is ~120x stricter than the
  // 10/min on /auth/register, while leaving room for a mistyped phone/email
  // retry before a real, deliberate abuser gets blocked.
  @Throttle({ default: { limit: 5, ttl: 60 * 60_000 } })
  @HttpCode(201)
  @Post("trial-signup")
  createTrial(@Body() dto: PublicTrialSignupDto, @Req() req: Request) {
    return this.site.createTrial(dto, { ip: req.ip });
  }
}
