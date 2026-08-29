import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";

import { PlatformPrismaService } from "../../shared/prisma/platform-prisma.service";
import { OtpService } from "./otp/otp.service";
import { hashPassword, verifyPassword } from "./password";
import { TokenService, type TokenPair } from "./token.service";

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;

export interface AuthenticatedUser {
  id: string;
  name: string;
  email: string;
  tenantId?: string;
  permissions: string[];
  onboardingCompleted: boolean;
}

/**
 * Registration, login, logout and session security. Operates on global
 * identity tables (users, refresh_tokens, otp_codes) via the platform
 * connection — these exist before any tenant does.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly db: PlatformPrismaService,
    private readonly otp: OtpService,
    private readonly tokens: TokenService,
  ) {}

  /** Step 1 of onboarding: create the owner account and send a verification OTP. */
  async register(input: {
    name: string;
    email: string;
    phone?: string;
    password: string;
  }): Promise<{ userId: string; devOtp?: string }> {
    const email = input.email.toLowerCase();
    const existing = await this.db.user.findUnique({ where: { email } });

    if (existing?.emailVerifiedAt) {
      throw new ConflictException("An account with this email already exists");
    }

    const passwordHash = await hashPassword(input.password);
    const user = existing
      ? // Unverified re-registration: refresh details, keep the same account.
        await this.db.user.update({
          where: { id: existing.id },
          data: { name: input.name, phone: input.phone, passwordHash },
        })
      : await this.db.user.create({
          data: { name: input.name, email, phone: input.phone, passwordHash },
        });

    const { devCode } = await this.otp.issue(email, "email_verification", user.id);
    return { userId: user.id, devOtp: devCode };
  }

  /** Verifies the registration OTP and signs the new owner in. */
  async verifyRegistration(
    input: { email: string; code: string },
    meta?: { ip?: string; userAgent?: string },
  ): Promise<{ user: AuthenticatedUser; tokens: TokenPair }> {
    const email = input.email.toLowerCase();
    const user = await this.db.user.findUnique({ where: { email } });
    if (!user) {
      throw new UnauthorizedException("Account not found");
    }

    await this.otp.verify(email, "email_verification", input.code);

    await this.db.user.update({
      where: { id: user.id },
      data: { emailVerifiedAt: user.emailVerifiedAt ?? new Date(), lastLoginAt: new Date() },
    });

    const tokens = await this.tokens.issueTokenPair(user, meta);
    return { user: await this.describe(user.id), tokens };
  }

  async resendRegistrationOtp(email: string): Promise<{ devOtp?: string }> {
    const user = await this.db.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user || user.emailVerifiedAt) {
      // Do not disclose whether the account exists.
      return {};
    }
    const { devCode } = await this.otp.issue(user.email, "email_verification", user.id);
    return { devOtp: devCode };
  }

  /** Issues a password-reset OTP. Silent no-op for unknown/unverified emails — never discloses account existence. */
  async forgotPassword(email: string): Promise<{ devOtp?: string }> {
    const user = await this.db.user.findUnique({ where: { email: email.toLowerCase() } });
    if (!user || !user.emailVerifiedAt || !user.isActive) {
      return {};
    }
    const { devCode } = await this.otp.issue(user.email, "password_reset", user.id);
    return { devOtp: devCode };
  }

  /**
   * Verifies the reset code and sets a new password. Revokes every existing
   * refresh-token family so a stolen session can't survive a reset.
   */
  async resetPassword(input: { email: string; code: string; newPassword: string }): Promise<void> {
    const email = input.email.toLowerCase();
    const user = await this.db.user.findUnique({ where: { email } });
    if (!user) {
      throw new UnauthorizedException("Invalid or expired code");
    }

    await this.otp.verify(email, "password_reset", input.code);

    const passwordHash = await hashPassword(input.newPassword);
    await this.db.user.update({
      where: { id: user.id },
      data: { passwordHash, failedLoginAttempts: 0, lockedUntil: null },
    });
    await this.db.refreshToken.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async login(
    input: { email: string; password: string },
    meta?: { ip?: string; userAgent?: string },
  ): Promise<{ user: AuthenticatedUser; tokens: TokenPair }> {
    const user = await this.db.user.findUnique({
      where: { email: input.email.toLowerCase() },
    });
    // Uniform error for unknown email / wrong password — no account enumeration.
    if (!user || !user.isActive || user.deletedAt) {
      throw new UnauthorizedException("Invalid email or password");
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new ForbiddenException(
        "Account temporarily locked after repeated failed attempts — try again later",
      );
    }

    const valid = await verifyPassword(input.password, user.passwordHash);
    if (!valid) {
      const failed = user.failedLoginAttempts + 1;
      await this.db.user.update({
        where: { id: user.id },
        data: {
          failedLoginAttempts: failed,
          lockedUntil:
            failed >= MAX_FAILED_LOGINS
              ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000)
              : null,
        },
      });
      throw new UnauthorizedException("Invalid email or password");
    }

    if (!user.emailVerifiedAt) {
      throw new ForbiddenException("Email not verified — complete registration first");
    }

    await this.db.user.update({
      where: { id: user.id },
      data: { failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
    });

    const tokens = await this.tokens.issueTokenPair(user, meta);
    return { user: await this.describe(user.id), tokens };
  }

  async refresh(
    refreshToken: string,
    meta?: { ip?: string; userAgent?: string },
  ): Promise<TokenPair> {
    return this.tokens.rotateRefreshToken(refreshToken, meta);
  }

  async logout(refreshToken: string): Promise<void> {
    await this.tokens.revokeByToken(refreshToken);
  }

  /** Current user snapshot for the dashboard boot (`GET /auth/me`). */
  async describe(userId: string): Promise<AuthenticatedUser> {
    const user = await this.db.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, name: true, email: true },
    });
    const auth = await this.tokens.resolveAuthContext(userId);
    return { ...user, ...auth };
  }
}
