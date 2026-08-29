import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import { AuditService } from "../../shared/audit/audit.service";
import { PrismaService } from "../../shared/prisma/prisma.service";
import { TenantContextService } from "../../shared/tenancy/tenant-context.service";
import { SetRecipeDto } from "./dto/recipe-item.dto";
import { InventoryService } from "./inventory.service";

@Injectable()
export class RecipesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditService,
    private readonly inventory: InventoryService,
  ) {}

  async get(productId: string) {
    const product = await this.prisma.scoped.product.findFirst({
      where: { id: productId, deletedAt: null },
      select: { id: true, name: true, nameEn: true },
    });
    if (!product) {
      throw new NotFoundException("Product not found");
    }
    const items = await this.prisma.scoped.recipeItem.findMany({
      where: { productId },
      include: {
        ingredient: { select: { id: true, name: true, nameEn: true, unitType: true } },
        unit: true,
      },
      orderBy: { createdAt: "asc" },
    });
    return { product, items };
  }

  /** Replaces the entire recipe for a product (validated as one unit — same measurement family, no duplicate ingredients). */
  async set(productId: string, dto: SetRecipeDto) {
    const ctx = this.tenantContext.contextOrThrow;
    const tenantId = this.tenantContext.tenantIdOrThrow;

    const product = await this.prisma.scoped.product.findFirst({
      where: { id: productId, deletedAt: null },
    });
    if (!product) {
      throw new NotFoundException("Product not found");
    }

    const ingredientIds = dto.items.map((item) => item.ingredientId);
    if (new Set(ingredientIds).size !== ingredientIds.length) {
      throw new BadRequestException("Duplicate ingredient in recipe");
    }

    const [ingredients, units] = await Promise.all([
      this.prisma.scoped.ingredient.findMany({
        where: { id: { in: ingredientIds }, deletedAt: null },
      }),
      this.prisma.scoped.unitOfMeasure.findMany({
        where: { id: { in: dto.items.map((item) => item.unitId) } },
      }),
    ]);
    const ingredientById = new Map(ingredients.map((i) => [i.id, i]));
    const unitById = new Map(units.map((u) => [u.id, u]));

    for (const item of dto.items) {
      const ingredient = ingredientById.get(item.ingredientId);
      if (!ingredient) {
        throw new NotFoundException(`Ingredient not found: ${item.ingredientId}`);
      }
      const unit = unitById.get(item.unitId);
      if (!unit) {
        throw new NotFoundException(`Unit not found: ${item.unitId}`);
      }
      if (unit.type !== ingredient.unitType) {
        throw new BadRequestException(
          `Unit "${unit.code}" (${unit.type}) does not match ingredient "${ingredient.name}"'s measurement type (${ingredient.unitType})`,
        );
      }
    }

    // Captured before the replace below, so we know which ingredients this
    // product is dropping "critical" tracking for (see the cleanup call at
    // the end — a merchant unchecking "critical" must release any product
    // this system currently has hidden for that ingredient, not leave it
    // stuck hidden forever).
    const previouslyCritical = await this.prisma.scoped.recipeItem.findMany({
      where: { productId, isCritical: true },
      select: { ingredientId: true },
    });

    await this.prisma.scopedTransaction(async (tx) => {
      await tx.recipeItem.deleteMany({ where: { productId } });
      if (dto.items.length > 0) {
        await tx.recipeItem.createMany({
          data: dto.items.map((item) => ({
            tenantId,
            productId,
            ingredientId: item.ingredientId,
            unitId: item.unitId,
            quantity: item.quantity,
            notes: item.notes,
            isCritical: item.isCritical ?? false,
            criticalThreshold: item.criticalThreshold,
            createdBy: ctx.userId,
          })),
        });
      }
    });

    await this.audit.log({
      action: "recipe.updated",
      entityType: "product",
      entityId: productId,
      meta: { ingredientCount: dto.items.length },
    });

    const nowCriticalIngredientIds = dto.items.filter((i) => i.isCritical).map((i) => i.ingredientId);
    const droppedCriticalIngredientIds = previouslyCritical
      .map((r) => r.ingredientId)
      .filter((id) => !nowCriticalIngredientIds.includes(id));
    await this.inventory.onRecipeCriticalLinksChanged(
      productId,
      nowCriticalIngredientIds,
      droppedCriticalIngredientIds,
    );

    return this.get(productId);
  }
}
