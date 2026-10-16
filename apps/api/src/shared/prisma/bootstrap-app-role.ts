import { PrismaClient } from "@prisma/client";

/**
 * Idempotent bootstrap: creates the restricted `spruvex_app` DB role the app
 * connects with, and grants it DML on everything the owner role creates.
 * Runs only when RUN_DB_BOOTSTRAP=true. Safe to leave on: every statement is
 * a no-op once applied.
 *
 * Connects with ADMIN_DATABASE_URL (the managed-Postgres owner role, whatever
 * the provider named it — `neondb_owner` on Neon) and grants default
 * privileges FOR ROLE CURRENT_USER, so tables created later by
 * `prisma migrate deploy` (which runs as that same owner) are covered.
 * See docs/RENDER_DEPLOY.md.
 */
export async function bootstrapAppRoleIfRequested(): Promise<void> {
  if (process.env.RUN_DB_BOOTSTRAP !== "true") {
    return;
  }

  const password = process.env.BOOTSTRAP_APP_ROLE_PASSWORD;
  if (!password) {
    console.error(
      "RUN_DB_BOOTSTRAP=true but BOOTSTRAP_APP_ROLE_PASSWORD is not set - skipping."
    );
    return;
  }

  const adminUrl = process.env.ADMIN_DATABASE_URL;
  if (!adminUrl) {
    console.error("RUN_DB_BOOTSTRAP=true but ADMIN_DATABASE_URL is not set - skipping.");
    return;
  }

  const prisma = new PrismaClient({ datasourceUrl: adminUrl });
  try {
    const databaseName = new URL(adminUrl).pathname.replace(
      "/",
      ""
    );

    // Platform-level writes (tenant provisioning, catalogs) go through
    // ADMIN_DATABASE_URL and rely on that role bypassing RLS — every tenant
    // table is FORCE ROW LEVEL SECURITY. Neon's owner role has BYPASSRLS;
    // fail loudly here rather than with an opaque RLS error on first signup.
    const owner = await prisma.$queryRawUnsafe<{ rolbypassrls: boolean; rolsuper: boolean }[]>(
      "SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user"
    );
    if (!owner[0]?.rolbypassrls && !owner[0]?.rolsuper) {
      throw new Error(
        "ADMIN_DATABASE_URL's role lacks BYPASSRLS - use the database owner role " +
          "(e.g. Neon's neondb_owner), not a restricted one."
      );
    }

    const roleExists = await prisma.$queryRawUnsafe<{ exists: boolean }[]>(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'spruvex_app') AS exists"
    );
    if (!roleExists[0]?.exists) {
      await prisma.$executeRawUnsafe(
        `CREATE ROLE spruvex_app LOGIN PASSWORD '${password.replace(/'/g, "''")}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`
      );
      console.log("[bootstrap] created role spruvex_app");
    } else {
      // Keep the role's password in sync with BOOTSTRAP_APP_ROLE_PASSWORD,
      // which DATABASE_URL may be derived from (derive-app-database-url.ts).
      // (Only the password: changing BYPASSRLS needs a superuser, and the
      // role was created NOBYPASSRLS above.)
      await prisma.$executeRawUnsafe(
        `ALTER ROLE spruvex_app LOGIN PASSWORD '${password.replace(/'/g, "''")}'`
      );
      console.log("[bootstrap] role spruvex_app already exists, password re-synced");
    }

    // Quoted Postgres identifier, not a string literal — double any embedded
    // `"` per Postgres's quoted-identifier escaping rule. (The previous
    // `JSON.stringify(...).replace(/"/g, '"')` was a no-op: replacing `"`
    // with itself doesn't escape anything.)
    await prisma.$executeRawUnsafe(
      `GRANT CONNECT ON DATABASE "${databaseName.replace(/"/g, '""')}" TO spruvex_app`
    );
    await prisma.$executeRawUnsafe(
      "GRANT USAGE ON SCHEMA public TO spruvex_app"
    );
    await prisma.$executeRawUnsafe(
      "ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO spruvex_app"
    );
    await prisma.$executeRawUnsafe(
      "ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO spruvex_app"
    );
    await prisma.$executeRawUnsafe(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO spruvex_app"
    );
    await prisma.$executeRawUnsafe(
      "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO spruvex_app"
    );

    console.log("[bootstrap] spruvex_app role + grants done successfully");
  } catch (err) {
    console.error("[bootstrap] failed:", err);
    throw err;
  } finally {
    await prisma.$disconnect();
  }
}
