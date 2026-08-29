const REQUIRED_VARS = ["DATABASE_URL", "ADMIN_DATABASE_URL", "JWT_SECRET"] as const;

const MIN_JWT_SECRET_LENGTH = 32;
const KNOWN_PLACEHOLDER_SECRETS = new Set([
  "change-me-to-a-long-random-secret",
  "secret",
  "changeme",
]);

/**
 * Fail fast on boot when required environment variables are missing, or when
 * JWT_SECRET is still the .env.example placeholder / too short to resist
 * brute-forcing — instead of failing (or silently accepting forged tokens)
 * on the first request. Only enforced in production so local dev/test
 * secrets (e.g. "test-secret-not-for-production") keep working.
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
  }

  return config;
}
