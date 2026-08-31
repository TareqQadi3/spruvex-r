import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";

import { RequirePermission } from "../../shared/rbac/require-permission.decorator";
import { MULTER_HARD_CEILING_BYTES } from "../uploads/uploads.service";
import {
  CancelPurchaseInvoiceDto,
  CreatePurchaseInvoiceDto,
  CreateSupplierDto,
  ListPurchaseInvoicesQueryDto,
  UpdatePurchaseSettingsDto,
  UpdateSupplierDto,
} from "./dto/purchases.dto";
import { PurchasesService } from "./purchases.service";
import { SuppliersService } from "./suppliers.service";

@Controller("purchases")
export class PurchasesController {
  constructor(
    private readonly purchases: PurchasesService,
    private readonly suppliers: SuppliersService,
  ) {}

  // ------------------------------------------------------------------ //
  // Suppliers
  // ------------------------------------------------------------------ //

  @RequirePermission("purchases.view")
  @Get("suppliers")
  listSuppliers(@Query("includeInactive") includeInactive?: string) {
    return this.suppliers.list(includeInactive === "true");
  }

  @RequirePermission("purchases.view")
  @Get("suppliers/:id")
  getSupplier(@Param("id", ParseUUIDPipe) id: string) {
    return this.suppliers.get(id);
  }

  @RequirePermission("purchases.create")
  @Post("suppliers")
  createSupplier(@Body() dto: CreateSupplierDto) {
    return this.suppliers.create(dto);
  }

  @RequirePermission("purchases.create")
  @Patch("suppliers/:id")
  updateSupplier(@Param("id", ParseUUIDPipe) id: string, @Body() dto: UpdateSupplierDto) {
    return this.suppliers.update(id, dto);
  }

  // ------------------------------------------------------------------ //
  // Settings
  // ------------------------------------------------------------------ //

  @RequirePermission("purchases.view")
  @Get("settings")
  getSettings() {
    return this.purchases.getSettings();
  }

  @RequirePermission("purchases.create")
  @Patch("settings")
  updateSettings(@Body() dto: UpdatePurchaseSettingsDto) {
    return this.purchases.updateSettings(dto);
  }

  // ------------------------------------------------------------------ //
  // Purchase invoices
  // ------------------------------------------------------------------ //

  @RequirePermission("purchases.view")
  @Get("invoices")
  listInvoices(@Query() query: ListPurchaseInvoicesQueryDto) {
    return this.purchases.list(query);
  }

  @RequirePermission("purchases.view")
  @Get("invoices/:id")
  getInvoice(@Param("id", ParseUUIDPipe) id: string) {
    return this.purchases.get(id);
  }

  @RequirePermission("purchases.create")
  @Post("invoices")
  createInvoice(@Body() dto: CreatePurchaseInvoiceDto) {
    return this.purchases.create(dto);
  }

  /** Confirms a draft — posts stock/expense entries and makes it count toward input VAT. */
  @RequirePermission("purchases.create")
  @Post("invoices/:id/confirm")
  confirmInvoice(@Param("id", ParseUUIDPipe) id: string) {
    return this.purchases.confirm(id);
  }

  @RequirePermission("purchases.void")
  @Post("invoices/:id/cancel")
  cancelInvoice(@Param("id", ParseUUIDPipe) id: string, @Body() dto: CancelPurchaseInvoiceDto) {
    return this.purchases.cancel(id, dto);
  }

  @RequirePermission("purchases.create")
  @Post("invoices/:id/attachment")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MULTER_HARD_CEILING_BYTES } }))
  async uploadAttachment(
    @Param("id", ParseUUIDPipe) id: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException("No file provided (expected multipart field 'file')");
    }
    return this.purchases.attach(id, file);
  }

  /** Private — gated by purchases.view, never the public /uploads/ route. */
  @RequirePermission("purchases.view")
  @Get("invoices/:id/attachment")
  async downloadAttachment(@Param("id", ParseUUIDPipe) id: string, @Res() res: Response) {
    const { buffer, contentType } = await this.purchases.getAttachment(id);
    res.setHeader("Content-Type", contentType);
    res.send(buffer);
  }
}
