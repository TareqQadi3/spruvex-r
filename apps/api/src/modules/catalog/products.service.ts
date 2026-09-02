import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { Prisma } from "@prisma/client";

import { DOMAIN_EVENTS } from "@spruvex-r/types";

import { AuditService } from "../../shared/audit/audit.service";
import { riyadhDateString } from "../../shared/common/riyadh-date";
import { PrismaService } from "../../shared/prisma/prisma.service";
import { TenantContextService } from "../../shared/tenancy/tenant-context.service";
import {
  BranchSettingDto,
  ChannelOverrideDto,
  CreateProductDto,
  SetProductModifierGroupsDto,
  UpdateProductDto,
} from "./dto/product.dto";

const PRODUCT_INCLUDE = {
  category: { select: { id: true, name: true, nameEn: true } },
  branchSettings: {
    select: {
      branchId: true,
      priceOverride: true,
      isAvailable: true,
      unavailableReason: true,
      soldOutDate: true,
      branch: { select: { name: true, nameEn: true } },
    },
  },
  modifierGroups: {
    orderBy: { sortOrder: "asc" },
    select: {
      modifierGroupId: true,
      sortOrder: true,
      group: {
        select: {
          id: true,
          name: true,
          nameEn: true,
          isRequired: true,
          minSelect: true,
          maxSelect: true,
          modifiers: {
            where: { deletedAt: null },
            orderBy: { sortOrder: "asc" },
            select: { id: true, name: true, nameEn: true, priceAdjustment: true, isActive: true },
          },
        },
      },
    },
  },
} satisfies Prisma.ProductInclude;

@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditService,
    private readonly events: EventEmitter2,
  ) {}

  list(categoryId?: string) {
    return this.prisma.scoped.product.findMany({
      where: { deletedAt: null, ...(categoryId ? { categoryId } : {}) },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      include: PRODUCT_INCLUDE,
    });
  }

  async get(id: string) {
    const product = await this.prisma.scoped.product.findFirst({
      where: { id, deletedAt: null },
      include: PRODUCT_INCLUDE,
    });
    if (!product) {
      throw new NotFoundException("Product not found");
    }
    return product;
  }

  async create(dto: CreateProductDto) {
    const ctx = this.tenantContext.contextOrThrow;
    await this.assertCategory(dto.categoryId);
    await this.assertSkuAvailable(dto.sku);

    const product = await this.prisma.scoped.product.create({
      data: {
        tenantId: this.tenantContext.tenantIdOrThrow,
        ...dto,
        createdBy: ctx.userId,
      },
      include: PRODUCT_INCLUDE,
    });
    await this.audit.log({
      action: "product.created",
      entityType: "product",
      entityId: product.id,
      meta: { name: product.name, basePrice: dto.basePrice },
    });
    return product;
  }

  async update(id: string, dto: UpdateProductDto) {
    const ctx = this.tenantContext.contextOrThrow;
    await this.get(id);
    if (dto.categoryId) {
      await this.assertCategory(dto.categoryId);
    }
    if (dto.sku !== undefined) {
      await this.assertSkuAvailable(dto.sku, id);
    }

    const product = await this.prisma.scoped.product.update({
      where: { id },
      data: { ...dto, updatedBy: ctx.userId },
      include: PRODUCT_INCLUDE,
    });
    await this.audit.log({
      action: "product.updated",
      entityType: "product",
      entityId: id,
      meta: { changes: { ...dto } },
    });
    return product;
  }

  async softDelete(id: string) {
    const ctx = this.tenantContext.contextOrThrow;
    const product = await this.get(id);
    await this.prisma.scoped.product.update({
      where: { id },
      data: { deletedAt: new Date(), updatedBy: ctx.userId },
    });
    await this.audit.log({
      action: "product.deleted",
      entityType: "product",
      entityId: id,
      meta: { name: product.name },
    });
    return { deleted: true };
  }

  /** Replaces the set of modifier groups attached to a product. */
  async setModifierGroups(id: string, dto: SetProductModifierGroupsDto) {
    const ctx = this.tenantContext.contextOrThrow;
    const tenantId = this.tenantContext.tenantIdOrThrow;
    await this.get(id);

    const groupIds = dto.groups.map((g) => g.modifierGroupId);
    if (new Set(groupIds).size !== groupIds.length) {
      throw new BadRequestException("Duplicate modifier group in list");
    }
    const found = await this.prisma.scoped.modifierGroup.count({
      where: { id: { in: groupIds }, deletedAt: null },
    });
    if (found !== groupIds.length) {
      throw new NotFoundException("One or more modifier groups not found");
    }

    const scoped = this.prisma.scoped;
    await scoped.productModifierGroup.deleteMany({ where: { productId: id } });
    if (dto.groups.length > 0) {
      await scoped.productModifierGroup.createMany({
        data: dto.groups.map((g, index) => ({
          tenantId,
          productId: id,
          modifierGroupId: g.modifierGroupId,
          sortOrder: g.sortOrder ?? index,
          createdBy: ctx.userId,
        })),
      });
    }

    await this.audit.log({
      action: "product.modifier_groups_updated",
      entityType: "product",
      entityId: id,
      meta: { groupIds },
    });
    return this.get(id);
  }

  /** Upserts availability + price override for a product in one branch. */
  async setBranchSetting(id: string, branchId: string, dto: BranchSettingDto) {
    const ctx = this.tenantContext.contextOrThrow;
    const tenantId = this.tenantContext.tenantIdOrThrow;
    await this.get(id);

    const branch = await this.prisma.scoped.branch.findFirst({
      where: { id: branchId, deletedAt: null },
    });
    if (!branch) {
      throw new NotFoundException("Branch not found");
    }

    const setting = await this.prisma.scoped.productBranchSetting.upsert({
      where: { productId_branchId: { productId: id, branchId } },
      create: {
        tenantId,
        productId: id,
        branchId,
        priceOverride: dto.priceOverride ?? null,
        isAvailable: dto.isAvailable,
        unavailableReason: dto.isAvailable ? null : "manual",
        soldOutDate: null,
        createdBy: ctx.userId,
      },
      update: {
        priceOverride: dto.priceOverride ?? null,
        isAvailable: dto.isAvailable,
        unavailableReason: dto.isAvailable ? null : "manual",
        soldOutDate: null,
        updatedBy: ctx.userId,
      },
    });

    // A merchant re-enabling a product always wins immediately, even if the
    // system had it hidden for a critical-ingredient stockout — see
    // InventoryService.reevaluateStockGating's doc comment. Without this,
    // the next unrelated stock movement for some OTHER ingredient could
    // still find the stale ProductStockHide row and treat it as still
    // system-owned.
    if (dto.isAvailable) {
      await this.prisma.scoped.productStockHide.deleteMany({ where: { productId: id, branchId } });
    }

    await this.audit.log({
      action: "product.branch_setting_updated",
      entityType: "product",
      entityId: id,
      branchId,
      meta: { priceOverride: dto.priceOverride ?? null, isAvailable: dto.isAvailable },
    });
    this.emitAvailabilityChanged(branchId, id, dto.isAvailable);
    return setting;
  }

  /**
   * Marks a product sold-out for TODAY only (Asia/Riyadh calendar date) — a
   * daily sweep (CatalogAvailabilityCron) flips it back to available once
   * that date has passed, with no staff action required.
   */
  async markSoldOutToday(id: string, branchId: string) {
    return this.setAvailabilityState(id, branchId, {
      isAvailable: false,
      unavailableReason: "sold_out_today",
      soldOutDate: new Date(riyadhDateString()),
    });
  }

  /** Marks a product unavailable indefinitely — stays off until a human re-enables it. */
  async markUnavailable(id: string, branchId: string) {
    return this.setAvailabilityState(id, branchId, {
      isAvailable: false,
      unavailableReason: "manual",
      soldOutDate: null,
    });
  }

  /** Re-enables a product at a branch — clears any stale system stock-hide too. */
  async markAvailable(id: string, branchId: string) {
    const result = await this.setAvailabilityState(id, branchId, {
      isAvailable: true,
      unavailableReason: null,
      soldOutDate: null,
    });
    await this.prisma.scoped.productStockHide.deleteMany({ where: { productId: id, branchId } });
    return result;
  }

  private async setAvailabilityState(
    id: string,
    branchId: string,
    state: { isAvailable: boolean; unavailableReason: string | null; soldOutDate: Date | null },
  ) {
    const ctx = this.tenantContext.contextOrThrow;
    const tenantId = this.tenantContext.tenantIdOrThrow;
    await this.get(id);
    const branch = await this.prisma.scoped.branch.findFirst({ where: { id: branchId, deletedAt: null } });
    if (!branch) {
      throw new NotFoundException("Branch not found");
    }

    const setting = await this.prisma.scoped.productBranchSetting.upsert({
      where: { productId_branchId: { productId: id, branchId } },
      create: {
        tenantId,
        productId: id,
        branchId,
        isAvailable: state.isAvailable,
        unavailableReason: state.unavailableReason,
        soldOutDate: state.soldOutDate,
        createdBy: ctx.userId,
      },
      update: {
        isAvailable: state.isAvailable,
        unavailableReason: state.unavailableReason,
        soldOutDate: state.soldOutDate,
        updatedBy: ctx.userId,
      },
    });

    await this.audit.log({
      action: "product.availability_state_changed",
      entityType: "product",
      entityId: id,
      branchId,
      meta: { isAvailable: state.isAvailable, reason: state.unavailableReason },
    });
    this.emitAvailabilityChanged(branchId, id, state.isAvailable);
    return setting;
  }

  private emitAvailabilityChanged(branchId: string, productId: string, isAvailable: boolean) {
    this.events.emit(DOMAIN_EVENTS.PRODUCT_AVAILABILITY_CHANGED, {
      tenantId: this.tenantContext.tenantIdOrThrow,
      branchId,
      productId,
      isAvailable,
    });
  }

  /** Upserts a per-channel visibility/price override for a product at a branch (item 3). */
  async setChannelOverride(id: string, branchId: string, dto: ChannelOverrideDto) {
    const ctx = this.tenantContext.contextOrThrow;
    const tenantId = this.tenantContext.tenantIdOrThrow;
    await this.get(id);
    const branch = await this.prisma.scoped.branch.findFirst({ where: { id: branchId, deletedAt: null } });
    if (!branch) {
      throw new NotFoundException("Branch not found");
    }

    const override = await this.prisma.scoped.productChannelOverride.upsert({
      where: { productId_branchId_channel: { productId: id, branchId, channel: dto.channel } },
      create: {
        tenantId,
        productId: id,
        branchId,
        channel: dto.channel,
        isVisible: dto.isVisible,
        priceOverride: dto.priceOverride ?? null,
        createdBy: ctx.userId,
      },
      update: {
        isVisible: dto.isVisible,
        priceOverride: dto.priceOverride ?? null,
        updatedBy: ctx.userId,
      },
    });

    await this.audit.log({
      action: "product.channel_override_updated",
      entityType: "product",
      entityId: id,
      branchId,
      meta: { channel: dto.channel, isVisible: dto.isVisible, priceOverride: dto.priceOverride ?? null },
    });
    this.emitAvailabilityChanged(branchId, id, dto.isVisible);
    return override;
  }

  /** All per-channel overrides for a product across branches (dashboard editing view). */
  listChannelOverrides(id: string) {
    return this.prisma.scoped.productChannelOverride.findMany({
      where: { productId: id },
      include: { branch: { select: { id: true, name: true, nameEn: true } } },
    });
  }

  private async assertCategory(categoryId: string) {
    const category = await this.prisma.scoped.category.findFirst({
      where: { id: categoryId, deletedAt: null },
    });
    if (!category) {
      throw new NotFoundException("Category not found");
    }
  }

  private async assertSkuAvailable(sku: string | undefined, exceptId?: string) {
    if (!sku) return;
    const existing = await this.prisma.scoped.product.findFirst({
      where: { sku, deletedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}) },
    });
    if (existing) {
      throw new ConflictException(`SKU "${sku}" is already used by another product`);
    }
  }
}
