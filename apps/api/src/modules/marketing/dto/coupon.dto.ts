import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumberString,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";

import { ORDERING_CHANNELS, type OrderingChannel } from "@spruvex-r/types";

export class CreateCouponDto {
  @IsString()
  @MinLength(3)
  @MaxLength(30)
  @Matches(/^[A-Za-z0-9_-]+$/, { message: "Code may only contain letters, numbers, - and _" })
  code!: string;

  @IsIn(["percentage", "fixed"])
  discountType!: "percentage" | "fixed";

  @IsNumberString()
  discountValue!: string;

  @IsOptional()
  @IsNumberString()
  maxDiscountAmount?: string;

  @IsOptional()
  @IsNumberString()
  minOrderAmount?: string;

  /** Empty/omitted = valid on both takeaway and delivery. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(ORDERING_CHANNELS.length)
  @IsIn(ORDERING_CHANNELS, { each: true })
  channels?: OrderingChannel[];

  @IsOptional()
  @IsDateString()
  startAt?: string;

  @IsOptional()
  @IsDateString()
  endAt?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxRedemptions?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(99)
  maxRedemptionsPerCustomer?: number;
}

export class UpdateCouponDto {
  @IsOptional()
  @IsIn(["percentage", "fixed"])
  discountType?: "percentage" | "fixed";

  @IsOptional()
  @IsNumberString()
  discountValue?: string;

  @IsOptional()
  @IsNumberString()
  maxDiscountAmount?: string;

  @IsOptional()
  @IsNumberString()
  minOrderAmount?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(ORDERING_CHANNELS.length)
  @IsIn(ORDERING_CHANNELS, { each: true })
  channels?: OrderingChannel[];

  @IsOptional()
  @IsDateString()
  startAt?: string | null;

  @IsOptional()
  @IsDateString()
  endAt?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxRedemptions?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(99)
  maxRedemptionsPerCustomer?: number | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class ValidateCouponDto {
  @IsString()
  @MaxLength(30)
  code!: string;

  @IsIn(["takeaway", "delivery"])
  channel!: "takeaway" | "delivery";

  /** Guest-displayed cart subtotal (SAR) — a preview only; the real
   * subtotal is re-priced server-side from the catalog at order creation,
   * so a tampered value here only affects what the preview shows, never
   * what gets charged. */
  @IsNumberString()
  subtotal!: string;
}
