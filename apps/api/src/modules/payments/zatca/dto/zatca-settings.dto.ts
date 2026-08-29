import { IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

export class UpdateZatcaSettingsDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsIn(["sandbox", "simulation", "production"])
  environment?: "sandbox" | "simulation" | "production";

  /** PEM-encoded CSID certificate — set once during onboarding, replace to rotate. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(20_000)
  certificatePem?: string;

  /** PEM-encoded CSID private key. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(20_000)
  privateKeyPem?: string;

  /** CSID binarySecurityToken (Basic-auth username against Fatoora). */
  @IsOptional()
  @IsString()
  @MaxLength(4_000)
  csidToken?: string;

  /** CSID secret (Basic-auth password). */
  @IsOptional()
  @IsString()
  @MaxLength(4_000)
  csidSecret?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  requestNote?: string;
}
