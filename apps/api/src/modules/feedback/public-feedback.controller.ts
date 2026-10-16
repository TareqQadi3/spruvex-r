import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";

import { Public } from "../../shared/rbac/public.decorator";
import { SubmitFeedbackDto } from "./dto/submit-feedback.dto";
import { FeedbackService } from "./feedback.service";

/**
 * Guest-accessible feedback page data/submission — the same link the
 * "order_feedback_request" WhatsApp message points to. The request id is
 * an unguessable UUID (same capability-token pattern as /public/receipts/:id
 * and /public/orders/:orderId/track), so no separate auth is needed.
 */
@Public()
@UseGuards(ThrottlerGuard)
@Controller("public/feedback")
export class PublicFeedbackController {
  constructor(private readonly feedback: FeedbackService) {}

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get(":id")
  get(@Param("id", ParseUUIDPipe) id: string) {
    return this.feedback.getPublic(id);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post(":id")
  submit(@Param("id", ParseUUIDPipe) id: string, @Body() dto: SubmitFeedbackDto) {
    return this.feedback.submit(id, dto.rating, dto.comment);
  }
}
