import {
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from "class-validator";

/** Connects/updates one integration (category comes from the route, provider from here). */
export class UpsertConnectionDto {
  @IsString()
  provider!: string;

  /** Branch-scoped connections only (delivery platform, NFC terminal). */
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @IsOptional()
  @IsBoolean()
  isEnabled?: boolean;

  @IsOptional()
  @IsIn(["test", "live"])
  environment?: string;

  /** Non-secret provider settings (external store id, phone number id, terminal id, ...). */
  @IsOptional()
  @IsObject()
  config?: Record<string, unknown>;

  /** Leave unset to keep the currently-stored secret unchanged. */
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  secret?: string;

  /** Leave unset to keep the currently-stored webhook secret unchanged. */
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  webhookSecret?: string;
}
