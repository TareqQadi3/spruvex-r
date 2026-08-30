import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { Throttle, ThrottlerGuard } from "@nestjs/throttler";

import { Public } from "../../shared/rbac/public.decorator";
import { GuestTableOrderDto, GuestTakeawayOrderDto } from "./dto/order.dto";
import { GuestOrderingService } from "./guest-ordering.service";

/**
 * Public guest endpoints for the customer ordering app. No account required, but:
 * - rate-limited per IP,
 * - scoped strictly by a valid table QR token / restaurant slug,
 * - Idempotency-Key mandatory on order creation,
 * - order tracking uses the order UUID as an unguessable capability.
 */
@Public()
@UseGuards(ThrottlerGuard)
@Controller("public")
export class GuestOrderingController {
  constructor(private readonly guest: GuestOrderingService) {}

  // --- QR table ordering ---

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get("tables/:qrToken")
  tableInfo(@Param("qrToken") qrToken: string) {
    return this.guest.tableInfo(qrToken);
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get("tables/:qrToken/menu")
  menu(@Param("qrToken") qrToken: string) {
    return this.guest.menu(qrToken);
  }

  // A shared table can have several phones behind the same restaurant WiFi
  // IP, each placing multiple rounds — the old single-order-per-scan limit
  // of 10/min was tuned before that was possible, so this matches the
  // other guest table routes' limit instead of guessing a new number.
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post("tables/:qrToken/orders")
  createOrder(
    @Param("qrToken") qrToken: string,
    @Body() dto: GuestTableOrderDto,
    @Headers("idempotency-key") idempotencyKey: string,
  ) {
    return this.guest.createOrder(qrToken, dto, idempotencyKey);
  }

  // --- External ordering link: /restaurant/{slug} (pickup) ---

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get("restaurants/:slug")
  restaurantInfo(@Param("slug") slug: string) {
    return this.guest.restaurantInfo(slug);
  }

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get("restaurants/:slug/branches/:branchSlug/menu")
  branchMenu(@Param("slug") slug: string, @Param("branchSlug") branchSlug: string) {
    return this.guest.branchMenu(slug, branchSlug);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("restaurants/:slug/branches/:branchSlug/orders")
  createTakeawayOrder(
    @Param("slug") slug: string,
    @Param("branchSlug") branchSlug: string,
    @Body() dto: GuestTakeawayOrderDto,
    @Headers("idempotency-key") idempotencyKey: string,
  ) {
    return this.guest.createTakeawayOrder(slug, branchSlug, dto, idempotencyKey);
  }

  // --- Guest order tracking (order UUID = capability) ---

  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Get("orders/:orderId/track")
  track(@Param("orderId", ParseUUIDPipe) orderId: string) {
    return this.guest.track(orderId);
  }
}
