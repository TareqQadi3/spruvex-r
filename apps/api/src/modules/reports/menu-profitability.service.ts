import { Injectable, NotFoundException } from "@nestjs/common";

import { calculateRecipeCostUnits } from "../../shared/common/food-cost";
import { costUnitsToSar, halalasToSar, sarToHalalas } from "../../shared/common/money";
import { PrismaService } from "../../shared/prisma/prisma.service";
import { resolveRange } from "./report-utils";

export type MenuProfitabilityResult = Awaited<ReturnType<MenuProfitabilityService["menuProfitability"]>>;

export interface MenuProfitabilityRow {
  productId: string;
  productName: string;
  productNameEn: string | null;
  hasRecipe: boolean;
  /** Current recipe cost per unit, SAR — the exact figure FoodCostService.calculateProductCost
   * returns for this product (same ingredient averageCost, same calculateRecipeCostUnits call). */
  cost: string;
  /** Current selling price, SAR — the branch's priceOverride when one branch is selected and
   * an override exists there, else the product's tenant-wide basePrice. */
  sellingPrice: string;
  grossMargin: string;
  grossMarginPercent: string;
  quantitySold: number;
  /** grossMargin (per unit) × quantitySold — the actual profit this item contributed, not just its sale count. */
  totalContributionMargin: string;
}

/**
 * Menu profitability — read-only, computed at request time from data that
 * already exists (recipes, ingredient average cost, orders): no new table,
 * no persisted/cached figure.
 *
 * Two data-model facts shape this report, worth stating rather than
 * silently assuming away:
 *
 * 1. Ingredient.averageCost is a single tenant-wide moving average (see its
 *    schema doc comment) — NOT tracked per branch. So a product's recipe
 *    cost is identical everywhere; selecting a branch here narrows which
 *    branch's SALES (quantitySold, and therefore totalContributionMargin)
 *    are counted, it does not change the per-unit cost.
 * 2. Selling price CAN differ per branch (ProductBranchSetting.priceOverride).
 *    When a branchId is given, that branch's override is used when set;
 *    with no branch selected, the product's tenant-wide basePrice is used
 *    since there is no single "current price" to show across branches that
 *    may each override it differently.
 *
 * The per-unit cost/margin math is intentionally identical to
 * FoodCostService.calculateProductCost (same calculateRecipeCostUnits call,
 * same halala rounding) — this report must never show a different cost for
 * the same product than the recipe editor or dashboard summary do.
 *
 * "Sold" means OrderItem.quantity on orders with status "completed" in the
 * range — the same filter bestSellers()/financial() already use, which
 * already excludes cancelled orders and FULLY refunded orders (a full
 * refund moves an order to its own "refunded" status, never "completed" —
 * see the OrderStatus enum doc comment). A partially-refunded line (some
 * units credited back via OrderItem.refundedQuantity while the order stays
 * "completed") still counts here at its full sold quantity, matching how
 * bestSellers/financial already treat it — this report does not introduce
 * a different, netted-out quantity notion of its own.
 */
@Injectable()
export class MenuProfitabilityService {
  constructor(private readonly prisma: PrismaService) {}

  async menuProfitability(branchId: string | undefined, from: string | undefined, to: string | undefined) {
    const { start, end } = resolveRange(from, to);

    const branch = branchId
      ? await this.prisma.scoped.branch.findFirst({ where: { id: branchId }, select: { id: true, name: true, nameEn: true } })
      : null;
    if (branchId && !branch) {
      throw new NotFoundException("Branch not found");
    }

    const rows = await this.computeRows(branchId, start, end);

    return {
      branch,
      period: { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) },
      rows,
    };
  }

  /**
   * The actual per-range computation, factored out from menuProfitability()
   * so a future "compare this period vs. a prior one" endpoint can call it
   * twice (two Date ranges) and diff the two row arrays, without touching
   * this method or its DB queries at all.
   */
  private async computeRows(
    branchId: string | undefined,
    start: Date,
    end: Date,
  ): Promise<MenuProfitabilityRow[]> {
    const [products, overrides, sold] = await Promise.all([
      this.prisma.scoped.product.findMany({
        where: { deletedAt: null, isActive: true },
        include: { recipeItems: { include: { ingredient: true, unit: true } } },
      }),
      branchId
        ? this.prisma.scoped.productBranchSetting.findMany({
            where: { branchId, priceOverride: { not: null } },
            select: { productId: true, priceOverride: true },
          })
        : Promise.resolve([]),
      this.prisma.scoped.orderItem.groupBy({
        by: ["productId"],
        where: {
          order: {
            status: "completed",
            createdAt: { gte: start, lte: end },
            ...(branchId ? { branchId } : {}),
          },
        },
        _sum: { quantity: true },
      }),
    ]);

    const overrideByProduct = new Map(overrides.map((o) => [o.productId, o.priceOverride!.toString()]));
    const soldByProduct = new Map(sold.map((s) => [s.productId, s._sum.quantity ?? 0]));

    const rows: MenuProfitabilityRow[] = products.map((product) => {
      const hasRecipe = product.recipeItems.length > 0;
      const costUnits = hasRecipe
        ? calculateRecipeCostUnits(
            product.recipeItems.map((recipeItem) => ({
              quantity: recipeItem.quantity.toString(),
              unitToBaseFactor: recipeItem.unit.toBaseFactor.toString(),
              ingredientAverageCost: recipeItem.ingredient.averageCost.toString(),
            })),
          )
        : 0;

      const sellingPriceSar = overrideByProduct.get(product.id) ?? product.basePrice.toString();
      const priceHalalas = sarToHalalas(sellingPriceSar);
      const costHalalasRounded = Math.round(costUnits / 100);
      const marginHalalas = priceHalalas - costHalalasRounded;
      const marginPercent = priceHalalas > 0 ? ((marginHalalas / priceHalalas) * 100).toFixed(2) : "0.00";
      const quantitySold = soldByProduct.get(product.id) ?? 0;
      const totalContributionMarginHalalas = marginHalalas * quantitySold;

      return {
        productId: product.id,
        productName: product.name,
        productNameEn: product.nameEn,
        hasRecipe,
        cost: costUnitsToSar(costUnits),
        sellingPrice: sellingPriceSar,
        grossMargin: halalasToSar(marginHalalas),
        grossMarginPercent: marginPercent,
        quantitySold,
        totalContributionMargin: halalasToSar(totalContributionMarginHalalas),
      };
    });

    rows.sort((a, b) => sarToHalalas(b.totalContributionMargin) - sarToHalalas(a.totalContributionMargin));
    return rows;
  }

  /** CSV export — same shape/BOM convention as the VAT return export. */
  toCsv(result: MenuProfitabilityResult): string {
    const rows: string[][] = [];

    rows.push(["تقرير ربحية القائمة / Menu Profitability Report"]);
    rows.push(["الفرع / Branch", result.branch ? result.branch.name : "كل الفروع / All branches"]);
    rows.push(["الفترة / Period", `${result.period.from} → ${result.period.to}`]);
    rows.push([]);

    rows.push([
      "الصنف / Product",
      "Product (EN)",
      "له وصفة؟ / Has recipe",
      "التكلفة / Cost",
      "سعر البيع / Selling Price",
      "هامش الربح / Gross Margin",
      "نسبة الهامش % / Gross Margin %",
      "الكمية المباعة / Quantity Sold",
      "إجمالي هامش المساهمة / Total Contribution Margin",
    ]);
    for (const row of result.rows) {
      rows.push([
        row.productName,
        row.productNameEn ?? "",
        row.hasRecipe ? "نعم / Yes" : "لا / No",
        row.cost,
        row.sellingPrice,
        row.grossMargin,
        row.grossMarginPercent,
        String(row.quantitySold),
        row.totalContributionMargin,
      ]);
    }

    return rows.map((row) => row.map(csvEscape).join(",")).join("\r\n");
  }
}

function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
