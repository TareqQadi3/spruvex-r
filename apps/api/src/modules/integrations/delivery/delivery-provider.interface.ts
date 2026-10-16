import type { DeliveryProviderKey } from "@spruvex-r/types";

export interface DeliveryOrderLine {
  /** The platform's own item id — resolved to an internal productId via DeliveryProductMapping. */
  externalItemId: string;
  externalItemName?: string;
  quantity: number;
}

/** Generic shape every provider's webhook payload gets normalized into before it ever reaches OrderingService. */
export interface DeliveryWebhookOrder {
  externalOrderId: string;
  /** The platform's own store/branch identifier — resolved against IntegrationConnection.config.externalStoreId. */
  externalStoreId?: string;
  customerName?: string;
  customerPhone?: string;
  lines: DeliveryOrderLine[];
  /** Platform-reported commission for this order, SAR — recorded on the order, never trusted for pricing. */
  commission?: string;
}

export interface DeliveryProvider {
  readonly key: DeliveryProviderKey;

  /**
   * Verifies the raw request genuinely came from this provider, using the
   * connection's own webhook secret. MUST run before parseOrder — never
   * trust webhook content from an unverified request.
   */
  verifySignature(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
    webhookSecret: string,
  ): boolean;

  /** Parses an already-verified webhook body into the generic order shape. Throws on anything malformed. */
  parseOrder(body: unknown): DeliveryWebhookOrder;

  /** Response body some platforms expect back to confirm the order was accepted. */
  buildAckResponse(externalOrderId: string): unknown;
}
