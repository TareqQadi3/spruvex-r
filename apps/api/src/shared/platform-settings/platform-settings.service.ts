import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";

import { PlatformPrismaService } from "../prisma/platform-prisma.service";
import {
  PLATFORM_SETTINGS_DEFAULTS,
  PLATFORM_SETTINGS_SINGLETON_ID,
  type PlatformSettingsShape,
} from "./platform-settings.types";

/**
 * Platform-wide (not per-tenant) settings: OTP/lockout policy shared by both
 * tenant-user login (identity/auth.service.ts) and platform-admin login
 * (platform/platform-auth.service.ts), plus the default upload-size ceiling.
 * Read via the admin connection everywhere — every consumer (OtpService,
 * AuthService, PlatformAuthService, UploadsService) already only had
 * PlatformPrismaService or no DB dependency at all, so this never needed
 * (and must never gain) a tenant-scoped read path; the app role has no
 * grants on this table at all (see this migration's REVOKE).
 */
@Injectable()
export class PlatformSettingsService {
  constructor(private readonly db: PlatformPrismaService) {}

  async getSettings(): Promise<PlatformSettingsShape> {
    const row = await this.db.platformSettings.findUnique({
      where: { id: PLATFORM_SETTINGS_SINGLETON_ID },
    });
    return { ...PLATFORM_SETTINGS_DEFAULTS, ...(row?.settings as Partial<PlatformSettingsShape> | undefined) };
  }

  /**
   * Merges `patch` over the current settings and writes the whole row.
   * Audits only the keys that actually changed, each with its old and new
   * value — the append-only platform_audit_logs is the only "who changed
   * what, and when" trail for a platform-wide setting (AuditLog can't record
   * this: its tenantId is NOT NULL).
   */
  async updateSettings(
    patch: Partial<PlatformSettingsShape>,
    admin: { id: string; email: string },
  ): Promise<PlatformSettingsShape> {
    const before = await this.getSettings();
    // A DTO instance can carry every declared field as an own property, set
    // to `undefined` for whatever the request didn't send (TS class-field
    // define semantics) — blindly spreading that over `before` would
    // overwrite untouched settings with `undefined`. Keep only the keys the
    // caller actually sent a real value for.
    const definedPatch = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    ) as Partial<PlatformSettingsShape>;
    const after: PlatformSettingsShape = { ...before, ...definedPatch };

    await this.db.platformSettings.upsert({
      where: { id: PLATFORM_SETTINGS_SINGLETON_ID },
      create: { id: PLATFORM_SETTINGS_SINGLETON_ID, settings: after as unknown as Prisma.InputJsonValue, updatedBy: admin.id },
      update: { settings: after as unknown as Prisma.InputJsonValue, updatedBy: admin.id },
    });

    const changedKeys = (Object.keys(definedPatch) as (keyof PlatformSettingsShape)[]).filter(
      (key) => before[key] !== after[key],
    );
    if (changedKeys.length > 0) {
      await this.db.platformAuditLog.create({
        data: {
          platformAdminId: admin.id,
          action: "platform.settings_updated",
          entityType: "platform_settings",
          entityId: PLATFORM_SETTINGS_SINGLETON_ID,
          meta: {
            changes: Object.fromEntries(changedKeys.map((key) => [key, { from: before[key], to: after[key] }])),
            platformAdminEmail: admin.email,
          },
        },
      });
    }

    return after;
  }
}
