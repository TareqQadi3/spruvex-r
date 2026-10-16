import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";

import { LOYALTY_PROGRAM_TYPES, type LoyaltyProgramType } from "@spruvex-r/types";

import { AuditService } from "../../shared/audit/audit.service";
import { PrismaService } from "../../shared/prisma/prisma.service";
import { actorOrNull, TenantContextService } from "../../shared/tenancy/tenant-context.service";
import { UpsertLoyaltyConfigDto } from "./dto/loyalty-config.dto";

/** Throws a clean 400 for a bad :type path param instead of a raw Prisma enum error. */
function assertType(type: string): asserts type is LoyaltyProgramType {
  if (!(LOYALTY_PROGRAM_TYPES as readonly string[]).includes(type)) {
    throw new BadRequestException(`Unknown loyalty program type: ${type}`);
  }
}

/** Validates config's shape against the type it's declared for — see loyalty.ts for the expected fields. */
function validateConfigShape(type: LoyaltyProgramType, config: Record<string, unknown>): void {
  switch (type) {
    case "stamp_card": {
      const stampsRequired = Number(config.stampsRequired);
      if (!Number.isInteger(stampsRequired) || stampsRequired < 1) {
        throw new BadRequestException("stampsRequired must be a positive integer");
      }
      if (!config.rewardProductId || typeof config.rewardProductId !== "string") {
        throw new BadRequestException("rewardProductId is required");
      }
      if (config.earnProductId && config.earnCategoryId) {
        throw new BadRequestException("Set earnProductId or earnCategoryId, not both");
      }
      break;
    }
    case "spend_threshold": {
      const threshold = Number(config.thresholdAmount);
      const pct = Number(config.discountPercent);
      if (!(threshold > 0)) {
        throw new BadRequestException("thresholdAmount must be a positive amount");
      }
      if (!(pct > 0 && pct <= 100)) {
        throw new BadRequestException("discountPercent must be between 0 and 100");
      }
      if (!["monthly", "yearly", "none"].includes(String(config.resetPeriod))) {
        throw new BadRequestException("resetPeriod must be one of monthly, yearly, none");
      }
      if (typeof config.carryOver !== "boolean") {
        throw new BadRequestException("carryOver must be a boolean");
      }
      break;
    }
    case "points_per_riyal": {
      const rate = Number(config.pointsPerRiyal);
      const unit = Number(config.redemptionPointsUnit);
      const sarValue = Number(config.redemptionSarValue);
      if (!(rate > 0)) {
        throw new BadRequestException("pointsPerRiyal must be positive");
      }
      if (!Number.isInteger(unit) || unit < 1) {
        throw new BadRequestException("redemptionPointsUnit must be a positive integer");
      }
      if (!(sarValue > 0)) {
        throw new BadRequestException("redemptionSarValue must be positive");
      }
      break;
    }
    case "tier": {
      const tiers = config.tiers;
      if (!Array.isArray(tiers) || tiers.length === 0) {
        throw new BadRequestException("At least one tier is required");
      }
      const keys = new Set<string>();
      for (const raw of tiers) {
        const t = raw as Record<string, unknown>;
        if (!t.key || typeof t.key !== "string" || keys.has(t.key)) {
          throw new BadRequestException("Every tier needs a unique, non-empty key");
        }
        keys.add(t.key);
        if (!t.nameAr || typeof t.nameAr !== "string") {
          throw new BadRequestException("Every tier needs an Arabic name");
        }
        if (!(Number(t.minSpend) >= 0)) {
          throw new BadRequestException("Every tier's minSpend must be >= 0");
        }
        const discountPercent = Number(t.discountPercent);
        if (!(discountPercent >= 0 && discountPercent <= 100)) {
          throw new BadRequestException("Every tier's discountPercent must be between 0 and 100");
        }
      }
      break;
    }
  }
}

@Injectable()
export class LoyaltyConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditService,
  ) {}

  /** Tenant-wide default rows for all 4 types (branchId = null), one per type when configured. */
  list() {
    return this.prisma.scoped.loyaltyProgramConfig.findMany({
      where: { branchId: null, deletedAt: null },
      orderBy: { type: "asc" },
    });
  }

  /** Effective config per type for one branch: its own override if set, else the tenant-wide default. */
  async listForBranch(branchId: string) {
    const [branchRows, tenantRows] = await Promise.all([
      this.prisma.scoped.loyaltyProgramConfig.findMany({ where: { branchId, deletedAt: null } }),
      this.prisma.scoped.loyaltyProgramConfig.findMany({ where: { branchId: null, deletedAt: null } }),
    ]);
    const byType = new Map(tenantRows.map((row) => [row.type, { ...row, isOverride: false }]));
    for (const row of branchRows) {
      byType.set(row.type, { ...row, isOverride: true });
    }
    return [...byType.values()];
  }

  async upsert(type: string, dto: UpsertLoyaltyConfigDto) {
    assertType(type);
    validateConfigShape(type, dto.config);

    const ctx = this.tenantContext.contextOrThrow;
    const tenantId = this.tenantContext.tenantIdOrThrow;
    const actor = actorOrNull(ctx.userId);

    if (dto.branchId) {
      const branch = await this.prisma.scoped.branch.findFirst({
        where: { id: dto.branchId, deletedAt: null },
      });
      if (!branch) {
        throw new NotFoundException("Branch not found");
      }
    }
    await this.assertReferencedCatalogEntitiesExist(type, dto.config);

    // A compound unique on a nullable column (branchId) can't be targeted by
    // Prisma's `upsert`/`findUnique` shorthand with null — Postgres treats
    // every NULL as distinct for uniqueness, so `where: null` here would
    // silently create a duplicate tenant-wide row per upsert. find-then-
    // create/update instead (same workaround as ConnectionsService.upsert).
    const branchId = dto.branchId ?? null;
    const existing = await this.prisma.scoped.loyaltyProgramConfig.findFirst({
      where: { tenantId, branchId, type, deletedAt: null },
    });
    const config = existing
      ? await this.prisma.scoped.loyaltyProgramConfig.update({
          where: { id: existing.id },
          data: { isEnabled: dto.isEnabled, config: dto.config, updatedBy: actor },
        })
      : await this.prisma.scoped.loyaltyProgramConfig.create({
          data: {
            tenantId,
            branchId,
            type,
            isEnabled: dto.isEnabled,
            config: dto.config,
            createdBy: actor,
          },
        });

    await this.audit.log({
      action: "loyalty.config_updated",
      entityType: "loyalty_program_config",
      entityId: config.id,
      branchId: dto.branchId,
      meta: { type, isEnabled: dto.isEnabled, branchId: dto.branchId ?? null },
    });
    return config;
  }

  /** Removes a branch-specific override, reverting that branch to the tenant-wide default. Never deletes the tenant-wide row itself — pausing is isEnabled:false, not deletion. */
  async removeBranchOverride(type: string, branchId: string) {
    assertType(type);
    const tenantId = this.tenantContext.tenantIdOrThrow;

    const existing = await this.prisma.scoped.loyaltyProgramConfig.findUnique({
      where: { tenantId_branchId_type: { tenantId, branchId, type } },
    });
    if (!existing) {
      throw new NotFoundException("No branch-specific override to remove");
    }
    await this.prisma.scoped.loyaltyProgramConfig.delete({ where: { id: existing.id } });

    await this.audit.log({
      action: "loyalty.config_override_removed",
      entityType: "loyalty_program_config",
      entityId: existing.id,
      branchId,
      meta: { type },
    });
    return { removed: true };
  }

  private async assertReferencedCatalogEntitiesExist(
    type: LoyaltyProgramType,
    config: Record<string, unknown>,
  ): Promise<void> {
    const productIds = new Set<string>();
    const categoryIds = new Set<string>();
    if (type === "stamp_card") {
      if (typeof config.rewardProductId === "string") productIds.add(config.rewardProductId);
      if (typeof config.earnProductId === "string") productIds.add(config.earnProductId);
      if (typeof config.earnCategoryId === "string") categoryIds.add(config.earnCategoryId);
    }
    if (productIds.size > 0) {
      const count = await this.prisma.scoped.product.count({
        where: { id: { in: [...productIds] }, deletedAt: null },
      });
      if (count !== productIds.size) {
        throw new NotFoundException("One of the referenced products was not found");
      }
    }
    if (categoryIds.size > 0) {
      const count = await this.prisma.scoped.category.count({
        where: { id: { in: [...categoryIds] }, deletedAt: null },
      });
      if (count !== categoryIds.size) {
        throw new NotFoundException("The referenced category was not found");
      }
    }
  }
}
