import { Body, Controller, Get, Patch } from "@nestjs/common";

import { RequirePermission } from "../../shared/rbac/require-permission.decorator";
import { UpdateFeedbackSettingsDto } from "./dto/feedback-settings.dto";
import { FeedbackService } from "./feedback.service";

/**
 * Tenant-editable feedback timing — gated by the same generic
 * tenant.settings.manage permission TenancyController uses for the
 * restaurant-profile settings, so every tenant-level setting shares one
 * permission rather than a settings sub-object per module needing its own
 * (unlike purchases.settings, which predates this convention and reuses
 * purchases.create instead — left as-is, out of this change's scope).
 */
@RequirePermission("tenant.settings.manage")
@Controller("feedback/settings")
export class FeedbackSettingsController {
  constructor(private readonly feedback: FeedbackService) {}

  @Get()
  get() {
    return this.feedback.getSettings();
  }

  @Patch()
  update(@Body() dto: UpdateFeedbackSettingsDto) {
    return this.feedback.updateSettings(dto);
  }
}
