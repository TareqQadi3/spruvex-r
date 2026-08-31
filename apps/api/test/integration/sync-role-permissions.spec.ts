import { PrismaClient } from "@prisma/client";

import { syncRolePermissions } from "../../prisma/sync-role-permissions";
import { syncPermissionCatalog } from "../../src/modules/tenancy/tenant-provisioning";
import { createAdminClient, truncateAll } from "../helpers/db";
import { provisionTestTenant } from "../helpers/provision";

/**
 * Cleanup-round audit item #1: this is the platform-owner-run script that
 * backfills permission keys added after a tenant was already provisioned
 * (e.g. purchases.* for a tenant created before that module existed) onto
 * its built-in system roles. Exercises the exported function directly
 * rather than shelling out to the CLI, so assertions can inspect the
 * returned summary and the actual DB state in the same test.
 */
describe("sync-role-permissions script (e2e)", () => {
  let admin: PrismaClient;
  let tenantId: string;
  let ownerRoleId: string;
  let cashierRoleId: string;
  let customRoleId: string;

  beforeAll(async () => {
    admin = createAdminClient();
    await truncateAll(admin);
    await syncPermissionCatalog(admin);

    const tenant = await provisionTestTenant(admin, {
      name: "مطعم اختبار المزامنة",
      slug: "sync-perms",
      ownerEmail: "owner@sync-perms.test",
    });
    tenantId = tenant.tenantId;
    ownerRoleId = tenant.roleIdsByKey.owner;
    cashierRoleId = tenant.roleIdsByKey.cashier;

    // Simulate a tenant provisioned before purchases.* existed: strip two
    // permissions the CURRENT owner role default includes.
    await admin.rolePermission.deleteMany({
      where: {
        roleId: ownerRoleId,
        permission: { key: { in: ["purchases.create", "purchases.void"] } },
      },
    });

    // Also simulate a tenant that deliberately removed a permission the
    // cashier role has ALWAYS defaulted to (never a "new" key) — the sync
    // must never re-grant this; only a genuinely-missing DEFAULT key is
    // backfilled, and a manual customization to an already-existing key is
    // indistinguishable from "never had it" by design (documented
    // trade-off), so this case specifically checks a key that is NOT a
    // cashier default at all — deleting it should be a no-op for the
    // assertion below regardless.
    const customRole = await admin.role.create({
      data: {
        tenantId,
        key: "sync-test-custom-role",
        nameAr: "دور مخصص",
        nameEn: "Custom role",
        isSystem: false,
        createdBy: null,
      },
    });
    customRoleId = customRole.id;
  });

  afterAll(async () => {
    await admin.$disconnect();
  });

  it("dry run reports the exact missing permissions without writing anything", async () => {
    const before = await admin.rolePermission.count({ where: { roleId: ownerRoleId } });

    const summary = await syncRolePermissions(admin, { apply: false });

    const ownerEntry = summary.entries.find((e) => e.roleId === ownerRoleId);
    expect(ownerEntry).toBeDefined();
    expect(ownerEntry!.addedPermissions.sort()).toEqual(["purchases.create", "purchases.void"]);

    const after = await admin.rolePermission.count({ where: { roleId: ownerRoleId } });
    expect(after).toBe(before); // nothing written
    const auditCount = await admin.auditLog.count({ where: { action: "role.permissions_synced" } });
    expect(auditCount).toBe(0);
  });

  it("never touches a tenant's own custom (non-system) roles", async () => {
    const summary = await syncRolePermissions(admin, { apply: false });
    expect(summary.entries.some((e) => e.roleId === customRoleId)).toBe(false);
  });

  it("apply grants exactly the missing permissions, audits it, and is idempotent on a second run", async () => {
    const summary = await syncRolePermissions(admin, { apply: true });
    const ownerEntry = summary.entries.find((e) => e.roleId === ownerRoleId);
    expect(ownerEntry!.addedPermissions.sort()).toEqual(["purchases.create", "purchases.void"]);

    const grantedKeys = await admin.rolePermission.findMany({
      where: { roleId: ownerRoleId },
      select: { permission: { select: { key: true } } },
    });
    const keys = grantedKeys.map((g) => g.permission.key);
    expect(keys).toEqual(expect.arrayContaining(["purchases.create", "purchases.void"]));

    const audit = await admin.auditLog.findFirst({
      where: { tenantId, action: "role.permissions_synced", entityId: ownerRoleId },
    });
    expect(audit).not.toBeNull();
    expect(audit!.meta).toMatchObject({
      roleKey: "owner",
      addedPermissions: expect.arrayContaining(["purchases.create", "purchases.void"]),
    });

    // Idempotent: running it again finds nothing left to do for this tenant.
    const second = await syncRolePermissions(admin, { apply: true });
    expect(second.entries.some((e) => e.roleId === ownerRoleId)).toBe(false);
    const auditCountAfter = await admin.auditLog.count({
      where: { tenantId, action: "role.permissions_synced", entityId: ownerRoleId },
    });
    expect(auditCountAfter).toBe(1); // still just the one audit row from the first apply
  });

  it("never revokes a permission a tenant already has, even one not in the current default set", async () => {
    // Grant the cashier role something it does NOT default to, simulating a
    // tenant's own manual customization.
    const loyaltyManage = await admin.permission.findUniqueOrThrow({ where: { key: "loyalty.manage" } });
    await admin.rolePermission.create({
      data: { tenantId, roleId: cashierRoleId, permissionId: loyaltyManage.id },
    });

    await syncRolePermissions(admin, { apply: true });

    const stillThere = await admin.rolePermission.findFirst({
      where: { roleId: cashierRoleId, permissionId: loyaltyManage.id },
    });
    expect(stillThere).not.toBeNull(); // never removed
  });
});
