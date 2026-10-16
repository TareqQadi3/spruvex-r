import { Controller, Get, NotFoundException, Param, ParseUUIDPipe, UseGuards } from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";

import { Public } from "../../shared/rbac/public.decorator";
import { PlatformPrismaService } from "../../shared/prisma/platform-prisma.service";

/**
 * Guest-accessible hosted invoice page data — the same link a "invoice
 * sent" WhatsApp message points to. The receipt id is an unguessable UUID
 * (same capability-token pattern as /public/orders/:orderId/track), so no
 * separate auth is needed; the platform (BYPASSRLS) connection is used
 * because there's no tenant context to enter for a single anonymous read.
 */
@Public()
@UseGuards(ThrottlerGuard)
@Controller("public/receipts")
export class PublicReceiptController {
  constructor(private readonly platformDb: PlatformPrismaService) {}

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get(":id")
  async get(@Param("id", ParseUUIDPipe) id: string) {
    const receipt = await this.platformDb.receipt.findFirst({
      where: { id },
      select: {
        id: true,
        receiptNumber: true,
        vatRate: true,
        vatAmount: true,
        total: true,
        issuedAt: true,
        qrPayload: true,
        payload: true,
      },
    });
    if (!receipt) {
      throw new NotFoundException("Receipt not found");
    }
    return receipt;
  }
}
