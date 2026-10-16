import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from "class-validator";

const STATUSES = ["draft", "sent", "received", "rejected", "cancelled"] as const;
/** Positive-only — a requested transfer quantity of zero makes no sense. */
const POSITIVE_QUANTITY_RULE = /^\d{1,10}(\.\d{1,3})?$/;
/** Zero is a legitimate received quantity (fully lost in transit); never negative. */
const NON_NEGATIVE_QUANTITY_RULE = /^\d{1,10}(\.\d{1,3})?$/;

export class CreateStockTransferItemDto {
  @IsUUID()
  ingredientId!: string;

  @IsOptional()
  @IsUUID()
  fromLocationId?: string;

  /** Requested/sent quantity, base units. */
  @IsString()
  @Matches(POSITIVE_QUANTITY_RULE, { message: "Quantity must be a positive decimal string with up to 3 fraction digits" })
  quantity!: string;
}

export class CreateStockTransferDto {
  @IsUUID()
  fromBranchId!: string;

  @IsUUID()
  toBranchId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => CreateStockTransferItemDto)
  items!: CreateStockTransferItemDto[];

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class ReceiveStockTransferItemDto {
  @IsUUID()
  stockTransferItemId!: string;

  /** The receiving branch's own location choice — defaults to its default location. */
  @IsOptional()
  @IsUUID()
  toLocationId?: string;

  /** Actual counted quantity received — may be less than what was sent, down to zero. */
  @IsString()
  @Matches(NON_NEGATIVE_QUANTITY_RULE, {
    message: "Received quantity must be a non-negative decimal string with up to 3 fraction digits",
  })
  receivedQuantity!: string;

  /** Required by the service (not here) whenever receivedQuantity < the item's sentQuantity. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  discrepancyReason?: string;
}

export class ReceiveStockTransferDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => ReceiveStockTransferItemDto)
  items!: ReceiveStockTransferItemDto[];
}

export class RejectStockTransferDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

export class CancelStockTransferDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

export class ListStockTransfersQueryDto {
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @IsOptional()
  @IsIn(STATUSES)
  status?: (typeof STATUSES)[number];
}
