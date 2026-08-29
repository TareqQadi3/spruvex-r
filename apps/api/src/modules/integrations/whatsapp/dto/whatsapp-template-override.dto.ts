import { IsIn, IsOptional, IsString, MaxLength } from "class-validator";
import { WHATSAPP_TEMPLATE_KEYS } from "@spruvex-r/types";

export class UpsertWhatsappTemplateOverrideDto {
  @IsIn(WHATSAPP_TEMPLATE_KEYS as unknown as string[])
  templateKey!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1024)
  customBodyAr?: string;

  @IsOptional()
  @IsIn(["not_submitted", "pending", "approved", "rejected"])
  approvalStatus?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  metaTemplateName?: string;
}
