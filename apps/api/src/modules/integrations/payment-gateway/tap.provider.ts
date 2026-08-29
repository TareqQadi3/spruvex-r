import { BadRequestException, Injectable } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";

import type {
  CheckoutSession,
  CreateCheckoutParams,
  GatewayWebhookEvent,
  PaymentGatewayProvider,
} from "./payment-gateway.interface";

const BASE_URL = "https://api.tap.company/v2";

/**
 * Tap Payments adapter, built against Tap's public REST docs (Charges API
 * with a hosted redirect `source: { id: "src_all" }`). Structured correctly
 * but never exercised against a real Tap account in this build — no live
 * test credentials were available. Smoke-test against Tap's test-mode keys
 * before relying on it in production; the webhook `hashstring` verification
 * below reproduces Tap's documented field concatenation as best recalled —
 * confirm the exact field order against Tap's current webhook docs, since
 * that's the single most likely thing to have drifted.
 */
@Injectable()
export class TapProvider implements PaymentGatewayProvider {
  readonly key = "tap" as const;
  readonly isCheckoutSupported = true;

  async createCheckout(params: CreateCheckoutParams): Promise<CheckoutSession> {
    const res = await fetch(`${BASE_URL}/charges`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.secretKey}`,
      },
      body: JSON.stringify({
        amount: Number(params.amount),
        currency: "SAR",
        description: params.description,
        source: { id: "src_all" },
        redirect: { url: params.successUrl },
        post: { url: params.failureUrl },
        metadata: { order_id: params.orderId },
      }),
    });
    const json = (await res.json().catch(() => null)) as
      | { id?: string; transaction?: { url?: string }; message?: string }
      | null;
    const redirectUrl = json?.transaction?.url;
    if (!res.ok || !json?.id || !redirectUrl) {
      throw new BadRequestException(`Tap checkout creation failed: ${json?.message ?? res.statusText}`);
    }
    return { gatewaySessionId: json.id, redirectUrl };
  }

  verifyWebhook(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
    webhookSecret: string,
  ): boolean {
    const header = headers.hashstring;
    const provided = Array.isArray(header) ? header[0] : header;
    if (!provided) return false;

    let body: Record<string, unknown> | null = null;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return false;
    }
    if (!body) return false;

    const field = (key: string) => String(body?.[key] ?? "");
    const toHash =
      `x_id${field("id")}` +
      `x_amount${field("amount")}` +
      `x_currency${field("currency")}` +
      `x_gateway_reference${field("gateway_reference")}` +
      `x_payment_reference${field("payment_reference")}` +
      `x_status${field("status")}` +
      `x_created${field("created")}`;
    const expected = createHmac("sha256", webhookSecret).update(toHash, "utf8").digest("hex");

    const expectedBuf = Buffer.from(expected, "hex");
    const providedBuf = Buffer.from(provided, "hex");
    if (expectedBuf.length !== providedBuf.length) return false;
    return timingSafeEqual(expectedBuf, providedBuf);
  }

  parseWebhookEvent(body: unknown): GatewayWebhookEvent {
    if (typeof body !== "object" || body === null) {
      throw new BadRequestException("Webhook body must be a JSON object");
    }
    const b = body as Record<string, unknown>;
    const metadata = (b.metadata ?? {}) as Record<string, unknown>;
    const orderId = metadata.order_id;
    if (typeof orderId !== "string" || !orderId) {
      throw new BadRequestException("Missing metadata.order_id");
    }
    const id = b.id;
    if (typeof id !== "string") {
      throw new BadRequestException("Missing charge id");
    }
    return {
      orderId,
      success: b.status === "CAPTURED",
      gatewayReference: id,
      amount: typeof b.amount === "number" ? b.amount.toFixed(2) : undefined,
    };
  }
}
