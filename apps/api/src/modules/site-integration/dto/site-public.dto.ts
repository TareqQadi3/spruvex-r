import { IsEmail, IsString, Matches, MaxLength, MinLength } from "class-validator";

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
}
