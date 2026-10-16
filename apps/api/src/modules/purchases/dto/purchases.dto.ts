import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from "class-validator";

const PURCHASE_ITEM_TYPES = ["stock", "expense"] as const;

/** Up to 3 decimal places — matches Decimal(14,3) (same rule as stock quantities). */
const QUANTITY_RULE = /^\d{1,10}(\.\d{1,3})?$/;
/** Up to 4 decimal places — matches Decimal(12,4) (same rule as ingredient cost). */
const UNIT_PRICE_RULE = /^\d{1,10}(\.\d{1,4})?$/;
/** 0-100 with up to 2 decimals — a VAT rate, not hardcoded to any specific value. */
const VAT_RATE_RULE = /^(100(\.0{1,2})?|\d{1,2}(\.\d{1,2})?)$/;

export class CreateSupplierDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  nameEn?: string;

  /** Optional — a supplier not registered for VAT simply has none. */
  @IsOptional()
  @IsString()
  @Matches(/^\d{15}$/, { message: "VAT number must be 15 digits" })
  vatNumber?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\+?[0-9]{8,15}$/, { message: "Phone must be 8-15 digits (optionally with +)" })
  contactPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  contactEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class UpdateSupplierDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  nameEn?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{15}$/, { message: "VAT number must be 15 digits" })
  vatNumber?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\+?[0-9]{8,15}$/, { message: "Phone must be 8-15 digits (optionally with +)" })
  contactPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  contactEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class PurchaseInvoiceItemDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  description!: string;

  @IsIn(PURCHASE_ITEM_TYPES)
  itemType!: (typeof PURCHASE_ITEM_TYPES)[number];

  @IsString()
  @Matches(QUANTITY_RULE, { message: "Quantity must be a positive decimal string with up to 3 fraction digits" })
  quantity!: string;

  /** Net (pre-VAT) price per unit of `quantity`. */
  @IsString()
  @Matches(UNIT_PRICE_RULE, { message: "Unit price must be a decimal string with up to 4 fraction digits" })
  unitPrice!: string;

  /** Omit to fall back to settings.defaultPurchaseVatRate — never a hardcoded default. */
  @IsOptional()
  @IsString()
  @Matches(VAT_RATE_RULE, { message: "VAT rate must be a decimal 0-100 with up to 2 fraction digits" })
  vatRatePercent?: string;

  /** Required when itemType is "stock" — which ingredient this receives into. */
  @ValidateIf((o: PurchaseInvoiceItemDto) => o.itemType === "stock")
  @IsUUID()
  ingredientId?: string;

  /** "stock" only, optional — defaults to the branch's default stock location. */
  @ValidateIf((o: PurchaseInvoiceItemDto) => o.itemType === "stock" && o.locationId !== undefined)
  @IsUUID()
  locationId?: string;

  /** "expense" only — free text (rent/utilities/maintenance/...), never a hardcoded enum. */
  @ValidateIf((o: PurchaseInvoiceItemDto) => o.itemType === "expense" && o.expenseCategory !== undefined)
  @IsString()
  @MaxLength(120)
  expenseCategory?: string;
}

export class CreatePurchaseInvoiceDto {
  @IsUUID()
  supplierId!: string;

  @IsUUID()
  branchId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  supplierInvoiceNumber!: string;

  @IsDateString()
  invoiceDate!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => PurchaseInvoiceItemDto)
  items!: PurchaseInvoiceItemDto[];

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  /** true = create already confirmed (posts stock/expense immediately) instead of draft. */
  @IsOptional()
  @IsBoolean()
  confirm?: boolean;
}

export class CancelPurchaseInvoiceDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

export class ListPurchaseInvoicesQueryDto {
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @IsOptional()
  @IsIn(["draft", "confirmed", "cancelled"])
  status?: "draft" | "confirmed" | "cancelled";

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}

export class UpdatePurchaseSettingsDto {
  /** The rate pre-filled for new purchase-invoice lines — still editable per line. */
  @IsString()
  @Matches(VAT_RATE_RULE, { message: "VAT rate must be a decimal 0-100 with up to 2 fraction digits" })
  defaultPurchaseVatRate!: string;
}
