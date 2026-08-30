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

/** Attaches/updates a customer on an already-created, still-open order (POS: "add customer at checkout"). */
export class SetOrderCustomerDto {
  @IsString()
  @Matches(/^\+?[0-9]{8,15}$/, { message: "Phone must be 8-15 digits (optionally with +)" })
  customerPhone!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  customerName?: string;
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

/** Cashier "add to this table's order" — the shared-session append, from the POS. */
export class AppendOrderItemsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => OrderItemInputDto)
  items!: OrderItemInputDto[];

  /** Which diner at the table this round is for — omit to leave it in the
   * shared/unattributed bucket (split equally at checkout). */
  @IsOptional()
  @IsString()
  @Matches(/^\+?[0-9]{8,15}$/, { message: "Phone must be 8-15 digits (optionally with +)" })
  participantPhone?: string;
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

/**
 * Shared table-session QR order — phone is mandatory here too: it is the
 * identity that ties this scan to a specific person at the table (joins an
 * existing session, attributes their items for bill-splitting, and is who
 * order-status WhatsApp updates go to), not just a delivery contact detail.
 */
export class GuestTableOrderDto extends GuestCreateOrderDto {
  @IsString()
  @Matches(/^\+?[0-9]{8,15}$/, { message: "Phone must be 8-15 digits (optionally with +)" })
  customerPhone!: string;
}
