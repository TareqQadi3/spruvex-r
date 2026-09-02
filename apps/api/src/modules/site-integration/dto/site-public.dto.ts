import { IsEmail, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from "class-validator";

/** Password policy: at least 8 chars with at least one letter and one digit. */
const PASSWORD_RULE = /^(?=.*[A-Za-z])(?=.*\d).+$/;
const PASSWORD_MESSAGE = "Password must be 8+ characters with at least one letter and one digit";

/** Same value list as the marketing site's BUSINESS_TYPES (spruvex-site constants.ts). */
const SITE_BUSINESS_TYPES = ["restaurant", "cafe", "food_truck", "dessert_cafe", "other"] as const;

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
   * The merchant-chosen password from the trial form — hashed and stored
   * directly, so they can log in later with something they know (no more
   * randomBytes placeholder nobody knew). Same rule/message as
   * RegisterDto.password, defined here literally on purpose (see HANDOFF §4.4).
   */
  @IsString()
  @MinLength(8, { message: PASSWORD_MESSAGE })
  @MaxLength(128)
  @Matches(PASSWORD_RULE, { message: PASSWORD_MESSAGE })
  password!: string;

  /**
   * Optional activity type from the trial form — passes through to
   * Tenant.type, like the onboarding wizard does for self-registered owners.
   */
  @IsOptional()
  @IsIn(SITE_BUSINESS_TYPES as unknown as string[])
  businessType?: string;
}
