import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";

import { RequireAuthenticated } from "../../shared/rbac/require-authenticated.decorator";
import { RequirePermission } from "../../shared/rbac/require-permission.decorator";
import { MULTER_HARD_CEILING_BYTES } from "../uploads/uploads.service";
import { SetImportMappingDto } from "./dto/import.dto";
import { ImportsService } from "./imports.service";

const UPLOAD_INTERCEPTOR = UseInterceptors(
  FileInterceptor("file", { limits: { fileSize: MULTER_HARD_CEILING_BYTES } }),
);

/**
 * Bulk data import — see ImportsService's doc comment for the full
 * upload -> mapping -> preview -> execute flow. The three upload routes
 * are split by type (rather than one route taking `type` in the body) so
 * each can carry its own real @RequirePermission — every other route
 * operates on an existing job and re-checks the SAME permission against
 * that job's stored type inside the service (a job's type never changes
 * after upload, so this is equivalent, just enforced one level down).
 */
@Controller("imports")
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  @RequirePermission("menu.manage")
  @Post("categories")
  @UPLOAD_INTERCEPTOR
  uploadCategories(@UploadedFile() file?: Express.Multer.File) {
    return this.imports.createJob("categories", file);
  }

  @RequirePermission("menu.manage")
  @Post("products")
  @UPLOAD_INTERCEPTOR
  uploadProducts(@UploadedFile() file?: Express.Multer.File) {
    return this.imports.createJob("products", file);
  }

  @RequirePermission("loyalty.manage")
  @Post("customers")
  @UPLOAD_INTERCEPTOR
  uploadCustomers(@UploadedFile() file?: Express.Multer.File) {
    return this.imports.createJob("customers", file);
  }

  @RequireAuthenticated()
  @Get()
  list() {
    return this.imports.list();
  }

  @RequireAuthenticated()
  @Get(":id")
  get(@Param("id", ParseUUIDPipe) id: string) {
    return this.imports.get(id);
  }

  @RequireAuthenticated()
  @Patch(":id/mapping")
  setMapping(@Param("id", ParseUUIDPipe) id: string, @Body() dto: SetImportMappingDto) {
    return this.imports.setMapping(id, dto.mapping);
  }

  @RequireAuthenticated()
  @Get(":id/preview")
  preview(@Param("id", ParseUUIDPipe) id: string) {
    return this.imports.preview(id);
  }

  @RequireAuthenticated()
  @HttpCode(200)
  @Post(":id/execute")
  execute(@Param("id", ParseUUIDPipe) id: string) {
    return this.imports.execute(id);
  }

  @RequireAuthenticated()
  @Get(":id/failed-rows.csv")
  @Header("Content-Type", "text/csv; charset=utf-8")
  async failedRowsCsv(@Param("id", ParseUUIDPipe) id: string, @Res() res: Response) {
    const { filename, csv } = await this.imports.failedRowsCsv(id);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    // BOM so Excel opens Arabic labels as UTF-8 instead of guessing a legacy codepage.
    res.send("﻿" + csv);
  }
}
