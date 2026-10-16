import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";

import { Public } from "../../shared/rbac/public.decorator";
import { RequireAuthenticated } from "../../shared/rbac/require-authenticated.decorator";
import { TenantContextService } from "../../shared/tenancy/tenant-context.service";
import { MULTER_HARD_CEILING_BYTES, UploadsService } from "./uploads.service";

const FILENAME_RE = /^[0-9a-f-]{36}\.(png|jpg|webp)$/;

/**
 * Generic image upload: any authenticated tenant member can upload a file
 * and get back a URL — merely getting a URL isn't a sensitive action, so
 * this one endpoint serves logo, product-image and category-image uploads
 * alike, rather than duplicating an upload path per feature. The actual
 * sensitive step (attaching that URL to a tenant/product/category record)
 * is already permission-gated at each of those existing update endpoints.
 */
@Controller("uploads")
export class UploadsController {
  constructor(
    private readonly uploads: UploadsService,
    private readonly tenantContext: TenantContextService,
  ) {}

  @RequireAuthenticated()
  @Post("image")
  @UseInterceptors(
    FileInterceptor("file", { limits: { fileSize: MULTER_HARD_CEILING_BYTES } }),
  )
  async uploadImage(@UploadedFile() file?: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException("No file provided (expected multipart field 'file')");
    }
    const tenantId = this.tenantContext.tenantIdOrThrow;
    return this.uploads.saveImage(tenantId, file);
  }

  /** Public — these are logo/menu images meant to be visible on the public ordering site. */
  @Public()
  @Get(":tenantId/:filename")
  @Header("Cache-Control", "public, max-age=31536000, immutable")
  async serve(
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Param("filename") filename: string,
    @Res() res: Response,
  ) {
    if (!FILENAME_RE.test(filename)) {
      throw new BadRequestException("Invalid filename");
    }
    const { buffer, contentType } = await this.uploads.readImage(tenantId, filename);
    res.setHeader("Content-Type", contentType);
    res.send(buffer);
  }
}
