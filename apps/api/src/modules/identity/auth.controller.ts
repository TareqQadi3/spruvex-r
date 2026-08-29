import { Body, Controller, Get, HttpCode, Post, Req } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { Request } from "express";

import { Public } from "../../shared/rbac/public.decorator";
import { RequireAuthenticated } from "../../shared/rbac/require-authenticated.decorator";
import { TenantContextService } from "../../shared/tenancy/tenant-context.service";
import { AuthService } from "./auth.service";
import {
  ForgotPasswordDto,
  LoginDto,
  RefreshDto,
  RegisterDto,
  ResendOtpDto,
  ResetPasswordDto,
  VerifyOtpDto,
} from "./dto/auth.dto";

function requestMeta(req: Request) {
  return { ip: req.ip, userAgent: req.headers["user-agent"] };
}

@Controller("auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("register")
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post("register/verify")
  verify(@Body() dto: VerifyOtpDto, @Req() req: Request) {
    return this.auth.verifyRegistration(dto, requestMeta(req));
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(200)
  @Post("register/resend-otp")
  resendOtp(@Body() dto: ResendOtpDto) {
    return this.auth.resendRegistrationOtp(dto.email);
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(200)
  @Post("login")
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.auth.login(dto, requestMeta(req));
  }

  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(200)
  @Post("refresh")
  refresh(@Body() dto: RefreshDto, @Req() req: Request) {
    return this.auth.refresh(dto.refreshToken, requestMeta(req));
  }

  @Public()
  @HttpCode(204)
  @Post("logout")
  async logout(@Body() dto: RefreshDto) {
    await this.auth.logout(dto.refreshToken);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(200)
  @Post("forgot-password")
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.auth.forgotPassword(dto.email);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(204)
  @Post("reset-password")
  async resetPassword(@Body() dto: ResetPasswordDto) {
    await this.auth.resetPassword(dto);
  }

  @RequireAuthenticated()
  @Get("me")
  me() {
    const { userId } = this.tenantContext.contextOrThrow;
    return this.auth.describe(userId);
  }
}
