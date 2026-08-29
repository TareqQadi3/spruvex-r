import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
} from "@nestjs/common";
import type { Response } from "express";
import * as QRCode from "qrcode";

import { RequirePermission } from "../../shared/rbac/require-permission.decorator";
import { DebitNotesService } from "./debit-notes.service";
import { IssueDebitNoteDto, RecordPaymentDto, RefundOrderDto } from "./dto/payments.dto";
import { PaymentsService } from "./payments.service";
import { ReceiptsService } from "./receipts.service";
import { RefundsService } from "./refunds.service";

@Controller("orders/:orderId")
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly receipts: ReceiptsService,
    private readonly refunds: RefundsService,
    private readonly debitNotes: DebitNotesService,
  ) {}

  @RequirePermission("orders.view")
  @Get("payments")
  summary(@Param("orderId", ParseUUIDPipe) orderId: string) {
    return this.payments.summary(orderId);
  }

  @RequirePermission("payments.record")
  @Post("payments")
  record(
    @Param("orderId", ParseUUIDPipe) orderId: string,
    @Body() dto: RecordPaymentDto,
    @Headers("idempotency-key") idempotencyKey: string,
  ) {
    return this.payments.record(orderId, dto, idempotencyKey);
  }

  @RequirePermission("orders.view")
  @Get("receipt")
  receipt(@Param("orderId", ParseUUIDPipe) orderId: string) {
    return this.receipts.getOrCreate(orderId);
  }

  /** ZATCA Phase 1 QR image (TLV/Base64 content) for thermal/receipt printing. */
  @RequirePermission("orders.view")
  @Get("receipt/qr.png")
  @Header("Content-Type", "image/png")
  async receiptQr(@Param("orderId", ParseUUIDPipe) orderId: string, @Res() res: Response) {
    const receipt = await this.receipts.getOrCreate(orderId);
    if (!receipt.qrPayload) {
      throw new NotFoundException(
        "No ZATCA QR — the restaurant has no VAT registration number configured",
      );
    }
    const png = await QRCode.toBuffer(receipt.qrPayload, {
      type: "png",
      width: 300,
      margin: 1,
      errorCorrectionLevel: "M",
    });
    res.send(png);
  }

  @RequirePermission("payments.refund")
  @Post("refund")
  refund(@Param("orderId", ParseUUIDPipe) orderId: string, @Body() dto: RefundOrderDto) {
    return this.refunds.refund(orderId, dto);
  }

  @RequirePermission("payments.refund")
  @Post("debit-note")
  debitNote(@Param("orderId", ParseUUIDPipe) orderId: string, @Body() dto: IssueDebitNoteDto) {
    return this.debitNotes.issue(orderId, dto);
  }
}
