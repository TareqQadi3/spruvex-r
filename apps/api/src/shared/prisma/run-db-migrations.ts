import { execSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

import { syncPlanCatalog } from "../../modules/billing/plan-catalog";
import { syncUnitCatalog } from "../../modules/inventory/unit-catalog";
import { syncPermissionCatalog } from "../../modules/tenancy/tenant-provisioning";

/**
 * One-time, idempotent "create the production schema" bootstrap. Runs only when
 * RUN_DB_MIGRATE=true (set in Render, deploy once, then unset it). Same
 * gated-once pattern as bootstrapAppRoleIfRequested() next door.
 *
 * Why this exists: the app image never runs `prisma migrate deploy`, so a fresh
 * production database has no schema — every query 500s ("Internal server
 * error") until a human runs it by hand (something Render's free tier gives no
 * shell for). This applies the checked-in migrations through the standard
 * Prisma CLI as the admin (BYPASSRLS) role, then upserts the three global
 * catalogs — without them provisionTenant() fails with "Permission catalog out
 * of sync". `prisma migrate deploy` is safe to re-run (it only applies pending
 * migrations), and the catalog upserts are idempotent — so leaving the flag on
 * is harmless, but we unset it after a clean run anyway to keep boot deterministic.
 */
export async function runDbMigrationsIfRequested(): Promise<void> {
  if (process.env.RUN_DB_MIGRATE !== "true") {
    return;
  }

  const adminUrl = process.env.ADMIN_DATABASE_URL;
  if (!adminUrl) {
    console.error(
      "RUN_DB_MIGRATE=true but ADMIN_DATABASE_URL is not set - skipping.",
    );
    return;
  }

  // Prisma CLI reads DATABASE_URL — point it at the admin role so DDL works.
  // Inherits the rest of the container env; runs from apps/api (the image's
  // WORKDIR), where prisma/migrations and the prisma CLI live in node_modules.
  console.log("[db-bootstrap] running prisma migrate deploy ...");
  const migrateOut = execSync("npx prisma migrate deploy", {
    env: { ...process.env, DATABASE_URL: adminUrl },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  console.log(`[db-bootstrap] migrate deploy output:\n${migrateOut}`);

  const admin = new PrismaClient({ datasourceUrl: adminUrl });
  try {
    await syncPermissionCatalog(admin);
    console.log("[db-bootstrap] permission catalog synced.");
    await syncUnitCatalog(admin);
    console.log("[db-bootstrap] unit-of-measure catalog synced.");
    await syncPlanCatalog(admin);
    console.log("[db-bootstrap] plan catalog synced.");
  } finally {
    await admin.$disconnect();
  }

  console.log("[db-bootstrap] done.");
}