import { IsInt, IsOptional, Max, Min } from "class-validator";

import { MULTER_HARD_CEILING_BYTES } from "../../uploads/uploads.service";

/**
 * Partial update — every field optional, only the keys sent are changed
 * (see PlatformSettingsService.updateSettings). Bounds exist to keep a
 * platform owner from locking themselves (or every tenant) out by mistake:
 * an absurdly short OTP/lockout window, or an upload ceiling multer would
 * silently truncate below.
 */
export class UpdatePlatformSettingsDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60)
  otpTtlMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  otpMaxVerifyAttempts?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  maxFailedLogins?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1440)
  lockoutMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(1024 * 1024)
  @Max(MULTER_HARD_CEILING_BYTES)
  maxUploadBytes?: number;
}
