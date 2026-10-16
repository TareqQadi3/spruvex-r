/**
 * Local integration check for repairLegacyEmailsIfRequested against the
 * local spruvex_r_test DB: seeds the EXACT production pathology (bare
 * unverified account with a tenant + a verified +tag variant), runs the
 * repair, and asserts the survivor/retiree outcomes.
 */
process.env.ADMIN_DATABASE_URL ??=
  "postgresql://spruvex_admin:spruvex_admin@localhost:5432/spruvex_r_test?schema=public";
process.env.RUN_DB_REPAIR_EMAILS = "true";

// Statically imported BEFORE the env mutation below would matter for the
// repaired module — but repair-legacy-emails reads its env at call time,
// so a plain import order is fine. (Static imports keep this file CJS under
// ts-node — no top-level await.)
import { PrismaClient } from "@prisma/client";

import { repairLegacyEmailsIfRequested } from "../../src/shared/prisma/repair-legacy-emails";

const db = new PrismaClient({ datasourceUrl: process.env.ADMIN_DATABASE_URL });

async function main() {
  // --- seed: mirror the owner's real-world trap (unique per run) ---
  const run = Date.now().toString().slice(-6);
  const BASE = `repair-e2e-${run}@e2e.test`;
  const TAG = `repair-e2e-${run}+2@e2e.test`;

  const tenant = await db.tenant.create({
    data: { name: "Shadow Tenant", slug: `repair-shadow-${run}`, createdBy: "00000000-0000-0000-0000-000000000000" },
  });
  const role = await db.role.create({
    data: {
      tenantId: tenant.id,
      key: "owner",
      nameAr: "ظ…ط§ظ„ظƒ",
      nameEn: "Owner",
      isSystem: true,
      createdBy: "00000000-0000-0000-0000-000000000000",
    },
  });

  const base = await db.user.create({
    data: {
      name: "Shadow Base",
      email: BASE, // unverified, HAS tenant (broken-era signup)
      phone: `+96650${run}900`,
      passwordHash: "x",
      userRoles: { create: { tenantId: tenant.id, roleId: role.id } },
    },
  });

  const verified = await db.user.create({
    data: {
      name: "Real Verified Owner",
      email: TAG, // the one the merchant actually verified
      phone: `+96650${run}901`,
      passwordHash: "x",
      emailVerifiedAt: new Date(),
    },
  });
  console.log("seeded:", { base: base.email, verified: verified.email });

  // --- run the repair ---
  await repairLegacyEmailsIfRequested();

  // --- assertions ---
  const survivor = await db.user.findUnique({ where: { email: BASE } });
  console.log("survivor:", {
    id: survivor?.id,
    email: survivor?.email,
    verified: !!survivor?.emailVerifiedAt,
    name: survivor?.name,
    active: survivor?.isActive,
  });

  const retired = await db.user.findUnique({ where: { email: `retired+${base.id}@invalid.local` } });
  console.log("retired shadow:", {
    found: !!retired,
    active: retired?.isActive,
    phone: retired?.phone,
    verified: !!retired?.emailVerifiedAt,
  });

  const ok =
    survivor?.id === verified.id &&
    !!survivor?.emailVerifiedAt &&
    retired &&
    retired.isActive === false &&
    retired.phone === null;

  // --- cleanup seeded rows so the suite DB stays pristine ---
  await db.userRole.deleteMany({ where: { userId: { in: [base.id, verified.id] } } });
  await db.user.deleteMany({ where: { id: { in: [base.id, verified.id] } } });
  await db.user.deleteMany({ where: { email: `retired+${base.id}@invalid.local` } });
  await db.role.deleteMany({ where: { tenantId: tenant.id } });
  await db.tenant.deleteMany({ where: { id: tenant.id } });

  console.log(ok ? "REPAIR TEST PASSED" : "REPAIR TEST FAILED");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(2);
});
