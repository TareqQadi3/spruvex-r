/**
 * Test database connections. Tests run against the dedicated spruvex_r_test
 * database — DATABASE_URL as the RLS-bound app role, ADMIN_DATABASE_URL as
 * the BYPASSRLS admin role (fixtures + migrations).
 */
export function applyTestEnvDefaults(): void {
  process.env.DATABASE_URL ??=
    "postgresql://spruvex_app:spruvex_app@localhost:5432/spruvex_r_test?schema=public";
  process.env.ADMIN_DATABASE_URL ??=
    "postgresql://spruvex_admin:spruvex_admin@localhost:5432/spruvex_r_test?schema=public";
  process.env.JWT_SECRET ??= "test-secret-not-for-production";
  process.env.ZATCA_CREDENTIALS_ENCRYPTION_KEY ??= "test-zatca-key-not-for-production";
}
