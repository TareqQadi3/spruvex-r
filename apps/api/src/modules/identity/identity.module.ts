import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";

import { ResendService } from "../../shared/email/resend.service";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { DevOtpSender, OTP_SENDER } from "./otp/otp-sender";
import { OtpService } from "./otp/otp.service";
import { ResendOtpSender } from "./otp/resend-otp-sender";
import { TokenService } from "./token.service";

/**
 * Identity module — registration, OTP verification, login/logout,
 * JWT access + rotating refresh tokens, account lockout.
 */
@Module({
  imports: [
    JwtModule.registerAsync({
      global: true,
      useFactory: () => ({
        secret: process.env.JWT_SECRET,
        // Pin the algorithm on both sign and verify — defense-in-depth
        // against algorithm-confusion attacks even though jsonwebtoken
        // already rejects "none" by default.
        signOptions: { algorithm: "HS256" },
        verifyOptions: { algorithms: ["HS256"] },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    TokenService,
    OtpService,
    ResendService,
    // Real email once a Resend key is configured; falls back to logging the
    // code (never a real send) so local dev/CI never needs one.
    {
      provide: OTP_SENDER,
      useClass: process.env.RESEND_API_KEY ? ResendOtpSender : DevOtpSender,
    },
  ],
  exports: [AuthService, TokenService, ResendService],
})
export class IdentityModule {}
