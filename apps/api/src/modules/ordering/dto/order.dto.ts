import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";

import { ORDER_STATUSES, type OrderStatus } from "@spruvex-r/types";

/** Staff/POS-creatable order types. "delivery" covers both a manually-entered
 * phone order and a real delivery-platform webhook (see delivery-webhook.service.ts). */
const CREATABLE_ORDER_TYPES = ["dine_in", "walkin", "takeaway", "delivery"] as const;

export class OrderItemInputDto {
  @IsUUID()
  productId!: string;

  @IsInt()
  @Min(1)
  @Max(99)
  quantity!: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsUUID(undefined, { each: true })
  modifierIds?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class CreateOrderDto {
  @IsIn(CREATABLE_ORDER_TYPES)
  type!: (typeof CREATABLE_ORDER_TYPES)[number];

  /** Required for dine_in. */
  @IsOptional()
  @IsUUID()
  tableId?: string;

  /** Required for walkin/takeaway (dine_in derives it from the table). */
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => OrderItemInputDto)
  items!: OrderItemInputDto[];

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  customerName?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\+?[0-9]{8,15}$/, { message: "Phone must be 8-15 digits (optionally with +)" })
  customerPhone?: string;

  /** POS sends confirm=true to move new -> confirmed immediately (validated transition). */
  @IsOptional()
  @IsBoolean()
  confirm?: boolean;
}

export class TransitionOrderDto {
  @IsIn(ORDER_STATUSES as unknown as string[])
  status!: OrderStatus;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason?: string;
}

export class EditOrderItemsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => OrderItemInputDto)
  items!: OrderItemInputDto[];
}

export class GuestCreateOrderDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => OrderItemInputDto)
  items!: OrderItemInputDto[];

  @IsOptional()
  @IsString()
  @MaxLength(120)
  customerName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

/** Pickup order through the external link — the phone number is mandatory. */
export class GuestTakeawayOrderDto extends GuestCreateOrderDto {
  @IsString()
  @Matches(/^\+?[0-9]{8,15}$/, { message: "Phone must be 8-15 digits (optionally with +)" })
  customerPhone!: string;
}
