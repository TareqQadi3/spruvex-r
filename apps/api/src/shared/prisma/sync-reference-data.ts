import { PrismaClient } from "@prisma/client";

import { syncPlanCatalog } from "../../modules/billing/plan-catalog";
import { syncUnitCatalog } from "../../modules/inventory/unit-catalog";
import { syncPermissionCatalog } from "../../modules/tenancy/tenant-provisioning";
import { hashPassword } from "../../modules/identity/password";

/**
 * Idempotent boot-time sync of the GLOBAL reference data every environment
 * needs before the first tenant can be provisioned: the permission, unit and
 * plan catalogs (all upserts), plus the optional first platform admin.
 *
 * `prisma db seed` does the same, but it also creates a demo tenant and needs
 * ts-node + a shell — neither is available on hosts like Render's free tier.
 * Without this, a fresh production database rejects every signup with
 * "Permission catalog out of sync". Runs right after migrations, gated by the
 * same RUN_DB_MIGRATE flag, as the owner role (catalog tables are not
 * writable by the restricted app role).
 */
export async function syncReferenceDataIfRequested(): Promise<void> {
  if (process.env.RUN_DB_MIGRATE !== "true") {
    return;
  }
  const adminUrl = process.env.ADMIN_DATABASE_URL;
  if (!adminUrl) {
    return;
  }

  const db = new PrismaClient({ datasourceUrl: adminUrl });
  try {
    await syncPermissionCatalog(db);
    await syncUnitCatalog(db);
    await syncPlanCatalog(db);
    console.log("[reference-data] permission, unit and plan catalogs synced");

    const email = process.env.PLATFORM_ADMIN_EMAIL;
    const password = process.env.PLATFORM_ADMIN_PASSWORD;
    if (email && password) {
      const existing = await db.platformAdmin.findUnique({ where: { email } });
      if (!existing) {
        await db.platformAdmin.create({
          data: { email, name: "SpruVex Admin", passwordHash: await hashPassword(password) },
        });
        console.log(`[reference-data] platform admin bootstrapped: ${email}`);
      }
    }
  } finally {
    await db.$disconnect();
  }
}
