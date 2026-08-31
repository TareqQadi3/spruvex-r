import {
  BadRequestException,
  Inject,
  Injectable,
} from "@nestjs/common";
import { createHash, randomInt } from "node:crypto";

import { PlatformSettingsService } from "../../../shared/platform-settings/platform-settings.service";
import { PlatformPrismaService } from "../../../shared/prisma/platform-prisma.service";
import { OTP_SENDER, OtpPurpose, OtpSender } from "./otp-sender";

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

@Injectable()
export class OtpService {
  constructor(
    private readonly db: PlatformPrismaService,
    private readonly platformSettings: PlatformSettingsService,
    @Inject(OTP_SENDER) private readonly sender: OtpSender,
  ) {}

  /**
   * Issues a 6-digit code, invalidating previous unconsumed codes for the
   * same destination+purpose. Returns the code ONLY outside production so
   * the flow is testable before a real SMS/email provider exists.
   */
  async issue(destination: string, purpose: OtpPurpose, userId?: string): Promise<{ devCode?: string }> {
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const { otpTtlMinutes } = await this.platformSettings.getSettings();

    await this.db.otpCode.updateMany({
      where: { destination, purpose, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    await this.db.otpCode.create({
      data: {
        destination,
        purpose,
        userId,
        codeHash: hashCode(code),
        expiresAt: new Date(Date.now() + otpTtlMinutes * 60 * 1000),
      },
    });

    await this.sender.send(destination, code, purpose);
    return process.env.NODE_ENV === "production" ? {} : { devCode: code };
  }

  /** Verifies and consumes a code. Throws on wrong/expired/overused codes. */
  async verify(destination: string, purpose: OtpPurpose, code: string): Promise<void> {
    const otp = await this.db.otpCode.findFirst({
      where: { destination, purpose, consumedAt: null },
      orderBy: { createdAt: "desc" },
    });
    if (!otp || otp.expiresAt < new Date()) {
      throw new BadRequestException("Verification code expired — request a new one");
    }
    const { otpMaxVerifyAttempts } = await this.platformSettings.getSettings();
    if (otp.attempts >= otpMaxVerifyAttempts) {
      throw new BadRequestException("Too many attempts — request a new code");
    }

    if (otp.codeHash !== hashCode(code)) {
      await this.db.otpCode.update({
        where: { id: otp.id },
        data: { attempts: { increment: 1 } },
      });
      throw new BadRequestException("Invalid verification code");
    }

    await this.db.otpCode.update({
      where: { id: otp.id },
      data: { consumedAt: new Date() },
    });
  }
}
