import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";

import { RequirePermission } from "../../shared/rbac/require-permission.decorator";
import { CouponsService } from "./coupons.service";
import { CreateCouponDto, UpdateCouponDto } from "./dto/coupon.dto";

@Controller("marketing/coupons")
export class CouponsController {
  constructor(private readonly coupons: CouponsService) {}

  @RequirePermission("marketing.manage_coupons")
  @Get()
  list() {
    return this.coupons.list();
  }

  @RequirePermission("marketing.manage_coupons")
  @Get(":id")
  get(@Param("id", ParseUUIDPipe) id: string) {
    return this.coupons.get(id);
  }

  @RequirePermission("marketing.manage_coupons")
  @Post()
  create(@Body() dto: CreateCouponDto) {
    return this.coupons.create(dto);
  }

  @RequirePermission("marketing.manage_coupons")
  @Patch(":id")
  update(@Param("id", ParseUUIDPipe) id: string, @Body() dto: UpdateCouponDto) {
    return this.coupons.update(id, dto);
  }

  @RequirePermission("marketing.manage_coupons")
  @Delete(":id")
  remove(@Param("id", ParseUUIDPipe) id: string) {
    return this.coupons.softDelete(id);
  }
}
