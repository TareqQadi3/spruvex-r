import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";

import { RequirePermission } from "../../shared/rbac/require-permission.decorator";
import {
  CancelStockTransferDto,
  CreateStockTransferDto,
  ListStockTransfersQueryDto,
  ReceiveStockTransferDto,
  RejectStockTransferDto,
} from "./dto/stock-transfer.dto";
import { StockTransfersService } from "./stock-transfers.service";

@Controller("inventory/transfers")
export class StockTransfersController {
  constructor(private readonly transfers: StockTransfersService) {}

  @RequirePermission("inventory.view")
  @Get()
  list(@Query() query: ListStockTransfersQueryDto) {
    return this.transfers.list(query);
  }

  @RequirePermission("inventory.view")
  @Get(":id")
  get(@Param("id", ParseUUIDPipe) id: string) {
    return this.transfers.get(id);
  }

  @RequirePermission("inventory.transfer.create")
  @Post()
  create(@Body() dto: CreateStockTransferDto) {
    return this.transfers.create(dto);
  }

  @RequirePermission("inventory.transfer.create")
  @Post(":id/send")
  send(@Param("id", ParseUUIDPipe) id: string) {
    return this.transfers.send(id);
  }

  @RequirePermission("inventory.transfer.create")
  @Post(":id/cancel")
  cancel(@Param("id", ParseUUIDPipe) id: string, @Body() dto: CancelStockTransferDto) {
    return this.transfers.cancel(id, dto);
  }

  @RequirePermission("inventory.transfer.receive")
  @Post(":id/receive")
  receive(@Param("id", ParseUUIDPipe) id: string, @Body() dto: ReceiveStockTransferDto) {
    return this.transfers.receive(id, dto);
  }

  @RequirePermission("inventory.transfer.receive")
  @Post(":id/reject")
  reject(@Param("id", ParseUUIDPipe) id: string, @Body() dto: RejectStockTransferDto) {
    return this.transfers.reject(id, dto);
  }
}
