import { Injectable } from "@nestjs/common";

import { halalasToSar, sarToCostUnits, sarToHalalas } from "../../shared/common/money";
import { PrismaService } from "../../shared/prisma/prisma.service";

function dayRange(dateStr?: string): { start: Date; end: Date } {
  const date = dateStr ? new Date(dateStr) : new Date();
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

function resolveRange(from?: string, to?: string): { start: Date; end: Date } {
  // `to` is a calendar date (e.g. "2026-07-13"); treat it as inclusive through
  // the end of that day rather than its literal midnight instant, otherwise
  // every order placed "today" is silently excluded from an end=today range.
  const end = to
    ? (() => {
        const d = new Date(to);
        return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - 1);
      })()
    : new Date();
  const start = from ? new Date(from) : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { start, end };
}

/** Sums a nullable Decimal-ish field across rows as halalas (2-decimal SAR fields). */
function sumHalalas(values: Array<{ toString(): string } | null>): number {
  return values.reduce((sum: number, v) => sum + (v ? sarToHalalas(v.toString()) : 0), 0);
}

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Sales: totals for one day (defaults to today). */
  async dailySales(branchId: string | undefined, dateStr: string | undefined) {
    const { start, end } = dayRange(dateStr);
    const orders = await this.prisma.scoped.order.findMany({
      where: {
        status: "completed",
        createdAt: { gte: start, lt: end },
        ...(branchId ? { branchId } : {}),
      },
      select: { subtotal: true, discount: true, vatAmount: true, total: true },
    });

    const subtotal = sumHalalas(orders.map((o) => o.subtotal));
    const discount = sumHalalas(orders.map((o) => o.discount));
    const vatAmount = sumHalalas(orders.map((o) => o.vatAmount));
    const total = sumHalalas(orders.map((o) => o.total));

    return {
      date: start.toISOString().slice(0, 10),
      orderCount: orders.length,
      subtotal: halalasToSar(subtotal),
      discount: halalasToSar(discount),
      vatAmount: halalasToSar(vatAmount),
      total: halalasToSar(total),
      avgOrderValue: orders.length > 0 ? halalasToSar(Math.round(total / orders.length)) : "0.00",
    };
  }

  /** Sales: best-selling products by quantity within a date range. */
  async bestSellers(branchId: string | undefined, from: string | undefined, to: string | undefined, limit = 10) {
    const { start, end } = resolveRange(from, to);
    const items = await this.prisma.scoped.orderItem.findMany({
      where: {
        order: {
          status: "completed",
          createdAt: { gte: start, lte: end },
          ...(branchId ? { branchId } : {}),
        },
      },
      select: { productId: true, productSnapshot: true, quantity: true, lineTotal: true },
    });

    const byProduct = new Map<
      string,
      { productId: string; name: string; nameEn: string | null; quantitySold: number; revenueHalalas: number }
    >();
    for (const item of items) {
      const snapshot = item.productSnapshot as { name: string; nameEn: string | null };
      const entry = byProduct.get(item.productId) ?? {
        productId: item.productId,
        name: snapshot.name,
        nameEn: snapshot.nameEn,
        quantitySold: 0,
        revenueHalalas: 0,
      };
      entry.quantitySold += item.quantity;
      entry.revenueHalalas += sarToHalalas(item.lineTotal.toString());
      byProduct.set(item.productId, entry);
    }

    return [...byProduct.values()]
      .sort((a, b) => b.quantitySold - a.quantitySold)
      .slice(0, limit)
      .map((entry) => ({
        productId: entry.productId,
        name: entry.name,
        nameEn: entry.nameEn,
        quantitySold: entry.quantitySold,
        revenue: halalasToSar(entry.revenueHalalas),
      }));
  }

  /** Operations: order volume, average order value, average preparation time. */
  async operations(branchId: string | undefined, from: string | undefined, to: string | undefined) {
    const { start, end } = resolveRange(from, to);
    const baseWhere = {
      createdAt: { gte: start, lte: end },
      ...(branchId ? { branchId } : {}),
    };

    const [completed, cancelled] = await Promise.all([
      this.prisma.scoped.order.findMany({
        where: { ...baseWhere, status: "completed" },
        select: { id: true, total: true },
      }),
      this.prisma.scoped.order.count({ where: { ...baseWhere, status: "cancelled" } }),
    ]);

    const totalHalalas = sumHalalas(completed.map((o) => o.total));
    const avgOrderValue =
      completed.length > 0 ? halalasToSar(Math.round(totalHalalas / completed.length)) : "0.00";

    // Average prep time: confirmed -> ready, per order, from the status history.
    const orderIds = completed.map((o) => o.id);
    const history =
      orderIds.length > 0
        ? await this.prisma.scoped.orderStatusHistory.findMany({
            where: { orderId: { in: orderIds }, toStatus: { in: ["confirmed", "ready"] } },
            select: { orderId: true, toStatus: true, createdAt: true },
            orderBy: { createdAt: "asc" },
          })
        : [];

    const timestampsByOrder = new Map<string, { confirmed?: Date; ready?: Date }>();
    for (const row of history) {
      const entry = timestampsByOrder.get(row.orderId) ?? {};
      if (row.toStatus === "confirmed" && !entry.confirmed) entry.confirmed = row.createdAt;
      if (row.toStatus === "ready" && !entry.ready) entry.ready = row.createdAt;
      timestampsByOrder.set(row.orderId, entry);
    }
    const prepTimesMinutes = [...timestampsByOrder.values()]
      .filter((entry) => entry.confirmed && entry.ready)
      .map((entry) => (entry.ready!.getTime() - entry.confirmed!.getTime()) / 60000);
    const avgPrepTimeMinutes =
      prepTimesMinutes.length > 0
        ? Number((prepTimesMinutes.reduce((a, b) => a + b, 0) / prepTimesMinutes.length).toFixed(1))
        : null;

    return {
      orderCount: completed.length,
      cancelledCount: cancelled,
      avgOrderValue,
      avgPrepTimeMinutes,
    };
  }

  /** Financial: revenue, discounts, VAT and food-cost summary. */
  async financial(branchId: string | undefined, from: string | undefined, to: string | undefined) {
    const { start, end } = resolveRange(from, to);
    const where = {
      status: "completed" as const,
      createdAt: { gte: start, lte: end },
      ...(branchId ? { branchId } : {}),
    };

    const orders = await this.prisma.scoped.order.findMany({
      where,
      select: { total: true, discount: true, vatAmount: true },
    });
    const totalHalalas = sumHalalas(orders.map((o) => o.total));
    const discountHalalas = sumHalalas(orders.map((o) => o.discount));
    const vatHalalas = sumHalalas(orders.map((o) => o.vatAmount));
    const revenueHalalas = totalHalalas - vatHalalas; // net of VAT (VAT is a pass-through, not revenue)

    const costAgg = await this.prisma.scoped.orderItem.aggregate({
      where: { order: where },
      _sum: { lineCost: true },
    });
    const foodCostUnits = costAgg._sum.lineCost ? sarToCostUnits(costAgg._sum.lineCost.toString()) : 0;
    const foodCostHalalas = Math.round(foodCostUnits / 100);

    const grossMarginHalalas = revenueHalalas - foodCostHalalas;
    const grossMarginPercent =
      revenueHalalas > 0 ? ((grossMarginHalalas / revenueHalalas) * 100).toFixed(2) : "0.00";
    const foodCostPercent =
      revenueHalalas > 0 ? ((foodCostHalalas / revenueHalalas) * 100).toFixed(2) : "0.00";

    return {
      orderCount: orders.length,
      revenue: halalasToSar(revenueHalalas),
      discounts: halalasToSar(discountHalalas),
      vatCollected: halalasToSar(vatHalalas),
      total: halalasToSar(totalHalalas),
      foodCost: halalasToSar(foodCostHalalas),
      foodCostPercent,
      grossMargin: halalasToSar(grossMarginHalalas),
      grossMarginPercent,
    };
  }

  /** Dashboard summary card: today's headline numbers in one call. */
  async dashboardSummary(branchId: string | undefined) {
    const [sales, bestSellers, lowStock, autoHidden] = await Promise.all([
      this.dailySales(branchId, undefined),
      this.bestSellers(branchId, undefined, undefined, 5),
      this.prisma.scoped.stockLevel.findMany({
        where: { ...(branchId ? { branchId } : {}), ingredient: { reorderLevel: { not: null } } },
        include: { ingredient: { select: { id: true, name: true, nameEn: true, reorderLevel: true } } },
      }),
      this.prisma.scoped.productStockHide.findMany({
        where: { ...(branchId ? { branchId } : {}) },
        include: {
          product: { select: { id: true, name: true, nameEn: true } },
          branch: { select: { id: true, name: true, nameEn: true } },
          ingredient: { select: { id: true, name: true, nameEn: true } },
        },
      }),
    ]);

    const lowStockAlerts = lowStock
      .filter((level) => Number(level.quantity) <= Number(level.ingredient.reorderLevel))
      .map((level) => ({
        ingredientId: level.ingredient.id,
        name: level.ingredient.name,
        nameEn: level.ingredient.nameEn,
        quantity: level.quantity.toString(),
        reorderLevel: level.ingredient.reorderLevel!.toString(),
      }));

    const autoHiddenAlerts = autoHidden.map((hide) => ({
      productId: hide.product.id,
      productName: hide.product.name,
      productNameEn: hide.product.nameEn,
      branchName: hide.branch.name,
      branchNameEn: hide.branch.nameEn,
      ingredientName: hide.ingredient.name,
      ingredientNameEn: hide.ingredient.nameEn,
      hiddenAt: hide.hiddenAt,
    }));

    return {
      todaySales: {
        orderCount: sales.orderCount,
        total: sales.total,
        avgOrderValue: sales.avgOrderValue,
      },
      bestSellers,
      lowStockAlerts,
      autoHiddenAlerts,
    };
  }

  /** Ratings: overall average, per-branch breakdown, and low-rating (<=3) follow-up list. */
  async ratingsSummary(branchId: string | undefined, from: string | undefined, to: string | undefined) {
    const { start, end } = resolveRange(from, to);
    const rated = await this.prisma.scoped.orderFeedbackRequest.findMany({
      where: {
        rating: { not: null },
        ratedAt: { gte: start, lte: end },
        ...(branchId ? { branchId } : {}),
      },
      select: {
        id: true,
        rating: true,
        comment: true,
        ratedAt: true,
        branchId: true,
        orderId: true,
        order: { select: { orderNumber: true, customerName: true } },
        branch: { select: { id: true, name: true, nameEn: true } },
        primaryProduct: { select: { name: true, nameEn: true } },
      },
      orderBy: { ratedAt: "desc" },
    });

    const count = rated.length;
    const avgRating =
      count > 0 ? Number((rated.reduce((sum, r) => sum + (r.rating ?? 0), 0) / count).toFixed(2)) : null;

    const byBranchMap = new Map<
      string,
      { branchId: string; name: string; nameEn: string | null; count: number; sum: number }
    >();
    for (const r of rated) {
      const entry = byBranchMap.get(r.branchId) ?? {
        branchId: r.branchId,
        name: r.branch.name,
        nameEn: r.branch.nameEn,
        count: 0,
        sum: 0,
      };
      entry.count += 1;
      entry.sum += r.rating ?? 0;
      byBranchMap.set(r.branchId, entry);
    }
    const byBranch = [...byBranchMap.values()].map((entry) => ({
      branchId: entry.branchId,
      name: entry.name,
      nameEn: entry.nameEn,
      count: entry.count,
      avgRating: Number((entry.sum / entry.count).toFixed(2)),
    }));

    const lowRatings = rated
      .filter((r) => (r.rating ?? 0) <= 3)
      .map((r) => ({
        id: r.id,
        orderId: r.orderId,
        orderNumber: r.order.orderNumber,
        customerName: r.order.customerName,
        rating: r.rating!,
        comment: r.comment,
        ratedAt: r.ratedAt,
        branchName: r.branch.name,
        branchNameEn: r.branch.nameEn,
        productName: r.primaryProduct?.name ?? null,
        productNameEn: r.primaryProduct?.nameEn ?? null,
      }));

    return { avgRating, count, byBranch, lowRatings };
  }
}
