import { Body, Controller, Get, Patch } from "@nestjs/common";

import { RequirePermission } from "../../../shared/rbac/require-permission.decorator";
import { UpdateZatcaSettingsDto } from "./dto/zatca-settings.dto";
import { ZatcaSettingsService } from "./zatca-settings.service";

/**
 * Per-tenant ZATCA Phase 2 opt-in — owner/manager decides when their
 * restaurant actually needs full e-invoicing integration (revenue-wave
 * thresholds roll out gradually; Phase 1's QR-only invoice already
 * satisfies every tenant that isn't in-wave yet).
 */
@Controller("tenant/zatca-settings")
export class ZatcaSettingsController {
  constructor(private readonly settings: ZatcaSettingsService) {}

  @RequirePermission("tenant.settings.manage")
  @Get()
  get() {
    return this.settings.get();
  }

  @RequirePermission("tenant.settings.manage")
  @Patch()
  update(@Body() dto: UpdateZatcaSettingsDto) {
    return this.settings.update(dto);
  }
}
