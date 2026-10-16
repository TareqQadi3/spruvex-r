import { Injectable } from "@nestjs/common";

import { halalasToSar, sarToHalalas } from "../../shared/common/money";
import { PrismaService } from "../../shared/prisma/prisma.service";
import { resolveRange } from "./report-utils";
import { ReportsService } from "./reports.service";

export interface BranchComparisonRow {
  branchId: string;
  branchName: string;
  branchNameEn: string | null;
  orderCount: number;
  totalSales: string;
  avgOrderValue: string;
  topProducts: Array<{ productId: string; name: string; nameEn: string | null; quantitySold: number }>;
  loyalty: { enabled: boolean; usagePercent: number | null; ordersWithLoyalty: number };
  ratings: { avgRating: number | null; count: number };
}

const REDEMPTION_LEDGER_TYPES = ["stamp_redeemed", "spend_redeemed", "points_redeemed"] as const;
const TOP_PRODUCTS_PER_BRANCH = 5;

/**
 * Branch performance comparison — read-only, built from the same real
 * orders/loyalty-ledger/ratings tables as every other report. Sorting by a
 * clicked column is left to the dashboard UI (it's the same rows either
 * way); this only decides what to compare and over what period.
 */
@Injectable()
export class BranchComparisonService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reports: ReportsService,
  ) {}

  async compare(from: string | undefined, to: string | undefined, branchIds?: string[]) {
    const { start, end } = resolveRange(from, to);
    const period = { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };

    const branches = await this.prisma.scoped.branch.findMany({
      where: {
        deletedAt: null,
        ...(branchIds && branchIds.length > 0 ? { id: { in: branchIds } } : {}),
      },
      select: { id: true, name: true, nameEn: true },
      orderBy: { name: "asc" },
    });
    if (branches.length === 0) {
      return { period, loyaltyAvailable: false, ratingsAvailable: false, rows: [] as BranchComparisonRow[] };
    }
    const branchIdList = branches.map((b) => b.id);
    const orderWhere = {
      status: "completed" as const,
      createdAt: { gte: start, lte: end },
      branchId: { in: branchIdList },
    };

    const [orders, items, loyaltyConfigs, redemptionEntries, ratings] = await Promise.all([
      this.prisma.scoped.order.findMany({
        where: orderWhere,
        select: { id: true, branchId: true, total: true },
      }),
      this.prisma.scoped.orderItem.findMany({
        where: { order: orderWhere },
        select: { productId: true, productSnapshot: true, quantity: true, order: { select: { branchId: true } } },
      }),
      this.prisma.scoped.loyaltyProgramConfig.findMany({
        where: { deletedAt: null, isEnabled: true, OR: [{ branchId: null }, { branchId: { in: branchIdList } }] },
        select: { branchId: true },
      }),
      this.prisma.scoped.loyaltyLedgerEntry.findMany({
        where: {
          branchId: { in: branchIdList },
          createdAt: { gte: start, lte: end },
          type: { in: [...REDEMPTION_LEDGER_TYPES] },
          orderId: { not: null },
        },
        select: { branchId: true, orderId: true },
      }),
      this.reports.ratingsSummary(undefined, from, to),
    ]);

    const tenantWideLoyaltyEnabled = loyaltyConfigs.some((c) => c.branchId === null);
    const branchLoyaltyEnabled = new Set(
      loyaltyConfigs.filter((c) => c.branchId !== null).map((c) => c.branchId as string),
    );
    const loyaltyAvailable = tenantWideLoyaltyEnabled || branchLoyaltyEnabled.size > 0;

    const redeemedOrdersByBranch = new Map<string, Set<string>>();
    for (const entry of redemptionEntries) {
      if (!entry.orderId) continue;
      const set = redeemedOrdersByBranch.get(entry.branchId) ?? new Set<string>();
      set.add(entry.orderId);
      redeemedOrdersByBranch.set(entry.branchId, set);
    }

    const salesByBranch = new Map<string, { count: number; totalHalalas: number }>();
    for (const o of orders) {
      const entry = salesByBranch.get(o.branchId) ?? { count: 0, totalHalalas: 0 };
      entry.count += 1;
      entry.totalHalalas += sarToHalalas(o.total.toString());
      salesByBranch.set(o.branchId, entry);
    }

    const productsByBranch = new Map<
      string,
      Map<string, { productId: string; name: string; nameEn: string | null; quantitySold: number }>
    >();
    for (const item of items) {
      const branchId = item.order.branchId;
      const snapshot = item.productSnapshot as { name: string; nameEn: string | null };
      const byProduct = productsByBranch.get(branchId) ?? new Map();
      const entry = byProduct.get(item.productId) ?? {
        productId: item.productId,
        name: snapshot.name,
        nameEn: snapshot.nameEn,
        quantitySold: 0,
      };
      entry.quantitySold += item.quantity;
      byProduct.set(item.productId, entry);
      productsByBranch.set(branchId, byProduct);
    }

    const ratingsByBranch = new Map(ratings.byBranch.map((r) => [r.branchId, r]));
    const ratingsAvailable = ratings.count > 0;

    const rows: BranchComparisonRow[] = branches.map((b) => {
      const sales = salesByBranch.get(b.id) ?? { count: 0, totalHalalas: 0 };
      const avgOrderValueHalalas = sales.count > 0 ? Math.round(sales.totalHalalas / sales.count) : 0;
      const topProducts = [...(productsByBranch.get(b.id)?.values() ?? [])]
        .sort((a, c) => c.quantitySold - a.quantitySold)
        .slice(0, TOP_PRODUCTS_PER_BRANCH);
      const loyaltyEnabled = tenantWideLoyaltyEnabled || branchLoyaltyEnabled.has(b.id);
      const redeemedCount = redeemedOrdersByBranch.get(b.id)?.size ?? 0;
      const usagePercent =
        loyaltyEnabled && sales.count > 0 ? Number(((redeemedCount / sales.count) * 100).toFixed(1)) : null;
      const ratingRow = ratingsByBranch.get(b.id);

      return {
        branchId: b.id,
        branchName: b.name,
        branchNameEn: b.nameEn,
        orderCount: sales.count,
        totalSales: halalasToSar(sales.totalHalalas),
        avgOrderValue: halalasToSar(avgOrderValueHalalas),
        topProducts,
        loyalty: { enabled: loyaltyEnabled, usagePercent, ordersWithLoyalty: redeemedCount },
        ratings: { avgRating: ratingRow?.avgRating ?? null, count: ratingRow?.count ?? 0 },
      };
    });

    return { period, loyaltyAvailable, ratingsAvailable, rows };
  }
}
