import { Body, Controller, Get, Patch, Query, UseGuards } from "@nestjs/common";

import { PlatformSettingsService } from "../../shared/platform-settings/platform-settings.service";
import { PlatformPrismaService } from "../../shared/prisma/platform-prisma.service";
import { Public } from "../../shared/rbac/public.decorator";
import { CurrentPlatformAdmin } from "./current-platform-admin.decorator";
import { UpdatePlatformSettingsDto } from "./dto/platform-settings.dto";
import { PlatformAdminGuard } from "./platform-admin.guard";

/**
 * Platform-wide settings — same auth plane as the rest of the ops console
 * (@Public() + PlatformAdminGuard; see PlatformController's doc comment).
 * There is no finer-grained permission here because PlatformAdmin has no
 * role/permission subdivision anywhere in this system today — every
 * platform admin is equally privileged, so "platform.settings.manage" is
 * this guard, not a Permission catalog entry (that catalog is exclusively
 * for tenant RBAC and PlatformAdminGuard never consults it).
 */
@Public()
@UseGuards(PlatformAdminGuard)
@Controller("platform/settings")
export class PlatformSettingsController {
  constructor(
    private readonly settings: PlatformSettingsService,
    private readonly platformDb: PlatformPrismaService,
  ) {}

  @Get()
  get() {
    return this.settings.getSettings();
  }

  @Patch()
  update(@Body() dto: UpdatePlatformSettingsDto, @CurrentPlatformAdmin() admin: { id: string; email: string }) {
    return this.settings.updateSettings(dto, admin);
  }

  /** Who changed what, and when — the read side of PlatformSettingsService's audit trail. */
  @Get("audit-log")
  auditLog(@Query("limit") limit?: string) {
    const take = Math.min(Math.max(Number(limit) || 50, 1), 200);
    return this.platformDb.platformAuditLog.findMany({
      orderBy: { createdAt: "desc" },
      take,
      include: { platformAdmin: { select: { name: true, email: true } } },
    });
  }
}
