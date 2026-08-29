import {
  IsIn,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
} from "class-validator";

import { THEME_PRESET_KEYS } from "@spruvex-r/types";

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
}
