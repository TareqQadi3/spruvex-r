import {
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
} from "class-validator";

import {
  MENU_TEMPLATE_KEYS,
  RECEIPT_LOGO_POSITIONS,
  RECEIPT_LOGO_SIZES,
  RECEIPT_TEMPLATE_KEYS,
  THEME_PRESET_KEYS,
} from "@spruvex-r/types";

/** Establishment (ZATCA) data + appearance/receipt customization — editable from dashboard settings. */
export class UpdateTenantDto {
  @IsOptional()
  @IsString()
  @MaxLength(160)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  nameEn?: string;

  /** Registered legal entity name printed on invoices. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  legalName?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{15}$/, { message: "VAT number must be 15 digits" })
  vatNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  crNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  city?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  district?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}$/, { message: "Building number must be 4 digits" })
  buildingNumber?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{5}$/, { message: "Postal code must be 5 digits" })
  postalCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  additionalAddress?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\+?[0-9]{8,15}$/, { message: "Phone must be 8-15 digits (optionally with +)" })
  contactPhone?: string;

  @IsOptional()
  @IsUrl()
  @MaxLength(2048)
  logoUrl?: string;

  /** One of the curated presets (@spruvex-r/types THEME_PRESET_KEYS) — never a raw hex. */
  @IsOptional()
  @IsIn(THEME_PRESET_KEYS as unknown as string[])
  themeColor?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  receiptHeaderNote?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  receiptFooterNote?: string;

  /** One of RECEIPT_TEMPLATE_KEYS. Snapshotted into each receipt at issuance. */
  @IsOptional()
  @IsIn(RECEIPT_TEMPLATE_KEYS as unknown as string[])
  receiptTemplate?: string;

  @IsOptional()
  @IsIn(RECEIPT_LOGO_POSITIONS as unknown as string[])
  receiptLogoPosition?: string;

  @IsOptional()
  @IsIn(RECEIPT_LOGO_SIZES as unknown as string[])
  receiptLogoSize?: string;

  /** One of MENU_TEMPLATE_KEYS ("custom" pairs with menuCustomCss below). */
  @IsOptional()
  @IsIn(MENU_TEMPLATE_KEYS as unknown as string[])
  menuTemplate?: string;

  /**
   * Raw CSS from the tenant (or a developer they hired) for the "custom"
   * menu template. Untrusted input — sanitized server-side in
   * TenancyService before it's ever persisted or served; never trust this
   * DTO value directly (see shared/security/menu-css-sanitizer.ts).
   */
  @IsOptional()
  @IsString()
  @MaxLength(20_000)
  menuCustomCss?: string;
}
