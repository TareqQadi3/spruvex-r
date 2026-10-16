import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import { decryptSecret, INTEGRATIONS_VAULT_NAMESPACE } from "../../../shared/security/crypto-vault";
import { PlatformPrismaService } from "../../../shared/prisma/platform-prisma.service";
import { GUEST_ACTOR, TenantContextService } from "../../../shared/tenancy/tenant-context.service";
import { ConnectionsService } from "../connections.service";
import { OnlinePaymentService } from "../online-payment.service";
import { HyperpayProvider } from "./hyperpay.provider";
import { MoyasarProvider } from "./moyasar.provider";
import type { PaymentGatewayProvider } from "./payment-gateway.interface";
import { TapProvider } from "./tap.provider";

function orderingBaseUrl(): string {
  return (process.env.ORDERING_BASE_URL ?? "http://localhost:5174").replace(/\/+$/, "");
}

/**
 * Creates a hosted checkout for an ALREADY-CREATED order (the guest ordering
 * flow's own /public/.../orders endpoint is completely unchanged — this is
 * an optional add-on step after that) and, on the gateway's webhook,
 * completes that same order through the real payment/order pipeline. If
 * checkout creation fails for any reason, the order simply stays exactly as
 * it would without this feature (pay on pickup) — nothing about the base
 * ordering flow depends on this succeeding.
 */
@Injectable()
export class GatewayService {
  private readonly providers: Record<string, PaymentGatewayProvider>;

  constructor(
    private readonly platformDb: PlatformPrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly connections: ConnectionsService,
    private readonly onlinePayment: OnlinePaymentService,
    moyasar: MoyasarProvider,
    tap: TapProvider,
    hyperpay: HyperpayProvider,
  ) {
    this.providers = { moyasar, tap, hyperpay };
  }

  async createCheckout(orderId: string) {
    const order = await this.platformDb.order.findFirst({
      where: { id: orderId, deletedAt: null },
    });
    if (!order) {
      throw new NotFoundException("Order not found");
    }
    if (order.status !== "new" && order.status !== "confirmed") {
      throw new ConflictException("This order can no longer be paid online");
    }

    const connection = await this.tenantContext.run(
      { userId: GUEST_ACTOR, tenantId: order.tenantId, branchId: order.branchId, permissions: new Set() },
      () => this.connections.findActive("payment_gateway"),
    );
    if (!connection) {
      throw new NotFoundException("No payment gateway is configured for this restaurant");
    }
    const provider = this.providers[connection.provider];
    if (!provider?.isCheckoutSupported) {
      throw new BadRequestException(`${connection.provider} checkout is not available yet`);
    }
    if (!connection.secretEnc) {
      throw new BadRequestException("Payment gateway is not fully configured");
    }
    const secretKey = decryptSecret(connection.secretEnc, INTEGRATIONS_VAULT_NAMESPACE);

    try {
      const session = await provider.createCheckout({
        orderId: order.id,
        amount: order.total.toString(),
        description: `Order #${order.orderNumber}`,
        successUrl: `${orderingBaseUrl()}/order/${order.id}?payment=success`,
        failureUrl: `${orderingBaseUrl()}/order/${order.id}?payment=failed`,
        secretKey,
        environment: connection.environment === "live" ? "live" : "test",
        config: (connection.config as Record<string, unknown>) ?? {},
      });
      await this.connections.recordSuccess(connection.id, "verified");
      return session;
    } catch (error) {
      await this.connections.recordError(
        connection.id,
        error instanceof Error ? error.message : "Checkout creation failed",
      );
      throw error;
    }
  }

  async handleWebhook(
    providerKey: string,
    connectionId: string,
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<{ received: true }> {
    const provider = this.providers[providerKey];
    if (!provider) {
      throw new NotFoundException(`Unknown payment gateway "${providerKey}"`);
    }

    const connection = await this.platformDb.integrationConnection.findFirst({
      where: { id: connectionId, category: "payment_gateway", provider: providerKey, deletedAt: null },
    });
    if (!connection || !connection.isEnabled) {
      throw new ForbiddenException("Unknown or disabled connection");
    }
    if (!connection.webhookSecretEnc) {
      throw new ForbiddenException("No webhook secret configured");
    }
    const webhookSecret = decryptSecret(connection.webhookSecretEnc, INTEGRATIONS_VAULT_NAMESPACE);

    if (!provider.verifyWebhook(rawBody, headers, webhookSecret)) {
      await this.platformDb.integrationConnection.update({
        where: { id: connectionId },
        data: { lastErrorMessage: "Webhook signature verification failed" },
      });
      throw new ForbiddenException("Invalid webhook signature");
    }

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      throw new BadRequestException("Webhook body is not valid JSON");
    }
    const event = provider.parseWebhookEvent(parsedBody);

    if (!event.success) {
      // A declined/failed charge is not an error in our system — the order
      // just stays unpaid and falls back to pay on pickup, exactly as if
      // the customer never attempted online payment at all.
      return { received: true };
    }

    const order = await this.platformDb.order.findFirst({
      where: { id: event.orderId, deletedAt: null },
      select: { total: true },
    });
    if (!order) {
      throw new NotFoundException("Webhook references an unknown order");
    }
    // The amount to record is the order's own total — checkout was created
    // for that exact total, so a genuine success event should always match
    // it. A mismatch (order edited after checkout was created, or a
    // replayed/misrouted event) is not something to silently paper over —
    // it stops here for manual review rather than recording a payment that
    // may not match what was actually charged.
    if (event.amount && event.amount !== order.total.toString()) {
      const message = `Webhook amount ${event.amount} does not match order total ${order.total.toString()} for order ${event.orderId}`;
      await this.connections.recordError(connectionId, message);
      throw new ConflictException(message);
    }

    await this.tenantContext.run(
      {
        userId: GUEST_ACTOR,
        tenantId: connection.tenantId,
        branchId: connection.branchId ?? undefined,
        permissions: new Set(),
      },
      async () => {
        await this.onlinePayment.recordAndComplete({
          tenantId: connection.tenantId,
          orderId: event.orderId,
          amount: order.total.toString(),
          reference: `${providerKey}:${event.gatewayReference}`,
          idempotencyKey: `${providerKey}:${event.gatewayReference}`.slice(0, 128),
        });
        await this.connections.recordSuccess(connection.id, "synced");
      },
    );

    return { received: true };
  }
}
