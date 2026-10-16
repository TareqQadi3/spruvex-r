import { Module } from "@nestjs/common";

import { IntegrationsModule } from "../integrations/integrations.module";
import { FeedbackOrderListener } from "./feedback-order.listener";
import { FeedbackSettingsController } from "./feedback-settings.controller";
import { FeedbackService } from "./feedback.service";
import { PublicFeedbackController } from "./public-feedback.controller";

/**
 * Post-order WhatsApp rating requests (see FeedbackService's doc comment
 * for the full lifecycle) — reuses the existing WhatsApp integration as its
 * delivery channel rather than building a second one.
 */
@Module({
  imports: [IntegrationsModule],
  controllers: [PublicFeedbackController, FeedbackSettingsController],
  providers: [FeedbackService, FeedbackOrderListener],
})
export class FeedbackModule {}
