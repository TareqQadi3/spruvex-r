import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from "class-validator";

import { ORDERING_CHANNELS, type OrderingChannel } from "@spruvex-r/types";

/** Raw shape validated at runtime by `parseWorkingHours` (deep validation of the nested schedule/exceptions structure lives there, not in decorators). */
export class UpdateWorkingHoursDto {
  @IsObject()
  workingHours!: Record<string, unknown>;
}

export class PauseChannelDto {
  @IsIn(ORDERING_CHANNELS)
  channel!: OrderingChannel;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  /** Omit for an indefinite pause (resumed manually). */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1440)
  durationMinutes?: number;
}

const AMOUNT_RULE = /^\d{1,10}(\.\d{1,2})?$/;
const AMOUNT_MESSAGE = "Amount must be a decimal string with up to 2 fraction digits";

export class UpdateDeliverySettingsDto {
  @IsOptional()
  @IsString()
  @Matches(AMOUNT_RULE, { message: AMOUNT_MESSAGE })
  deliveryFeeAmount?: string;

  @IsOptional()
  @IsString()
  @Matches(AMOUNT_RULE, { message: AMOUNT_MESSAGE })
  deliveryMinOrderAmount?: string;

  /** Null clears the radius restriction. */
  @IsOptional()
  deliveryRadiusKm?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(600)
  deliveryEstimatedMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(600)
  pickupEstimatedMinutes?: number;

  @IsOptional()
  @IsIn(["cash", "online"], { each: true })
  selfServicePaymentMethods?: ("cash" | "online")[];

  /** Null turns auto-slowdown off. */
  @IsOptional()
  @IsInt()
  @Min(1)
  autoSlowdownThreshold?: number | null;

  /** Null turns system auto-pause off. */
  @IsOptional()
  @IsInt()
  @Min(1)
  autoPauseThreshold?: number | null;
}
