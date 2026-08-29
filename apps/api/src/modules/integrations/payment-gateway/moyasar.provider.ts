import { BadRequestException, Injectable } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";

import { sarToHalalas } from "../../../shared/common/money";
import type {
  CheckoutSession,
  CreateCheckoutParams,
  GatewayWebhookEvent,
  PaymentGatewayProvider,
} from "./payment-gateway.interface";

const BASE_URL = "https://api.moyasar.com/v1";

/**
 * Moyasar adapter, built against Moyasar's public REST docs (Invoices API
 * for a hosted checkout redirect, Basic Auth with the secret key as
 * username). Structured correctly but never exercised against a real
 * Moyasar account in this build — no live test credentials were available.
 * Smoke-test against Moyasar's test-mode keys before relying on it in
 * production; the webhook verification below assumes Moyasar echoes back
 * the merchant-configured "Secret Token" as a `secret_token` field in the
 * webhook body itself (their documented mechanism, distinct from an
 * HMAC-signed header) — confirm that's still current in Moyasar's dashboard
 * before going live.
 */
@Injectable()
export class MoyasarProvider implements PaymentGatewayProvider {
  readonly key = "moyasar" as const;
  readonly isCheckoutSupported = true;

  async createCheckout(params: CreateCheckoutParams): Promise<CheckoutSession> {
    const res = await fetch(`${BASE_URL}/invoices`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic " + Buffer.from(`${params.secretKey}:`).toString("base64"),
      },
      body: JSON.stringify({
        amount: sarToHalalas(params.amount),
        currency: "SAR",
        description: params.description,
        success_url: params.successUrl,
        back_url: params.failureUrl,
        metadata: { order_id: params.orderId },
      }),
    });
    const json = (await res.json().catch(() => null)) as
      | { id?: string; url?: string; message?: string }
      | null;
    if (!res.ok || !json?.id || !json.url) {
      throw new BadRequestException(
        `Moyasar checkout creation failed: ${json?.message ?? res.statusText}`,
      );
    }
    return { gatewaySessionId: json.id, redirectUrl: json.url };
  }

  verifyWebhook(
    rawBody: string,
    _headers: Record<string, string | string[] | undefined>,
    webhookSecret: string,
  ): boolean {
    let body: { secret_token?: unknown } | null = null;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return false;
    }
    const provided = typeof body?.secret_token === "string" ? body.secret_token : "";
    if (!provided) return false;

    // Hash both sides to a fixed length first, so a constant-time compare
    // never short-circuits on a length mismatch either.
    const expectedHash = createHmac("sha256", "moyasar-webhook").update(webhookSecret, "utf8").digest();
    const providedHash = createHmac("sha256", "moyasar-webhook").update(provided, "utf8").digest();
    return timingSafeEqual(expectedHash, providedHash);
  }

  parseWebhookEvent(body: unknown): GatewayWebhookEvent {
    if (typeof body !== "object" || body === null) {
      throw new BadRequestException("Webhook body must be a JSON object");
    }
    const b = body as Record<string, unknown>;
    const data = (b.data ?? b) as Record<string, unknown>;
    const metadata = (data.metadata ?? {}) as Record<string, unknown>;
    const orderId = metadata.order_id;
    if (typeof orderId !== "string" || !orderId) {
      throw new BadRequestException("Missing metadata.order_id");
    }
    const status = data.status;
    const id = data.id;
    if (typeof id !== "string") {
      throw new BadRequestException("Missing payment id");
    }
    return {
      orderId,
      success: status === "paid",
      gatewayReference: id,
      amount: typeof data.amount === "number" ? (data.amount / 100).toFixed(2) : undefined,
    };
  }
}
