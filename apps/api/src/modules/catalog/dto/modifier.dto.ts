import { PartialType } from "@nestjs/mapped-types";
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from "class-validator";

/** Modifier price deltas may be negative (e.g. "بدون جبن -2"). */
const ADJUSTMENT_RULE = /^-?\d{1,10}(\.\d{1,2})?$/;
const ADJUSTMENT_MESSAGE = "Price adjustment must be a decimal string with up to 2 fraction digits";

export class CreateModifierGroupDto {
  /** Arabic name (primary) */
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  nameEn?: string;

  @IsOptional()
  @IsBoolean()
  isRequired?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  minSelect?: number;

  /** Omit for unlimited */
  @IsOptional()
  @IsInt()
  @Min(1)
  maxSelect?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateModifierGroupDto extends PartialType(CreateModifierGroupDto) {}

export class CreateModifierDto {
  /** Arabic name (primary) */
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  nameEn?: string;

  @IsOptional()
  @IsString()
  @Matches(ADJUSTMENT_RULE, { message: ADJUSTMENT_MESSAGE })
  priceAdjustment?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateModifierDto extends PartialType(CreateModifierDto) {}

export class ModifierBranchAvailabilityDto {
  @IsBoolean()
  isAvailable!: boolean;
}
