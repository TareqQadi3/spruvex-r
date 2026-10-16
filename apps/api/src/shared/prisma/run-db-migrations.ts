import { execFileSync } from "node:child_process";
import * as path from "node:path";

/**
 * One-time, opt-in `prisma migrate deploy` at boot. Runs only when
 * RUN_DB_MIGRATE=true (same gated-once pattern as RUN_DB_BOOTSTRAP): for
 * hosts without Shell/one-off-job access (e.g. Render free tier). Set the
 * flag, redeploy once, then unset it. Uses ADMIN_DATABASE_URL (the owner
 * role) because the restricted app role cannot alter the schema.
 */
export async function runDbMigrationsIfRequested(): Promise<void> {
  if (process.env.RUN_DB_MIGRATE !== "true") {
    return;
  }
  const adminUrl = process.env.ADMIN_DATABASE_URL;
  if (!adminUrl) {
    console.error("RUN_DB_MIGRATE=true but ADMIN_DATABASE_URL is not set - skipping.");
    return;
  }

  const apiRoot = path.resolve(__dirname, "..", "..", "..");
  const prismaBin = path.join(apiRoot, "node_modules", ".bin", "prisma");
  console.log("[migrate] running prisma migrate deploy");
  try {
    execFileSync(prismaBin, ["migrate", "deploy"], {
      cwd: apiRoot,
      stdio: "inherit",
      env: { ...process.env, DATABASE_URL: adminUrl },
    });
    console.log("[migrate] migrations applied");
  } catch (err) {
    console.error("[migrate] prisma migrate deploy failed", err);
    throw err;
  }
}
