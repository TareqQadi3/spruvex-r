import { Module } from "@nestjs/common";

import { InventoryModule } from "../inventory/inventory.module";
import { UploadsModule } from "../uploads/uploads.module";
import { PurchasesController } from "./purchases.controller";
import { PurchasesService } from "./purchases.service";
import { SuppliersService } from "./suppliers.service";

/**
 * Purchasing — suppliers and manually-entered supplier purchase invoices.
 * Confirming an invoice posts each line to the SAME real ledgers everything
 * else uses (InventoryModule's stock receiving for "stock" lines, a new
 * Expense row for "expense" lines) rather than a parallel bookkeeping
 * system, and is the input-VAT source of truth for reports/vat-return
 * (ReportsModule reads PurchaseInvoice directly, no import needed here).
 */
@Module({
  imports: [InventoryModule, UploadsModule],
  controllers: [PurchasesController],
  providers: [PurchasesService, SuppliersService],
})
export class PurchasesModule {}
