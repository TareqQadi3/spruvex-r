import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { IntegrationCategory } from "@prisma/client";

import { AuditService } from "../../shared/audit/audit.service";
import { decryptSecret, encryptSecret, INTEGRATIONS_VAULT_NAMESPACE } from "../../shared/security/crypto-vault";
import { PrismaService } from "../../shared/prisma/prisma.service";
import { TenantContextService } from "../../shared/tenancy/tenant-context.service";
import { UpsertConnectionDto } from "./dto/connection.dto";

/** Redacted shape returned to the dashboard — never the decrypted secrets themselves. */
export interface ConnectionSummary {
  id: string;
  category: IntegrationCategory;
  provider: string;
  branchId: string | null;
  isEnabled: boolean;
  environment: string;
  config: Record<string, unknown>;
  hasSecret: boolean;
  hasWebhookSecret: boolean;
  lastVerifiedAt: Date | null;
  lastSyncedAt: Date | null;
  lastErrorMessage: string | null;
  status: "connected" | "disconnected" | "error";
  /** The URL to hand the provider (delivery platform / payment gateway) for their webhook config — null for categories that don't receive webhooks. */
  webhookUrl: string | null;
}

function apiPublicOrigin(): string {
  return (process.env.PUBLIC_API_ORIGIN ?? "http://localhost:3000").replace(/\/+$/, "");
}

function computeWebhookUrl(category: IntegrationCategory, provider: string, connectionId: string): string | null {
  if (category === "delivery_platform") {
    return `${apiPublicOrigin()}/api/v1/integrations/delivery/webhook/${provider}/${connectionId}`;
  }
  if (category === "payment_gateway") {
    return `${apiPublicOrigin()}/api/v1/integrations/payment-gateway/webhook/${provider}/${connectionId}`;
  }
  return null;
}

function redact(row: {
  id: string;
  category: IntegrationCategory;
  provider: string;
  branchId: string | null;
  isEnabled: boolean;
  environment: string;
  config: unknown;
  secretEnc: string | null;
  webhookSecretEnc: string | null;
  lastVerifiedAt: Date | null;
  lastSyncedAt: Date | null;
  lastErrorMessage: string | null;
}): ConnectionSummary {
  return {
    id: row.id,
    category: row.category,
    provider: row.provider,
    branchId: row.branchId,
    isEnabled: row.isEnabled,
    environment: row.environment,
    config: (row.config as Record<string, unknown>) ?? {},
    hasSecret: Boolean(row.secretEnc),
    hasWebhookSecret: Boolean(row.webhookSecretEnc),
    lastVerifiedAt: row.lastVerifiedAt,
    lastSyncedAt: row.lastSyncedAt,
    lastErrorMessage: row.lastErrorMessage,
    status: !row.isEnabled ? "disconnected" : row.lastErrorMessage ? "error" : "connected",
    webhookUrl: computeWebhookUrl(row.category, row.provider, row.id),
  };
}

/**
 * Generic CRUD + status for every third-party integration connection
 * (delivery platform, payment gateway, NFC terminal, WhatsApp) — one table,
 * one service. Provider-specific behavior (webhook parsing, checkout
 * creation, message sending) lives in each category's own module and reads
 * credentials back through `getDecrypted()`, never through the API layer.
 */
@Injectable()
export class ConnectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditService,
  ) {}

  async list(category?: IntegrationCategory): Promise<ConnectionSummary[]> {
    const rows = await this.prisma.scoped.integrationConnection.findMany({
      where: { deletedAt: null, ...(category ? { category } : {}) },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(redact);
  }

  async get(id: string): Promise<ConnectionSummary> {
    const row = await this.prisma.scoped.integrationConnection.findFirst({
      where: { id, deletedAt: null },
    });
    if (!row) {
      throw new NotFoundException("Integration connection not found");
    }
    return redact(row);
  }

  /** Server-side only — resolves credentials in the clear for a provider adapter to use. Never exposed via any controller. */
  async getDecrypted(id: string) {
    const row = await this.prisma.scoped.integrationConnection.findFirst({
      where: { id, deletedAt: null },
    });
    if (!row) {
      throw new NotFoundException("Integration connection not found");
    }
    return {
      ...row,
      config: (row.config as Record<string, unknown>) ?? {},
      secret: row.secretEnc ? decryptSecret(row.secretEnc, INTEGRATIONS_VAULT_NAMESPACE) : null,
      webhookSecret: row.webhookSecretEnc
        ? decryptSecret(row.webhookSecretEnc, INTEGRATIONS_VAULT_NAMESPACE)
        : null,
    };
  }

  /** Finds the one enabled connection for a category (+ branch, when branch-scoped) — used by webhook/checkout code paths that need "the active provider", not a specific id. */
  async findActive(category: IntegrationCategory, branchId?: string) {
    return this.prisma.scoped.integrationConnection.findFirst({
      where: { category, isEnabled: true, deletedAt: null, ...(branchId ? { branchId } : {}) },
    });
  }

  async upsert(
    category: IntegrationCategory,
    dto: UpsertConnectionDto,
    allowedProviders: readonly string[],
  ): Promise<ConnectionSummary> {
    if (!allowedProviders.includes(dto.provider)) {
      throw new BadRequestException(`Unknown provider "${dto.provider}" for ${category}`);
    }
    const ctx = this.tenantContext.contextOrThrow;
    const tenantId = this.tenantContext.tenantIdOrThrow;
    const branchId = dto.branchId ?? null;

    const existing = await this.prisma.scoped.integrationConnection.findFirst({
      where: { category, provider: dto.provider, branchId, deletedAt: null },
    });

    const data = {
      tenantId,
      branchId,
      category,
      provider: dto.provider,
      ...(dto.isEnabled !== undefined ? { isEnabled: dto.isEnabled } : {}),
      ...(dto.environment !== undefined ? { environment: dto.environment } : {}),
      ...(dto.config !== undefined ? { config: dto.config } : {}),
      ...(dto.secret !== undefined
        ? { secretEnc: dto.secret ? encryptSecret(dto.secret, INTEGRATIONS_VAULT_NAMESPACE) : null }
        : {}),
      ...(dto.webhookSecret !== undefined
        ? {
            webhookSecretEnc: dto.webhookSecret
              ? encryptSecret(dto.webhookSecret, INTEGRATIONS_VAULT_NAMESPACE)
              : null,
          }
        : {}),
      updatedBy: ctx.userId,
    };

    const row = existing
      ? await this.prisma.scoped.integrationConnection.update({ where: { id: existing.id }, data })
      : await this.prisma.scoped.integrationConnection.create({
          data: { ...data, createdBy: ctx.userId },
        });

    await this.audit.log({
      action: existing ? "integration.updated" : "integration.connected",
      entityType: "integration_connection",
      entityId: row.id,
      branchId: branchId ?? undefined,
      meta: {
        category,
        provider: dto.provider,
        isEnabled: row.isEnabled,
        secretChanged: dto.secret !== undefined,
        webhookSecretChanged: dto.webhookSecret !== undefined,
      },
    });

    return redact(row);
  }

  async disconnect(id: string): Promise<void> {
    const row = await this.prisma.scoped.integrationConnection.findFirst({
      where: { id, deletedAt: null },
    });
    if (!row) {
      throw new NotFoundException("Integration connection not found");
    }
    await this.prisma.scoped.integrationConnection.update({
      where: { id },
      data: { deletedAt: new Date(), isEnabled: false },
    });
    await this.audit.log({
      action: "integration.disconnected",
      entityType: "integration_connection",
      entityId: id,
      branchId: row.branchId ?? undefined,
      meta: { category: row.category, provider: row.provider },
    });
  }

  /** Records a webhook/API failure so the dashboard's status badge turns red without leaking the secret itself. */
  async recordError(id: string, message: string): Promise<void> {
    await this.prisma.scoped.integrationConnection.update({
      where: { id },
      data: { lastErrorMessage: message.slice(0, 500) },
    });
  }

  async recordSuccess(id: string, kind: "verified" | "synced"): Promise<void> {
    await this.prisma.scoped.integrationConnection.update({
      where: { id },
      data: {
        lastErrorMessage: null,
        ...(kind === "verified" ? { lastVerifiedAt: new Date() } : { lastSyncedAt: new Date() }),
      },
    });
  }
}
