import { IsUUID } from "class-validator";

export class CreateGatewayCheckoutDto {
  @IsUUID()
  orderId!: string;
}
