import { PartialType } from "@nestjs/mapped-types";
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from "class-validator";

export class CreateFloorDto {
  @IsUUID()
  branchId!: string;

  /** Arabic name (primary) */
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  nameEn?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateFloorDto extends PartialType(CreateFloorDto) {
  /** branch cannot change after creation */
  declare branchId: never;
}

export class CreateTableDto {
  @IsUUID()
  floorId!: string;

  /** Custom table number/name, e.g. "12" or "A1" */
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  number!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  capacity?: number;
}

export class UpdateTableDto {
  @IsOptional()
  @IsUUID()
  floorId?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  number?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  capacity?: number;

  /** Manual status control (occupied/reserved become automatic with sessions/orders). */
  @IsOptional()
  @IsIn(["available", "occupied", "reserved", "disabled"])
  status?: "available" | "occupied" | "reserved" | "disabled";
}

export class OpenSessionDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class CloseSessionDto {
  /** Close even though the session's order has an unpaid balance. */
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}
