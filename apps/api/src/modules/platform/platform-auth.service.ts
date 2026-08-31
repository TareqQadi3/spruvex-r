import { ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";

import { PlatformSettingsService } from "../../shared/platform-settings/platform-settings.service";
import { PlatformPrismaService } from "../../shared/prisma/platform-prisma.service";
import { verifyPassword } from "../identity/password";
import { PLATFORM_ADMIN_TOKEN_TTL_SECONDS, type PlatformAdminTokenPayload } from "./platform-admin-token";

/** Same brute-force lockout policy as the tenant AuthService — literally the
 * same PlatformSettingsService.getSettings() call, one shared policy. */
@Injectable()
export class PlatformAuthService {
  constructor(
    private readonly jwt: JwtService,
    private readonly db: PlatformPrismaService,
    private readonly platformSettings: PlatformSettingsService,
  ) {}

  async login(email: string, password: string): Promise<{ accessToken: string; expiresInSeconds: number }> {
    const admin = await this.db.platformAdmin.findUnique({ where: { email: email.toLowerCase() } });
    if (!admin || !admin.isActive) {
      throw new UnauthorizedException("Invalid email or password");
    }
    if (admin.lockedUntil && admin.lockedUntil > new Date()) {
      throw new ForbiddenException("Account temporarily locked after repeated failed attempts — try again later");
    }

    const valid = await verifyPassword(password, admin.passwordHash);
    if (!valid) {
      const { maxFailedLogins, lockoutMinutes } = await this.platformSettings.getSettings();
      const failed = admin.failedLoginAttempts + 1;
      await this.db.platformAdmin.update({
        where: { id: admin.id },
        data: {
          failedLoginAttempts: failed,
          lockedUntil: failed >= maxFailedLogins ? new Date(Date.now() + lockoutMinutes * 60 * 1000) : null,
        },
      });
      throw new UnauthorizedException("Invalid email or password");
    }

    await this.db.platformAdmin.update({
      where: { id: admin.id },
      data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
    });

    const payload: PlatformAdminTokenPayload = { sub: admin.id, email: admin.email, type: "platform_admin" };
    const accessToken = this.jwt.sign(payload, { expiresIn: PLATFORM_ADMIN_TOKEN_TTL_SECONDS });
    return { accessToken, expiresInSeconds: PLATFORM_ADMIN_TOKEN_TTL_SECONDS };
  }
}
