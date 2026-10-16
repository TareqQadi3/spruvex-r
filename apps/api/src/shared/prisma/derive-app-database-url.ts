/**
 * Lets a host be configured with ONE pasted connection string (the managed
 * Postgres owner role, e.g. Neon's `neondb_owner`) instead of two.
 *
 * When DATABASE_URL is unset but ADMIN_DATABASE_URL and
 * BOOTSTRAP_APP_ROLE_PASSWORD are, DATABASE_URL is derived from the admin URL
 * by swapping in the restricted `spruvex_app` role (created by
 * bootstrap-app-role.ts). The app then connects as a NOBYPASSRLS role, so
 * tenant isolation stays enforced by Postgres, not just by app code.
 *
 * Imported for its side effect as the FIRST import of main.ts, because
 * ConfigModule.forRoot() validates the environment when app.module is loaded.
 */
export const APP_ROLE_NAME = "spruvex_app";

export function deriveAppDatabaseUrl(env: NodeJS.ProcessEnv = process.env): void {
  // Neon's copy-paste connection string ends in `channel_binding=require`,
  // which Prisma's Rust engine is not documented to support — drop it so the
  // pasted string works as-is (TLS is still enforced by `sslmode=require`).
  for (const key of ["ADMIN_DATABASE_URL", "DATABASE_URL"] as const) {
    const raw = env[key];
    if (!raw?.includes("channel_binding")) continue;
    const url = new URL(raw);
    url.searchParams.delete("channel_binding");
    env[key] = url.toString();
  }

  if (env.DATABASE_URL) return;
  const adminUrl = env.ADMIN_DATABASE_URL;
  const password = env.BOOTSTRAP_APP_ROLE_PASSWORD;
  if (!adminUrl || !password) return;

  const url = new URL(adminUrl);
  url.username = APP_ROLE_NAME;
  url.password = password;
  env.DATABASE_URL = url.toString();
}

deriveAppDatabaseUrl();
