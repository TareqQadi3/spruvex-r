import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from "@nestjs/common";

import { ORDER_STATUSES, type OrderStatus } from "@spruvex-r/types";

import { ApplyDiscountDto } from "../payments/dto/payments.dto";
import { RequirePermission } from "../../shared/rbac/require-permission.decorator";
import {
  AppendOrderItemsDto,
  CreateOrderDto,
  EditOrderItemsDto,
  SetOrderCustomerDto,
  TransitionOrderDto,
} from "./dto/order.dto";
import { OrderingService } from "./ordering.service";

function parseStatuses(raw?: string): OrderStatus[] | undefined {
  if (!raw) return undefined;
  const list = raw.split(",").map((s) => s.trim());
  return list.filter((s): s is OrderStatus =>
    (ORDER_STATUSES as readonly string[]).includes(s),
  );
}

@Controller("orders")
export class OrdersController {
  constructor(private readonly ordering: OrderingService) {}

  @RequirePermission("orders.view")
  @Get()
  list(
    @Query("branchId") branchId?: string,
    @Query("statuses") statuses?: string,
    @Query("limit") limit?: string,
  ) {
    return this.ordering.list({
      branchId,
      statuses: parseStatuses(statuses),
      limit: limit ? Number(limit) : undefined,
    });
  }

  @RequirePermission("orders.view")
  @Get(":id")
  get(@Param("id", ParseUUIDPipe) id: string) {
    return this.ordering.get(id);
  }

  @RequirePermission("orders.create")
  @Post()
  create(
    @Body() dto: CreateOrderDto,
    @Headers("idempotency-key") idempotencyKey: string,
  ) {
    return this.ordering.create(dto, { source: "pos" }, idempotencyKey);
  }

  /** Cancellation (status=cancelled) additionally requires orders.void. */
  @RequirePermission("orders.update_status")
  @HttpCode(200)
  @Post(":id/status")
  transition(@Param("id", ParseUUIDPipe) id: string, @Body() dto: TransitionOrderDto) {
    return this.ordering.transition(id, dto.status, { reason: dto.reason });
  }

  /** Replace items while the order is still `new` (before confirmation). */
  @RequirePermission("orders.create")
  @Put(":id/items")
  editItems(@Param("id", ParseUUIDPipe) id: string, @Body() dto: EditOrderItemsDto) {
    return this.ordering.editItems(id, dto.items);
  }

  /** Cashier/waiter "add to this table's order" — appends a new round to a
   * shared table-session order at any point before it's settled, same
   * mechanism the QR guest flow uses. */
  @RequirePermission("orders.create")
  @Post(":id/items")
  appendItems(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: AppendOrderItemsDto,
    @Headers("idempotency-key") idempotencyKey: string,
  ) {
    return this.ordering.appendItems(id, dto.items, dto.participantPhone ?? null, idempotencyKey);
  }

  /** Read-only bill-split suggestion — charge each amount via the existing multi-tender payments endpoint. */
  @RequirePermission("orders.view")
  @Get(":id/split")
  split(@Param("id", ParseUUIDPipe) id: string, @Query("mode") mode?: string) {
    return this.ordering.computeSplit(id, mode === "by_item" ? "by_item" : "equal");
  }

  /** POS "add customer at checkout" — needed so a walk-in can use the loyalty program. */
  @RequirePermission("orders.create")
  @Put(":id/customer")
  setCustomer(@Param("id", ParseUUIDPipe) id: string, @Body() dto: SetOrderCustomerDto) {
    return this.ordering.setCustomer(id, dto.customerPhone, dto.customerName);
  }

  @RequirePermission("orders.discount")
  @HttpCode(200)
  @Post(":id/discount")
  applyDiscount(@Param("id", ParseUUIDPipe) id: string, @Body() dto: ApplyDiscountDto) {
    return this.ordering.applyDiscount(id, dto);
  }

  @RequirePermission("orders.discount")
  @Delete(":id/discount")
  removeDiscount(@Param("id", ParseUUIDPipe) id: string) {
    return this.ordering.removeDiscount(id);
  }
}
