import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from "class-validator";

const AMOUNT_RULE = /^\d{1,10}(\.\d{1,2})?$/;
const AMOUNT_MESSAGE = "Amount must be a decimal string with up to 2 fraction digits";

export class RecordPaymentDto {
  @IsIn(["cash", "card", "online"])
  method!: "cash" | "card" | "online";

  /** Applied amount (SAR). Split payment = several calls with partial amounts. */
  @IsString()
  @Matches(AMOUNT_RULE, { message: AMOUNT_MESSAGE })
  amount!: string;

  /** Card approval code / external reference. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  reference?: string;
}

export class ApplyDiscountDto {
  @IsIn(["percentage", "fixed"])
  type!: "percentage" | "fixed";

  /** Percentage (0-100) or fixed SAR amount. */
  @IsString()
  @Matches(AMOUNT_RULE, { message: AMOUNT_MESSAGE })
  value!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}

export class RefundOrderDto {
  /** VAT-inclusive amount to credit back, SAR. Must not exceed what's left to refund on the receipt. */
  @IsString()
  @Matches(AMOUNT_RULE, { message: AMOUNT_MESSAGE })
  amount!: string;

  @IsIn(["cash", "card", "online"])
  method!: "cash" | "card" | "online";

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;

  /** Card refund authorization code / external reference. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  reference?: string;
}

export class IssueDebitNoteDto {
  /** Additional VAT-inclusive amount owed, SAR. */
  @IsString()
  @Matches(AMOUNT_RULE, { message: AMOUNT_MESSAGE })
  amount!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}
