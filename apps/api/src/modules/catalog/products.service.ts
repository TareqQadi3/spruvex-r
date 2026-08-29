import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { AuditService } from "../../shared/audit/audit.service";
import { PrismaService } from "../../shared/prisma/prisma.service";
import { TenantContextService } from "../../shared/tenancy/tenant-context.service";
import {
  BranchSettingDto,
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
        createdBy: ctx.userId,
      },
      update: {
        priceOverride: dto.priceOverride ?? null,
        isAvailable: dto.isAvailable,
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
    return setting;
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
