/**
 * Every platform-wide operational setting, with the default applied when a
 * tenant/platform-admin flow runs before anyone has ever touched it. Adding a
 * new platform setting means adding one key here (and to
 * UpdatePlatformSettingsDto's validation) — never a new migration/column.
 */
export interface PlatformSettingsShape {
  /** How long an OTP code (email verification, password reset) stays valid. */
  otpTtlMinutes: number;
  /** Wrong-code attempts allowed against one OTP before it's rejected outright. */
  otpMaxVerifyAttempts: number;
  /** Failed logins (tenant users AND platform admins — one shared policy) before lockout. */
  maxFailedLogins: number;
  /** Lockout duration once maxFailedLogins is hit. */
  lockoutMinutes: number;
  /** Default ceiling for an uploaded image/document. Must never exceed
   * MULTER_HARD_CEILING_BYTES (uploads.service.ts) — the DTO enforces this. */
  maxUploadBytes: number;
}

export const PLATFORM_SETTINGS_DEFAULTS: PlatformSettingsShape = {
  otpTtlMinutes: 10,
  otpMaxVerifyAttempts: 5,
  maxFailedLogins: 5,
  lockoutMinutes: 15,
  maxUploadBytes: 5 * 1024 * 1024,
};

/** The one row this table will ever have — see PlatformSettings' schema doc comment. */
export const PLATFORM_SETTINGS_SINGLETON_ID = "singleton";
