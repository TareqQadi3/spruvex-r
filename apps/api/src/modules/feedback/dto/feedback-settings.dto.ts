import { IsInt, Max, Min } from "class-validator";

/** Bounds: at least 1 minute (never send instantly), at most 24h (still a
 * same-day nudge — an "even later" request stops being about this order). */
export class UpdateFeedbackSettingsDto {
  @IsInt()
  @Min(1)
  @Max(1440)
  feedbackDelayMinutes!: number;
}
