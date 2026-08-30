import { Module } from "@nestjs/common";

import { BranchComparisonService } from "./branch-comparison.service";
import { ReportsController } from "./reports.controller";
import { ReportsService } from "./reports.service";
import { VatReturnService } from "./vat-return.service";

/**
 * Reports & Analytics module (Phase 7) — sales, operations and financial
 * reporting, plus the dashboard summary card. Read-only aggregation over
 * the Ordering/Inventory domains; no new persisted state.
 */
@Module({
  controllers: [ReportsController],
  providers: [ReportsService, VatReturnService, BranchComparisonService],
})
export class ReportsModule {}
