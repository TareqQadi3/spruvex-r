import { IsObject } from "class-validator";

/** Record<sourceHeaderText, ourFieldKey | null> — validated field-by-field in ImportsService.setMapping. */
export class SetImportMappingDto {
  @IsObject()
  mapping!: Record<string, string | null>;
}
