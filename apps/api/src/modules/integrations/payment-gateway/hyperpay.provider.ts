import { BadRequestException, Injectable } from "@nestjs/common";

import type {
  CheckoutSession,
  CreateCheckoutParams,
  GatewayWebhookEvent,
  PaymentGatewayProvider,
} from "./payment-gateway.interface";

/**
 * HyperPay is deliberately structural-only in this build: connection
 * settings (entity id, access token) can be saved from day one, but actual
 * checkout is NOT wired up. HyperPay's "Copy&Pay" flow needs a widget
 * script embedded on a dedicated checkout page (POST /v1/checkouts for a
 * checkout id, then load paymentWidgets.js with that id client-side) rather
 * than a simple server-created redirect URL like Moyasar/Tap — a real
 * checkout PAGE needs building in apps/ordering before this can go live,
 * not just a backend adapter. Surfaced to the tenant as "coming soon"; pick
 * Moyasar or Tap for now if you want digital-menu payments live today.
 */
@Injectable()
export class HyperpayProvider implements PaymentGatewayProvider {
  readonly key = "hyperpay" as const;
  readonly isCheckoutSupported = false;

  createCheckout(_params: CreateCheckoutParams): Promise<CheckoutSession> {
    throw new BadRequestException(
      "HyperPay checkout isn't wired up yet in this build (its Copy&Pay flow needs a dedicated widget page) — choose Moyasar or Tap for now.",
    );
  }

  verifyWebhook(): boolean {
    return false;
  }

  parseWebhookEvent(_body: unknown): GatewayWebhookEvent {
    throw new BadRequestException("HyperPay webhooks aren't wired up yet in this build.");
  }
}
