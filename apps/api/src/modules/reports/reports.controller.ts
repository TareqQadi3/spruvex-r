import { Controller, Get, Header, Query, Res } from "@nestjs/common";
import type { Response } from "express";

import { RequirePermission } from "../../shared/rbac/require-permission.decorator";
import { BranchComparisonService } from "./branch-comparison.service";
import {
  BestSellersQueryDto,
  BranchComparisonQueryDto,
  DailySalesQueryDto,
  DateRangeQueryDto,
} from "./dto/reports-query.dto";
import { MenuProfitabilityService } from "./menu-profitability.service";
import { ReportsService } from "./reports.service";
import { VatReturnService } from "./vat-return.service";

@Controller("reports")
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly vatReturn: VatReturnService,
    private readonly branchComparisonService: BranchComparisonService,
    private readonly menuProfitability: MenuProfitabilityService,
  ) {}

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

  /** VAT return summary (JSON) — sales VAT, credit/debit-note impact, per-rate breakdown, per-document line items. */
  @RequirePermission("reports.view")
  @Get("vat-return")
  vatReturnJson(@Query() query: DateRangeQueryDto) {
    return this.vatReturn.vatReturn(query.branchId, query.from, query.to);
  }

  @RequirePermission("reports.export")
  @Get("vat-return.csv")
  @Header("Content-Type", "text/csv; charset=utf-8")
  async vatReturnCsv(@Query() query: DateRangeQueryDto, @Res() res: Response) {
    const result = await this.vatReturn.vatReturn(query.branchId, query.from, query.to);
    const csv = this.vatReturn.toCsv(result);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="vat-return-${result.period.from}-to-${result.period.to}.csv"`,
    );
    // BOM so Excel opens the Arabic labels as UTF-8 instead of guessing a legacy codepage.
    res.send("﻿" + csv);
  }

  @RequirePermission("reports.export")
  @Get("vat-return.pdf")
  @Header("Content-Type", "application/pdf")
  async vatReturnPdf(@Query() query: DateRangeQueryDto, @Res() res: Response) {
    const result = await this.vatReturn.vatReturn(query.branchId, query.from, query.to);
    const pdf = await this.vatReturn.toPdf(result);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="vat-return-${result.period.from}-to-${result.period.to}.pdf"`,
    );
    res.send(pdf);
  }

  /** Branch performance comparison: sales, orders, top products, loyalty usage, ratings — one row per branch. */
  @RequirePermission("reports.view")
  @Get("branch-comparison")
  branchComparison(@Query() query: BranchComparisonQueryDto) {
    return this.branchComparisonService.compare(query.from, query.to, query.branchIds);
  }

  /** Menu profitability: current recipe cost vs. selling price vs. actual units sold, per product. */
  @RequirePermission("reports.view")
  @Get("menu-profitability")
  menuProfitabilityJson(@Query() query: DateRangeQueryDto) {
    return this.menuProfitability.menuProfitability(query.branchId, query.from, query.to);
  }

  @RequirePermission("reports.export")
  @Get("menu-profitability.csv")
  @Header("Content-Type", "text/csv; charset=utf-8")
  async menuProfitabilityCsv(@Query() query: DateRangeQueryDto, @Res() res: Response) {
    const result = await this.menuProfitability.menuProfitability(query.branchId, query.from, query.to);
    const csv = this.menuProfitability.toCsv(result);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="menu-profitability-${result.period.from}-to-${result.period.to}.csv"`,
    );
    res.send("﻿" + csv);
  }
}
