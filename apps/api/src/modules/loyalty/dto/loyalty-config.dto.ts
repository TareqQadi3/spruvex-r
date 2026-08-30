import { IsBoolean, IsObject, IsOptional, IsUUID } from "class-validator";

export class UpsertLoyaltyConfigDto {
  /** null/omitted = tenant-wide default; a specific branch overrides it for just that branch. */
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @IsBoolean()
  isEnabled!: boolean;

  /** Shape validated per-type in LoyaltyConfigService — see @spruvex-r/types' loyalty.ts. */
  @IsObject()
  config!: Record<string, unknown>;
}
