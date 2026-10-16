import { IsBoolean } from "class-validator";

export class UpdateReorderAlertSettingsDto {
  @IsBoolean()
  whatsappEnabled!: boolean;
}
