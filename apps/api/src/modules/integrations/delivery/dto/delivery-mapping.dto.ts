import { IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";

export class UpsertDeliveryMappingDto {
  @IsUUID()
  connectionId!: string;

  @IsUUID()
  productId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  externalItemId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  externalItemName?: string;
}
