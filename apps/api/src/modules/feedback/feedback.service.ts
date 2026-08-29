import { ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";

import { WhatsappService } from "../integrations/whatsapp/whatsapp.service";
import { PlatformPrismaService } from "../../shared/prisma/platform-prisma.service";
import { PrismaService } from "../../shared/prisma/prisma.service";
import { GUEST_ACTOR, TenantContextService } from "../../shared/tenancy/tenant-context.service";

/** Real-world tuning, not a magic constant needing config: ~30 minutes gives
 * the customer time to actually finish eating/using the order before being
 * asked to rate it. */
const FEEDBACK_DELAY_MS = 30 * 60 * 1000;
const SEND_POLL_INTERVAL_MS = 60_000;
const MAX_PER_POLL = 50;

function orderingBaseUrl(): string {
  return (process.env.ORDERING_BASE_URL ?? "http://localhost:5174").replace(/\/+$/, "");
}

/**
 * Post-order WhatsApp rating request lifecycle:
 * 1. FeedbackOrderListener creates one row per completed order (sendAfter =
 *    now + 30min);
 * 2. sendDueRequests polls every minute for rows whose sendAfter has
 *    passed and sends the "order_feedback_request" WhatsApp template,
 *    whose link points at the public feedback page this service also
 *    serves;
 * 3. the customer answers through that capability-token link (the row's
 *    own id — same convention as Receipt/public order tracking).
 *
 * The @Interval poller is a single-process in-memory timer (via
 * @nestjs/schedule) — correct for this deployment's single API instance;
 * running more than one API replica would need a real job queue (e.g.
 * BullMQ) with a distributed lock instead, to avoid every replica sending
 * the same request. Documented here rather than built speculatively.
 */
@Injectable()
export class FeedbackService {
  private readonly logger = new Logger(FeedbackService.name);

  constructor(
    private readonly platformDb: PlatformPrismaService,
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly whatsapp: WhatsappService,
  ) {}

  /** Idempotent — orderId is unique, so a duplicate event is a silent no-op. */
  async createRequestForCompletedOrder(tenantId: string, branchId: string, orderId: string): Promise<void> {
    await this.tenantContext.run(
      { userId: GUEST_ACTOR, tenantId, branchId, permissions: new Set() },
      async () => {
        const existing = await this.prisma.scoped.orderFeedbackRequest.findUnique({ where: { orderId } });
        if (existing) return;

        const topItem = await this.prisma.scoped.orderItem.findFirst({
          where: { orderId },
          orderBy: { lineTotal: "desc" },
          select: { productId: true },
        });

        await this.prisma.scoped.orderFeedbackRequest.create({
          data: {
            tenantId,
            branchId,
            orderId,
            primaryProductId: topItem?.productId,
            sendAfter: new Date(Date.now() + FEEDBACK_DELAY_MS),
          },
        });
      },
    );
  }

  @Interval(SEND_POLL_INTERVAL_MS)
  async sendDueRequests(): Promise<void> {
    const due = await this.platformDb.orderFeedbackRequest.findMany({
      where: { sentAt: null, sendAfter: { lte: new Date() } },
      take: MAX_PER_POLL,
      select: {
        id: true,
        orderId: true,
        order: { select: { orderNumber: true, customerPhone: true, customerName: true } },
        tenant: { select: { name: true } },
      },
    });

    for (const request of due) {
      try {
        if (request.order.customerPhone) {
          await this.whatsapp.sendTemplate("order_feedback_request", request.order.customerPhone, {
            customerName: request.order.customerName ?? "",
            orderNumber: String(request.order.orderNumber),
            restaurantName: request.tenant.name,
            feedbackLink: `${orderingBaseUrl()}/feedback/${request.id}`,
          });
        }
      } catch (error) {
        this.logger.warn(
          `Feedback request send failed for order ${request.orderId}: ${(error as Error).message}`,
        );
      } finally {
        // Marked sent either way — no phone number or a send failure both
        // mean "don't keep retrying this one forever"; WhatsappService
        // itself already logs/records connection errors when relevant.
        await this.platformDb.orderFeedbackRequest.update({
          where: { id: request.id },
          data: { sentAt: new Date() },
        });
      }
    }
  }

  /** Public: minimal info for the feedback page. */
  async getPublic(id: string) {
    const request = await this.platformDb.orderFeedbackRequest.findFirst({
      where: { id },
      select: {
        id: true,
        rating: true,
        order: { select: { orderNumber: true } },
        tenant: { select: { name: true, nameEn: true, logoUrl: true, defaultLocale: true } },
      },
    });
    if (!request) {
      throw new NotFoundException("Feedback request not found");
    }
    return {
      id: request.id,
      orderNumber: request.order.orderNumber,
      alreadyRated: request.rating !== null,
      restaurant: request.tenant,
    };
  }

  /** Public: submit the rating — a link can only be answered once. */
  async submit(id: string, rating: number, comment: string | undefined) {
    const request = await this.platformDb.orderFeedbackRequest.findFirst({ where: { id } });
    if (!request) {
      throw new NotFoundException("Feedback request not found");
    }
    if (request.rating !== null) {
      throw new ConflictException("This feedback request has already been answered");
    }

    await this.tenantContext.run(
      { userId: GUEST_ACTOR, tenantId: request.tenantId, branchId: request.branchId, permissions: new Set() },
      () =>
        this.prisma.scoped.orderFeedbackRequest.update({
          where: { id },
          data: { rating, comment, ratedAt: new Date() },
        }),
    );
    return { thankYou: true };
  }
}
