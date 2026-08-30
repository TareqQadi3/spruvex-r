import { IsIn } from "class-validator";

import { LOYALTY_PROGRAM_TYPES, type LoyaltyProgramType } from "@spruvex-r/types";

export class RedeemLoyaltyDto {
  @IsIn(LOYALTY_PROGRAM_TYPES)
  type!: LoyaltyProgramType;
}
