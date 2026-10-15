import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";

import type { OrderingChannel } from "@spruvex-r/types";

import { halalasToSar, sarToHalalas } from "../../shared/common/money";
import { PrismaService } from "../../shared/prisma/prisma.service";
import { actorOrNull, TenantContextService } from "../../shared/tenancy/tenant-context.service";
import { CreateCouponDto, UpdateCouponDto } from "./dto/coupon.dto";

const ACTIVE_ORDER_STATUSES_FOR_REDEMPTION = ["cancelled"] as const;

/**
 * Discount coupon codes for the first-party digital ordering checkout
 * (takeaway/delivery only). Tenant-wide, not per-branch — not asked for.
 */
@Injectable()
export class CouponsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  list() {
    return this.prisma.scoped.coupon.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: "desc" },
    });
  }

  async get(id: string) {
    const coupon = await this.prisma.scoped.coupon.findFirst({ where: { id, deletedAt: null } });
    if (!coupon) {
      throw new NotFoundException("Coupon not found");
    }
    return coupon;
  }

  async create(dto: CreateCouponDto) {
    const ctx = this.tenantContext.contextOrThrow;
    this.validateDiscountShape(dto.discountType, dto.discountValue);

    const code = dto.code.trim().toUpperCase();
    const existing = await this.prisma.scoped.coupon.findFirst({
      where: { code, deletedAt: null },
    });
    if (existing) {
      throw new ConflictException(`A coupon with code "${code}" already exists`);
    }

    return this.prisma.scoped.coupon.create({
      data: {
        tenantId: this.tenantContext.tenantIdOrThrow,
        code,
        discountType: dto.discountType,
        discountValue: dto.discountValue,
        maxDiscountAmount: dto.maxDiscountAmount,
        minOrderAmount: dto.minOrderAmount ?? "0",
        channels: dto.channels ?? [],
        startAt: dto.startAt ? new Date(dto.startAt) : null,
        endAt: dto.endAt ? new Date(dto.endAt) : null,
        maxRedemptions: dto.maxRedemptions,
        maxRedemptionsPerCustomer: dto.maxRedemptionsPerCustomer,
        createdBy: actorOrNull(ctx.userId),
      },
    });
  }

  async update(id: string, dto: UpdateCouponDto) {
    const current = await this.get(id);
    if (dto.discountType || dto.discountValue) {
      this.validateDiscountShape(dto.discountType ?? current.discountType, dto.discountValue ?? current.discountValue.toString());
    }
    return this.prisma.scoped.coupon.update({
      where: { id },
      data: {
        discountType: dto.discountType,
        discountValue: dto.discountValue,
        maxDiscountAmount: dto.maxDiscountAmount,
        minOrderAmount: dto.minOrderAmount,
        channels: dto.channels,
        startAt: dto.startAt === undefined ? undefined : dto.startAt ? new Date(dto.startAt) : null,
        endAt: dto.endAt === undefined ? undefined : dto.endAt ? new Date(dto.endAt) : null,
        maxRedemptions: dto.maxRedemptions,
        maxRedemptionsPerCustomer: dto.maxRedemptionsPerCustomer,
        isActive: dto.isActive,
      },
    });
  }

  async softDelete(id: string) {
    await this.get(id);
    return this.prisma.scoped.coupon.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  private validateDiscountShape(type: string, value: string) {
    const n = Number(value);
    if (!(n > 0)) {
      throw new BadRequestException("discountValue must be positive");
    }
    if (type === "percentage" && n > 100) {
      throw new BadRequestException("A percentage coupon cannot exceed 100%");
    }
  }

  /**
   * Read-only estimate for the guest-facing "apply coupon" preview, before
   * an order exists. Checks everything EXCEPT the exact redemption-count
   * race (that final guard runs inside the real order transaction via
   * `redeemInTransaction`, under a row lock) — a tampered/stale preview
   * here can never over-discount the real order, since the real order
   * re-prices the cart and re-validates the coupon from scratch.
   */
  async preview(tenantId: string, code: string, channel: OrderingChannel, subtotalSar: string) {
    const coupon = await this.findActiveOrThrow(tenantId, code);
    const subtotalHalalas = sarToHalalas(subtotalSar);
    this.assertUsable(coupon, channel, subtotalHalalas);
    if (coupon.maxRedemptions != null) {
      const used = await this.prisma
        .forTenant(tenantId)
        .order.count({ where: { couponId: coupon.id, status: { notIn: [...ACTIVE_ORDER_STATUSES_FOR_REDEMPTION] } } });
      if (used >= coupon.maxRedemptions) {
        throw new ConflictException("This coupon has reached its usage limit");
      }
    }
    const discountHalalas = this.computeDiscountHalalas(coupon, subtotalHalalas);
    return { valid: true as const, discountAmount: halalasToSar(discountHalalas) };
  }

  /**
   * Validates + redeems a coupon atomically inside the order-creation
   * transaction: row-locks the coupon so two concurrent orders can never
   * both claim the last redemption slot, re-checks every rule against the
   * REAL priced subtotal (never the client's), and returns the discount to
   * fold into the order. Throws (aborting the whole order) on any
   * violation — a coupon failure must never silently fall back to "no
   * discount" and still charge the customer full price.
   */
  async redeemInTransaction(
    tx: Prisma.TransactionClient,
    tenantId: string,
    code: string,
    params: { channel: OrderingChannel; subtotalHalalas: number; customerPhone?: string },
  ): Promise<{ couponId: string; discountHalalas: number }> {
    const normalized = code.trim().toUpperCase();
    await tx.$queryRaw`SELECT id FROM coupons WHERE tenant_id = ${tenantId}::uuid AND code = ${normalized} FOR UPDATE`;
    const coupon = await tx.coupon.findFirst({
      where: { tenantId, code: normalized, deletedAt: null },
    });
    if (!coupon) {
      throw new NotFoundException("Invalid coupon code");
    }
    this.assertUsable(coupon, params.channel, params.subtotalHalalas);

    if (coupon.maxRedemptions != null) {
      const used = await tx.order.count({
        where: { couponId: coupon.id, status: { notIn: [...ACTIVE_ORDER_STATUSES_FOR_REDEMPTION] } },
      });
      if (used >= coupon.maxRedemptions) {
        throw new ConflictException("This coupon has reached its usage limit");
      }
    }
    if (coupon.maxRedemptionsPerCustomer != null && params.customerPhone) {
      const usedByCustomer = await tx.order.count({
        where: {
          couponId: coupon.id,
          customerPhone: params.customerPhone,
          status: { notIn: [...ACTIVE_ORDER_STATUSES_FOR_REDEMPTION] },
        },
      });
      if (usedByCustomer >= coupon.maxRedemptionsPerCustomer) {
        throw new ConflictException("You have already used this coupon");
      }
    }

    return {
      couponId: coupon.id,
      discountHalalas: this.computeDiscountHalalas(coupon, params.subtotalHalalas),
    };
  }

  private async findActiveOrThrow(tenantId: string, code: string) {
    const coupon = await this.prisma.forTenant(tenantId).coupon.findFirst({
      where: { tenantId, code: code.trim().toUpperCase(), deletedAt: null },
    });
    if (!coupon) {
      throw new NotFoundException("Invalid coupon code");
    }
    return coupon;
  }

  private assertUsable(
    coupon: { isActive: boolean; startAt: Date | null; endAt: Date | null; channels: string[]; minOrderAmount: Prisma.Decimal },
    channel: OrderingChannel,
    subtotalHalalas: number,
  ) {
    if (!coupon.isActive) {
      throw new BadRequestException("This coupon is no longer active");
    }
    const now = new Date();
    if (coupon.startAt && now < coupon.startAt) {
      throw new BadRequestException("This coupon is not active yet");
    }
    if (coupon.endAt && now > coupon.endAt) {
      throw new BadRequestException("This coupon has expired");
    }
    if (coupon.channels.length > 0 && !coupon.channels.includes(channel)) {
      throw new BadRequestException("This coupon is not valid for this ordering type");
    }
    const minOrderHalalas = sarToHalalas(coupon.minOrderAmount.toString());
    if (subtotalHalalas < minOrderHalalas) {
      throw new ConflictException(
        `This coupon requires a minimum order of ${coupon.minOrderAmount} SAR`,
      );
    }
  }

  private computeDiscountHalalas(
    coupon: { discountType: string; discountValue: Prisma.Decimal; maxDiscountAmount: Prisma.Decimal | null },
    subtotalHalalas: number,
  ): number {
    let discountHalalas: number;
    if (coupon.discountType === "percentage") {
      const pct = Number(coupon.discountValue);
      discountHalalas = Math.floor((subtotalHalalas * pct) / 100 + 0.5);
      if (coupon.maxDiscountAmount != null) {
        discountHalalas = Math.min(discountHalalas, sarToHalalas(coupon.maxDiscountAmount.toString()));
      }
    } else {
      discountHalalas = sarToHalalas(coupon.discountValue.toString());
    }
    return Math.min(discountHalalas, subtotalHalalas);
  }
}
