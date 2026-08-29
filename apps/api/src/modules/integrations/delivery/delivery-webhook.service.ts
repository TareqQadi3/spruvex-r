import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import { decryptSecret, INTEGRATIONS_VAULT_NAMESPACE } from "../../../shared/security/crypto-vault";
import { PlatformPrismaService } from "../../../shared/prisma/platform-prisma.service";
import { GUEST_ACTOR, TenantContextService } from "../../../shared/tenancy/tenant-context.service";
import { OrderingService } from "../../ordering/ordering.service";
import { ConnectionsService } from "../connections.service";
import { OnlinePaymentService } from "../online-payment.service";
import type { DeliveryProvider } from "./delivery-provider.interface";
import { HungerstationProvider } from "./hungerstation.provider";

/**
 * Ingests a delivery-platform webhook into a REAL order — same
 * OrderingService.create()/transition() the POS and customer ordering app
 * use, so stock deduction (on completion), KDS visibility, reports and
 * refunds all just work. Never a side table.
 */
@Injectable()
export class DeliveryWebhookService {
  private readonly providers: Record<string, DeliveryProvider>;

  constructor(
    private readonly platformDb: PlatformPrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly connections: ConnectionsService,
    private readonly ordering: OrderingService,
    private readonly onlinePayment: OnlinePaymentService,
    hungerstation: HungerstationProvider,
  ) {
    this.providers = { hungerstation };
  }

  async handle(
    providerKey: string,
    connectionId: string,
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<unknown> {
    const provider = this.providers[providerKey];
    if (!provider) {
      throw new NotFoundException(`Unknown delivery provider "${providerKey}"`);
    }

    // No tenant context exists yet — this is an external caller. Resolve the
    // connection (and its tenant) via the unscoped platform connection, the
    // same way guest QR ordering resolves a table token before entering
    // tenant context.
    const connection = await this.platformDb.integrationConnection.findFirst({
      where: {
        id: connectionId,
        category: "delivery_platform",
        provider: providerKey,
        deletedAt: null,
      },
    });
    if (!connection) {
      throw new NotFoundException("Unknown delivery connection");
    }
    if (!connection.isEnabled) {
      throw new ForbiddenException("This connection is disabled");
    }
    if (!connection.branchId) {
      throw new ConflictException("Delivery connection has no branch configured");
    }
    if (!connection.webhookSecretEnc) {
      throw new ForbiddenException("No webhook secret configured for this connection");
    }

    const webhookSecret = decryptSecret(connection.webhookSecretEnc, INTEGRATIONS_VAULT_NAMESPACE);
    if (!provider.verifySignature(rawBody, headers, webhookSecret)) {
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
      throw new ConflictException("Webhook body is not valid JSON");
    }
    const order = provider.parseOrder(parsedBody);

    const branchId = connection.branchId;
    const tenantId = connection.tenantId;

    return this.tenantContext.run(
      { userId: GUEST_ACTOR, tenantId, branchId, permissions: new Set() },
      async () => {
        try {
          const mappings = await this.resolveMappings(
            connectionId,
            order.lines.map((line) => line.externalItemId),
          );

          const items = order.lines.map((line) => {
            const productId = mappings.get(line.externalItemId);
            if (!productId) {
              throw new ConflictException(
                `No product mapped for external item "${line.externalItemName ?? line.externalItemId}" — map it first in Settings → Integrations`,
              );
            }
            return { productId, quantity: line.quantity };
          });

          const idempotencyKey = `${providerKey}:${order.externalOrderId}`.slice(0, 128);
          const created = await this.ordering.create(
            {
              type: "delivery",
              branchId,
              items,
              customerName: order.customerName,
              customerPhone: order.customerPhone,
              confirm: true,
            },
            {
              source: "delivery",
              tenantId,
              delivery: {
                externalOrderId: order.externalOrderId,
                provider: providerKey,
                commission: order.commission ?? null,
              },
            },
            idempotencyKey,
          );

          // The platform collected the money on the tenant's behalf — record
          // it the same way a fully-paid counter order is recorded, so the
          // order can progress to `completed` (which is what triggers stock
          // deduction) through the normal state machine.
          await this.onlinePayment.recordAndComplete({
            tenantId,
            orderId: created.id,
            amount: created.total.toString(),
            reference: `${providerKey}:${order.externalOrderId}`,
            idempotencyKey: `${idempotencyKey}:payment`.slice(0, 128),
          });

          await this.connections.recordSuccess(connection.id, "synced");
          return provider.buildAckResponse(order.externalOrderId);
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          await this.connections.recordError(connection.id, message);
          throw error;
        }
      },
    );
  }

  private async resolveMappings(
    connectionId: string,
    externalItemIds: string[],
  ): Promise<Map<string, string>> {
    const rows = await this.platformDb.deliveryProductMapping.findMany({
      where: { connectionId, externalItemId: { in: externalItemIds } },
      select: { externalItemId: true, productId: true },
    });
    return new Map(rows.map((row) => [row.externalItemId, row.productId]));
  }
}
