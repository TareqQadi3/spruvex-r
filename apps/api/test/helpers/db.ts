import { PrismaClient } from "@prisma/client";

/** Admin (BYPASSRLS) client for fixtures and assertions across tenants. */
export function createAdminClient(): PrismaClient {
  return new PrismaClient({ datasourceUrl: process.env.ADMIN_DATABASE_URL });
}

/** App-role client with NO tenant context set — used to prove RLS fails closed. */
export function createRawAppClient(): PrismaClient {
  return new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
}

/** Wipes all business data between test suites (FK-safe order). */
export async function truncateAll(admin: PrismaClient): Promise<void> {
  await admin.$executeRawUnsafe(`
    TRUNCATE TABLE
      audit_logs,
      pos_pins,
      refresh_tokens,
      otp_codes,
      user_roles,
      role_permissions,
      roles,
      branches,
      tenants,
      users,
      permissions,
      platform_admins,
      platform_settings,
      platform_audit_logs
    CASCADE
  `);
}
