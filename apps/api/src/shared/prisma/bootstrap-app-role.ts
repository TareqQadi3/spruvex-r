import { PrismaClient } from "@prisma/client";

/**
 * One-time, idempotent bootstrap: creates the restricted `spruvex_app` DB
 * role that the app is normally supposed to connect with. Runs only when
 * RUN_DB_BOOTSTRAP=true (set that in Render, redeploy once, then unset it
 * and switch DATABASE_URL to the spruvex_app connection string).
 *
 * Needed because Render's free tier has no Shell/one-off-job access to run
 * this by hand - see docs/RENDER_DEPLOY.md step 3.
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

  const prisma = new PrismaClient();
  try {
    const databaseName = new URL(process.env.DATABASE_URL ?? "").pathname.replace(
      "/",
      ""
    );

    const roleExists = await prisma.$queryRawUnsafe<{ exists: boolean }[]>(
      "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'spruvex_app') AS exists"
    );
    if (!roleExists[0]?.exists) {
      await prisma.$executeRawUnsafe(
        `CREATE ROLE spruvex_app LOGIN PASSWORD '${password.replace(/'/g, "''")}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`
      );
      console.log("[bootstrap] created role spruvex_app");
    } else {
      console.log("[bootstrap] role spruvex_app already exists, skipping CREATE ROLE");
    }

    await prisma.$executeRawUnsafe(
      `GRANT CONNECT ON DATABASE ${JSON.stringify(databaseName).replace(/"/g, '"')} TO spruvex_app`
    );
    await prisma.$executeRawUnsafe(
      "GRANT USAGE ON SCHEMA public TO spruvex_app"
    );
    await prisma.$executeRawUnsafe(
      "ALTER DEFAULT PRIVILEGES FOR ROLE spruvex_admin IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO spruvex_app"
    );
    await prisma.$executeRawUnsafe(
      "ALTER DEFAULT PRIVILEGES FOR ROLE spruvex_admin IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO spruvex_app"
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
