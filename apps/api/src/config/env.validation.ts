const REQUIRED_VARS = [
  "DATABASE_URL",
  "ADMIN_DATABASE_URL",
  "JWT_SECRET",
  "SPRUVEX_SITE_API_KEY",
] as const;

const MIN_JWT_SECRET_LENGTH = 32;
const MIN_SITE_API_KEY_LENGTH = 32;
const KNOWN_PLACEHOLDER_SECRETS = new Set([
  "change-me-to-a-long-random-secret",
  "secret",
  "changeme",
]);

/**
 * Fail fast on boot when required environment variables are missing, or when
 * JWT_SECRET / SPRUVEX_SITE_API_KEY are still .env.example placeholders / too
 * short to resist brute-forcing — instead of failing (or silently accepting
 * forged tokens/requests) on the first request. Only enforced in production
 * so local dev/test secrets (e.g. "test-secret-not-for-production") keep
 * working.
 */
export function validateEnv(config: Record<string, unknown>): Record<string, unknown> {
  const missing = REQUIRED_VARS.filter((key) => !config[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  if (config.NODE_ENV === "production") {
    const secret = String(config.JWT_SECRET);
    if (secret.length < MIN_JWT_SECRET_LENGTH || KNOWN_PLACEHOLDER_SECRETS.has(secret)) {
      throw new Error(
        `JWT_SECRET is too weak for production — use a random value of at least ${MIN_JWT_SECRET_LENGTH} characters (e.g. "openssl rand -base64 48")`,
      );
    }

    const siteApiKey = String(config.SPRUVEX_SITE_API_KEY);
    if (siteApiKey.length < MIN_SITE_API_KEY_LENGTH || KNOWN_PLACEHOLDER_SECRETS.has(siteApiKey)) {
      throw new Error(
        `SPRUVEX_SITE_API_KEY is too weak for production — use a random value of at least ${MIN_SITE_API_KEY_LENGTH} characters (e.g. "openssl rand -hex 32")`,
      );
    }
  }

  return config;
}
