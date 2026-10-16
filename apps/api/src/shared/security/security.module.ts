import { Global, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";

/**
 * Global rate limiting (Phase 8 security review). Every request gets a
 * baseline per-IP limit; sensitive endpoints (auth, platform login) apply a
 * tighter @Throttle() override on top. Previously only the guest ordering
 * endpoints had any throttling — login/register/OTP had none beyond the
 * per-account lockout, which doesn't stop credential-stuffing across many
 * different accounts from one IP.
 *
 * The baseline is generous (300/min): an active dashboard session easily
 * exceeds 120 requests/minute once charts/tables poll, and before main.ts
 * set "trust proxy" every dashboard user shared ONE bucket (the proxy's
 * internal IP), so normal use tripped the limit and the UI silently did
 * nothing on every button (the 429 body has no message text). With real
 * per-IP accounting the tighter endpoint-specific limits carry the
 * anti-abuse weight; this baseline only stops runaway scripts.
 */
@Global()
@Module({
  imports: [
    ThrottlerModule.forRoot([{ name: "default", ttl: 60_000, limit: 300 }]),
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class SecurityModule {}