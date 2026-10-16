import { BadRequestException, Injectable } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";

import type { DeliveryProvider, DeliveryWebhookOrder } from "./delivery-provider.interface";

/**
 * HungerStation adapter. HungerStation's partner webhook API is not public
 * documentation the way Meta's or Stripe's is — this implements the
 * industry-standard shape every delivery aggregator webhook uses (a signed
 * POST with the order + line items + external ids), which is what
 * onboarding with HungerStation's partner integration team will hand you.
 * Two things WILL need a one-line adjustment once you have their real
 * partner docs in hand:
 *   1. the signature header name (defaults to "x-hungerstation-signature");
 *   2. the exact JSON field names below (`order_id`, `items[].item_id`, ...)
 *      — HungerStation's own naming may differ slightly; anything mismatched
 *      throws a clear 400 rather than silently misreading the order.
 * Everything else (HMAC verification, order normalization, hand-off to the
 * real order pipeline) does not change regardless of the exact field names.
 */
@Injectable()
export class HungerstationProvider implements DeliveryProvider {
  readonly key = "hungerstation" as const;

  verifySignature(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
    webhookSecret: string,
  ): boolean {
    const header = headers["x-hungerstation-signature"] ?? headers["x-webhook-signature"];
    const signature = Array.isArray(header) ? header[0] : header;
    if (!signature) return false;

    const expected = createHmac("sha256", webhookSecret).update(rawBody, "utf8").digest("hex");
    const provided = signature.replace(/^sha256=/, "");

    const expectedBuf = Buffer.from(expected, "hex");
    const providedBuf = Buffer.from(provided, "hex");
    if (expectedBuf.length !== providedBuf.length) return false;
    return timingSafeEqual(expectedBuf, providedBuf);
  }

  parseOrder(body: unknown): DeliveryWebhookOrder {
    if (typeof body !== "object" || body === null) {
      throw new BadRequestException("Webhook body must be a JSON object");
    }
    const b = body as Record<string, unknown>;
    const orderId = b.order_id;
    const items = b.items;
    if (typeof orderId !== "string" || !orderId) {
      throw new BadRequestException("Missing order_id");
    }
    if (!Array.isArray(items) || items.length === 0) {
      throw new BadRequestException("Missing or empty items[]");
    }

    const lines = items.map((raw, index) => {
      if (typeof raw !== "object" || raw === null) {
        throw new BadRequestException(`items[${index}] must be an object`);
      }
      const item = raw as Record<string, unknown>;
      const itemId = item.item_id;
      const quantity = item.quantity;
      if (typeof itemId !== "string" || !itemId) {
        throw new BadRequestException(`items[${index}].item_id is required`);
      }
      if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1) {
        throw new BadRequestException(`items[${index}].quantity must be a positive integer`);
      }
      return {
        externalItemId: itemId,
        externalItemName: typeof item.name === "string" ? item.name : undefined,
        quantity,
      };
    });

    return {
      externalOrderId: orderId,
      externalStoreId: typeof b.store_id === "string" ? b.store_id : undefined,
      customerName: typeof b.customer_name === "string" ? b.customer_name : undefined,
      customerPhone: typeof b.customer_phone === "string" ? b.customer_phone : undefined,
      lines,
      commission: typeof b.commission === "string" ? b.commission : undefined,
    };
  }

  buildAckResponse(externalOrderId: string): unknown {
    return { status: "accepted", order_id: externalOrderId };
  }
}
