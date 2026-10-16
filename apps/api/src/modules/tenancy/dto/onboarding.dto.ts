import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from "class-validator";

const PASSWORD_RULE = /^(?=.*[A-Za-z])(?=.*\d).+$/;
const PASSWORD_MESSAGE = "Password must be 8+ characters with at least one letter and one digit";

export const RESTAURANT_TYPES = [
  "restaurant",
  "cafe",
  "cloud_kitchen",
  "food_truck",
  "bakery",
  "other",
] as const;

export class CreateRestaurantDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  nameEn?: string;

  @IsOptional()
  @IsIn(RESTAURANT_TYPES as unknown as string[])
  type?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{2}$/, { message: "Country must be an ISO 3166-1 alpha-2 code" })
  country?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: "Currency must be an ISO 4217 code" })
  currency?: string;

  @IsOptional()
  @IsIn(["ar", "en"])
  defaultLocale?: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  @MaxLength(2048)
  logoUrl?: string;

  // --- Mandatory tax-invoice fields (plan: cannot complete onboarding's
  // step 3 without these — see onboarding.md / OnboardingWizard.tsx). Every
  // field ZATCA's seller PostalAddress block requires, per
  // erp-pos-saas-architect/references/zatca.md's guidance to check current
  // requirements before onboarding — collected once, up front, instead of
  // discovered later as a blocked-invoice surprise.

  @IsString()
  @Matches(/^\d{15}$/, { message: "VAT number must be 15 digits" })
  vatNumber!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  crNumber!: string;

  /** Street name/line. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  address!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  city!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  district!: string;

  /** Building number — 4 digits per the KSA National Address standard. */
  @IsString()
  @Matches(/^\d{4}$/, { message: "Building number must be 4 digits" })
  buildingNumber!: string;

  /** Postal code — 5 digits per the KSA National Address standard. */
  @IsString()
  @Matches(/^\d{5}$/, { message: "Postal code must be 5 digits" })
  postalCode!: string;

  /** Extra address detail: floor, landmark, unit — whatever the street address alone doesn't cover. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  additionalAddress!: string;

  @IsString()
  @Matches(/^\+?[0-9]{8,15}$/, { message: "Phone must be 8-15 digits (optionally with +)" })
  contactPhone!: string;
}

export class CreateBranchDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  nameEn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\+?[0-9]{8,15}$/, { message: "Phone must be 8-15 digits (optionally with +)" })
  phone?: string;

  @IsOptional()
  @IsEmail()
  email?: string;
}

export class StaffUserDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(8, { message: PASSWORD_MESSAGE })
  @MaxLength(128)
  @Matches(PASSWORD_RULE, { message: PASSWORD_MESSAGE })
  password!: string;

  @IsIn(["manager", "cashier", "waiter", "kitchen"])
  role!: "manager" | "cashier" | "waiter" | "kitchen";

  @IsOptional()
  @IsUUID()
  branchId?: string;
}

export class CreateStaffDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => StaffUserDto)
  users!: StaffUserDto[];
}

/** Add one team member after onboarding (Team page "add member" action). */
export class AddTeamMemberDto extends StaffUserDto {}

/** Optional post-onboarding steps the dashboard reminder banner tracks. */
export const OPTIONAL_SETUP_STEPS = ["logo", "receipt", "theme", "zatca", "staff", "menu", "tables"] as const;
export type OptionalSetupStep = (typeof OPTIONAL_SETUP_STEPS)[number];

export class MarkSetupStepDto {
  @IsIn(OPTIONAL_SETUP_STEPS as unknown as string[])
  step!: OptionalSetupStep;

  @IsIn(["done", "skipped"])
  status!: "done" | "skipped";
}
