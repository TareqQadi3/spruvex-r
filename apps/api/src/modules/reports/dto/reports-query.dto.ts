import { Transform, Type } from "class-transformer";
import { IsArray, IsDateString, IsInt, IsOptional, IsUUID, Max, Min } from "class-validator";

export class DateRangeQueryDto {
  @IsOptional()
  @IsUUID()
  branchId?: string;

  /** ISO date (yyyy-mm-dd) or datetime. Defaults to 30 days ago. */
  @IsOptional()
  @IsDateString()
  from?: string;

  /** ISO date (yyyy-mm-dd) or datetime. Defaults to now. */
  @IsOptional()
  @IsDateString()
  to?: string;
}

export class DailySalesQueryDto {
  @IsOptional()
  @IsUUID()
  branchId?: string;

  /** ISO date (yyyy-mm-dd). Defaults to today (UTC). */
  @IsOptional()
  @IsDateString()
  date?: string;
}

export class BestSellersQueryDto extends DateRangeQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

export class BranchComparisonQueryDto {
  /** ISO date (yyyy-mm-dd) or datetime. Defaults to 30 days ago. */
  @IsOptional()
  @IsDateString()
  from?: string;

  /** ISO date (yyyy-mm-dd) or datetime. Defaults to now. */
  @IsOptional()
  @IsDateString()
  to?: string;

  /** Comma-separated branch IDs to restrict the comparison to. Defaults to every branch. */
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === "string"
      ? value
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean)
      : value,
  )
  @IsArray()
  @IsUUID("4", { each: true })
  branchIds?: string[];
}
