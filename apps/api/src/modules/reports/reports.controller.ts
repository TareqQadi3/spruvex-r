import { Controller, Get, Query } from "@nestjs/common";

import { RequirePermission } from "../../shared/rbac/require-permission.decorator";
import {
  BestSellersQueryDto,
  DailySalesQueryDto,
  DateRangeQueryDto,
} from "./dto/reports-query.dto";
import { ReportsService } from "./reports.service";

@Controller("reports")
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @RequirePermission("reports.view")
  @Get("sales/daily")
  dailySales(@Query() query: DailySalesQueryDto) {
    return this.reports.dailySales(query.branchId, query.date);
  }

  @RequirePermission("reports.view")
  @Get("sales/best-sellers")
  bestSellers(@Query() query: BestSellersQueryDto) {
    return this.reports.bestSellers(query.branchId, query.from, query.to, query.limit);
  }

  @RequirePermission("reports.view")
  @Get("operations")
  operations(@Query() query: DateRangeQueryDto) {
    return this.reports.operations(query.branchId, query.from, query.to);
  }

  @RequirePermission("reports.view")
  @Get("financial")
  financial(@Query() query: DateRangeQueryDto) {
    return this.reports.financial(query.branchId, query.from, query.to);
  }

  /** Dashboard summary card: today's sales, best sellers, low-stock + auto-hidden-item alerts. */
  @RequirePermission("reports.view")
  @Get("dashboard-summary")
  dashboardSummary(@Query("branchId") branchId?: string) {
    return this.reports.dashboardSummary(branchId);
  }

  @RequirePermission("reports.view")
  @Get("ratings")
  ratings(@Query() query: DateRangeQueryDto) {
    return this.reports.ratingsSummary(query.branchId, query.from, query.to);
  }
}
