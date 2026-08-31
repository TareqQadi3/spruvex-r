import { Module } from "@nestjs/common";

import { PlatformAdminGuard } from "./platform-admin.guard";
import { PlatformAuthController } from "./platform-auth.controller";
import { PlatformAuthService } from "./platform-auth.service";
import { PlatformController } from "./platform.controller";
import { PlatformService } from "./platform.service";
import { PlatformSettingsController } from "./platform-settings.controller";

/**
 * SpruVex ops console (Phase 8) — entirely separate auth plane from tenant
 * RBAC (see PlatformAdminGuard / platform-admin-token.ts docs).
 */
@Module({
  controllers: [PlatformAuthController, PlatformController, PlatformSettingsController],
  providers: [PlatformAuthService, PlatformService, PlatformAdminGuard],
})
export class PlatformModule {}
