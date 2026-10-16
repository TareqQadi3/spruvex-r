import { IsEmail, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from "class-validator";

import { RESTAURANT_TYPES } from "../../tenancy/dto/onboarding.dto";

// Same rule as RegisterDto.password — one password policy for every owner.
const PASSWORD_RULE = /^(?=.*[A-Za-z])(?=.*\d).+$/;
const PASSWORD_MESSAGE = "Password must be 8+ characters with at least one letter and one digit";

/**
 * Business types spruvex-site's trial form offers. A superset of
 * RESTAURANT_TYPES: the site's extra `dessert_cafe` is stored as `cafe`
 * (see SitePublicService.tenantType).
 */
export const SITE_BUSINESS_TYPES = [...RESTAURANT_TYPES, "dessert_cafe"] as const;

export class PublicTrialSignupDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  restaurantName!: string;

  // Same pattern used for RegisterDto.phone and GuestTakeawayOrderDto.customerPhone —
  // the one phone-identity convention this codebase already has.
  @IsString()
  @Matches(/^\+?[0-9]{8,15}$/, { message: "Phone must be 8-15 digits (optionally with +)" })
  phone!: string;

  @IsEmail()
  @MaxLength(254)
  email!: string;

  /**
   * The password the merchant chose on spruvex-site. Optional for backward
   * compatibility: without it a random one is set and the merchant signs in
   * via OTP / handoff, then uses "forgot password".
   */
  @IsOptional()
  @IsString()
  @MinLength(8, { message: PASSWORD_MESSAGE })
  @MaxLength(128)
  @Matches(PASSWORD_RULE, { message: PASSWORD_MESSAGE })
  password?: string;

  @IsOptional()
  @IsIn(SITE_BUSINESS_TYPES as unknown as string[])
  businessType?: string;
}
