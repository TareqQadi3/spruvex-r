import { Injectable, UnauthorizedException } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";

import { PlatformPrismaService } from "../../shared/prisma/platform-prisma.service";
import { TokenService, type TokenPair } from "./token.service";

const HANDOFF_TTL_MINUTES = 15;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * One-time handoff tokens — the bridge that lets the marketing site hand a
 * freshly-verified merchant to the dashboard ALREADY SIGNED IN (closes the
 * "no auto-login after OTP" gap, HANDOFF §7.4). The token is an opaque
 * random secret stored hashed with a short TTL and single-use semantics;
 * exchanging it twice fails closed. Not a JWT — it must be revocable and
 * consumable exactly once, which a database row guarantees.
 */
@Injectable()
export class HandoffService {
  constructor(
    private readonly db: PlatformPrismaService,
    private readonly tokens: TokenService,
  ) {}

  /** Issues a single-use handoff token for a verified user (TTL 15 min). */
  async issue(userId: string): Promise<{ token: string; expiresInSeconds: number }> {
    const token = randomBytes(48).toString("base64url");
    await this.db.handoffToken.create({
      data: {
        userId,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + HANDOFF_TTL_MINUTES * 60 * 1000),
      },
    });
    return { token, expiresInSeconds: HANDOFF_TTL_MINUTES * 60 };
  }

  /**
   * Exchanges a handoff token for a full session (access + refresh pair).
   * Single use: consuming marks the row; replaying the same token fails.
   * Unknown/expired/consumed tokens are indistinguishable from the caller's
   * perspective — no information about valid outstanding tokens leaks.
   */
  async exchange(
    token: string,
    meta?: { ip?: string; userAgent?: string },
  ): Promise<{ tokens: TokenPair }> {
    const record = await this.db.handoffToken.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: { select: { id: true, email: true, isActive: true } } },
    });
    if (
      !record ||
      record.consumedAt ||
      record.expiresAt < new Date() ||
      !record.user.isActive
    ) {
      throw new UnauthorizedException("Invalid or expired sign-in link");
    }

    // Consume FIRST, then issue — a concurrent replay of the same token hits
    // the consumedAt guard instead of minting two sessions.
    const consumed = await this.db.handoffToken.updateMany({
      where: { id: record.id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (consumed.count === 0) {
      throw new UnauthorizedException("Invalid or expired sign-in link");
    }

    const tokens = await this.tokens.issueTokenPair(record.user, meta);
    return { tokens };
  }
}