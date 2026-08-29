import { Module } from "@nestjs/common";

import { OrderingModule } from "../ordering/ordering.module";
import { DebitNotesService } from "./debit-notes.service";
import { PaymentsController } from "./payments.controller";
import { PaymentsService } from "./payments.service";
import { PublicReceiptController } from "./public-receipt.controller";
import { ReceiptsService } from "./receipts.service";
import { RefundsService } from "./refunds.service";
import { ZatcaSettingsController } from "./zatca/zatca-settings.controller";
import { ZatcaSettingsService } from "./zatca/zatca-settings.service";
import { ZatcaInvoiceService } from "./zatca/zatca-invoice.service";

/**
 * Payments module — cash/card/split checkout with open-shift requirement,
 * over/duplicate-payment prevention, auto-completion on full payment, the
 * receipt foundation, and refunds/credit-debit notes (with ZATCA Phase 2
 * wired in behind each tenant's own opt-in toggle).
 */
@Module({
  imports: [OrderingModule],
  controllers: [PaymentsController, ZatcaSettingsController, PublicReceiptController],
  providers: [
    PaymentsService,
    ReceiptsService,
    RefundsService,
    DebitNotesService,
    ZatcaInvoiceService,
    ZatcaSettingsService,
  ],
  exports: [PaymentsService, ZatcaInvoiceService],
})
export class PaymentsModule {}
