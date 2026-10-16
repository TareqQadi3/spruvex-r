import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import type { Response } from "express";

import { RequirePermission } from "../../shared/rbac/require-permission.decorator";
import {
  CloseSessionDto,
  CreateFloorDto,
  CreateTableDto,
  OpenSessionDto,
  UpdateFloorDto,
  UpdateTableDto,
} from "./dto/tables.dto";
import { FloorsService } from "./floors.service";
import { QrService } from "./qr.service";
import { TableSessionsService } from "./table-sessions.service";
import { TablesService } from "./tables.service";

@Controller("floors")
export class FloorsController {
  constructor(private readonly floors: FloorsService) {}

  @RequirePermission("tables.view")
  @Get()
  list(@Query("branchId") branchId?: string) {
    return this.floors.list(branchId);
  }

  @RequirePermission("tables.manage")
  @Post()
  create(@Body() dto: CreateFloorDto) {
    return this.floors.create(dto);
  }

  @RequirePermission("tables.manage")
  @Patch(":id")
  update(@Param("id", ParseUUIDPipe) id: string, @Body() dto: UpdateFloorDto) {
    return this.floors.update(id, dto);
  }

  @RequirePermission("tables.manage")
  @Delete(":id")
  remove(@Param("id", ParseUUIDPipe) id: string) {
    return this.floors.softDelete(id);
  }
}

@Controller("tables")
export class TablesController {
  constructor(
    private readonly tables: TablesService,
    private readonly sessions: TableSessionsService,
    private readonly qr: QrService,
  ) {}

  @RequirePermission("tables.view")
  @Get()
  list(@Query("branchId") branchId?: string, @Query("floorId") floorId?: string) {
    return this.tables.list({ branchId, floorId });
  }

  /** Cashier's open-tables view — declared before :id routes. */
  @RequirePermission("tables.view")
  @Get("sessions/open")
  listOpenSessions(@Query("branchId") branchId?: string) {
    return this.sessions.listOpen(branchId);
  }

  /** QR print sheet for a branch/floor — declared before :id routes. */
  @RequirePermission("tables.view")
  @Get("qr-sheet.pdf")
  @Header("Content-Type", "application/pdf")
  async qrSheet(
    @Res() res: Response,
    @Query("branchId") branchId?: string,
    @Query("floorId") floorId?: string,
  ) {
    const pdf = await this.qr.printSheet({ branchId, floorId });
    res.setHeader("Content-Disposition", 'attachment; filename="spruvex-qr-tables.pdf"');
    res.send(pdf);
  }

  @RequirePermission("tables.manage")
  @Post()
  create(@Body() dto: CreateTableDto) {
    return this.tables.create(dto);
  }

  @RequirePermission("tables.manage")
  @Patch(":id")
  update(@Param("id", ParseUUIDPipe) id: string, @Body() dto: UpdateTableDto) {
    return this.tables.update(id, dto);
  }

  @RequirePermission("tables.manage")
  @Delete(":id")
  remove(@Param("id", ParseUUIDPipe) id: string) {
    return this.tables.softDelete(id);
  }

  @RequirePermission("tables.manage")
  @HttpCode(200)
  @Post(":id/regenerate-qr")
  regenerateQr(@Param("id", ParseUUIDPipe) id: string) {
    return this.tables.regenerateQr(id);
  }

  @RequirePermission("tables.view")
  @Get(":id/qr.png")
  @Header("Content-Type", "image/png")
  async qrPng(@Param("id", ParseUUIDPipe) id: string, @Res() res: Response) {
    const { png, number } = await this.qr.qrPng(id);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="table-${encodeURIComponent(number)}-qr.png"`,
    );
    res.send(png);
  }

  @RequirePermission("tables.view")
  @Get(":id/qr-url")
  qrUrl(@Param("id", ParseUUIDPipe) id: string) {
    return this.qr.qrUrl(id);
  }

  // --- Table sessions (foundation for the ordering engine) ---

  @RequirePermission("tables.manage")
  @HttpCode(200)
  @Post(":id/sessions/open")
  openSession(@Param("id", ParseUUIDPipe) id: string, @Body() dto: OpenSessionDto) {
    return this.sessions.open(id, dto.notes);
  }

  @RequirePermission("tables.manage")
  @HttpCode(200)
  @Post(":id/sessions/close")
  closeSession(@Param("id", ParseUUIDPipe) id: string, @Body() dto: CloseSessionDto) {
    return this.sessions.close(id, { force: dto.force });
  }
}
