import type { PaymentGatewayProviderKey } from "@spruvex-r/types";

export interface CreateCheckoutParams {
  /** Our own order id — round-tripped through the gateway as metadata so the webhook can match it back. */
  orderId: string;
  /** VAT-inclusive amount, SAR. */
  amount: string;
  description: string;
  successUrl: string;
  failureUrl: string;
  secretKey: string;
  environment: "test" | "live";
  /** Extra non-secret config from the connection row (e.g. Moyasar publishable key echoed to the client, if ever needed). */
  config: Record<string, unknown>;
}

export interface CheckoutSession {
  /** The gateway's own checkout/invoice/charge id. */
  gatewaySessionId: string;
  /** Where to redirect the customer to complete payment. */
  redirectUrl: string;
}

export interface GatewayWebhookEvent {
  orderId: string;
  success: boolean;
  gatewayReference: string;
  /** Gateway-reported amount, SAR, when present — cross-checked against the order, never trusted alone for pricing. */
  amount?: string;
}

export interface PaymentGatewayProvider {
  readonly key: PaymentGatewayProviderKey;
  /** Whether this provider's checkout+webhook flow is actually wired up (vs. connection settings only, still needing further work). */
  readonly isCheckoutSupported: boolean;

  createCheckout(params: CreateCheckoutParams): Promise<CheckoutSession>;

  verifyWebhook(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
    webhookSecret: string,
  ): boolean;

  /** Parses an already-verified webhook body. Throws on anything malformed. */
  parseWebhookEvent(body: unknown): GatewayWebhookEvent;
}
