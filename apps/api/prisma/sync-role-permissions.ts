import { PrismaClient } from "@prisma/client";

import { DEFAULT_ROLE_PERMISSIONS, SYSTEM_ROLES, type SystemRole } from "@spruvex-r/types";

import { syncPermissionCatalog } from "../src/modules/tenancy/tenant-provisioning";

export interface RolePermissionSyncEntry {
  tenantId: string;
  tenantName: string;
  roleId: string;
  roleKey: SystemRole;
  addedPermissions: string[];
}

export interface RolePermissionSyncSummary {
  apply: boolean;
  entries: RolePermissionSyncEntry[];
  tenantsChanged: number;
  rolesChanged: number;
  grantsAdded: number;
}

/**
 * Backfills newly-added permission keys (e.g. purchases.*, added in a later
 * phase than a tenant's own provisioning) onto EXISTING tenants' built-in
 * system roles. New permission keys only ever reach the global `permissions`
 * catalog and a BRAND NEW tenant's roles automatically — provisionTenant()
 * grants a role whatever DEFAULT_ROLE_PERMISSIONS says at the moment that
 * tenant is created, and nothing ever re-runs that for tenants that already
 * existed. Run this after any release that adds a permission key, so
 * existing tenants actually gain the capability their role should already
 * imply (e.g. an existing owner role silently missing purchases.void).
 *
 * Safety, since this touches every tenant's live role grants at once:
 * - ADDITIVE ONLY. Never revokes a permission, regardless of source —
 *   a tenant who manually removed something from a system role keeps
 *   that removal untouched, forever. This script cannot tell "never had
 *   it because it's new" apart from "had it and deliberately removed it",
 *   so it deliberately never removes anything to make that ambiguity safe
 *   in the one direction that matters: no capability disappears.
 * - System roles only (Role.isSystem = true AND Role.key in SYSTEM_ROLES).
 *   A tenant's own custom roles are never touched — they were never
 *   provisioned from DEFAULT_ROLE_PERMISSIONS in the first place, so there
 *   is no "default" to backfill against.
 * - Idempotent — running it twice in a row makes zero changes the second
 *   time (uses skipDuplicates, and only ever inserts what's actually
 *   missing).
 * - Dry-run by default (opts.apply undefined/false) — computes and returns
 *   the exact diff without writing anything, not even the global
 *   permission-catalog sync. Pass apply: true to write it.
 * - Every tenant that gets new grants gets one audit-log row naming the
 *   role and the exact keys added, same shape every other audit entry in
 *   this codebase uses (see shared/audit/audit.service.ts).
 */
export async function syncRolePermissions(
  db: PrismaClient,
  opts: { apply?: boolean } = {},
): Promise<RolePermissionSyncSummary> {
  const apply = opts.apply ?? false;

  if (apply) {
    await syncPermissionCatalog(db);
  }

  // Every key DEFAULT_ROLE_PERMISSIONS can reference comes from the same
  // code-level catalog (@spruvex-r/types PERMISSIONS) that
  // syncPermissionCatalog upserts into the DB — so in dry-run mode (where
  // that upsert is deliberately skipped) a report computed straight
  // against DEFAULT_ROLE_PERMISSIONS is still accurate; the DB id lookup
  // is only actually needed once we're about to INSERT a RolePermission
  // row, i.e. in apply mode, by which point the catalog sync above has
  // already run and guarantees every key has a row.
  const permissions = await db.permission.findMany({ select: { id: true, key: true } });
  const permissionIdByKey = new Map(permissions.map((p) => [p.key, p.id]));

  const systemRoles = await db.role.findMany({
    where: { isSystem: true, key: { in: SYSTEM_ROLES as unknown as string[] } },
    include: {
      rolePermissions: { select: { permission: { select: { key: true } } } },
      tenant: { select: { id: true, name: true } },
    },
  });

  const entries: RolePermissionSyncEntry[] = [];

  for (const role of systemRoles) {
    const roleKey = role.key as SystemRole;
    const defaultKeys = DEFAULT_ROLE_PERMISSIONS[roleKey] ?? [];
    const currentKeys = new Set(role.rolePermissions.map((rp) => rp.permission.key));
    const missingKeys = defaultKeys.filter((key) => !currentKeys.has(key));
    if (missingKeys.length === 0) continue;

    entries.push({
      tenantId: role.tenantId,
      tenantName: role.tenant.name,
      roleId: role.id,
      roleKey,
      addedPermissions: missingKeys,
    });

    if (apply) {
      await db.rolePermission.createMany({
        data: missingKeys.map((key) => ({
          tenantId: role.tenantId,
          roleId: role.id,
          // Guaranteed present: syncPermissionCatalog() above just
          // upserted every key DEFAULT_ROLE_PERMISSIONS can reference.
          permissionId: permissionIdByKey.get(key)!,
        })),
        skipDuplicates: true,
      });
      await db.auditLog.create({
        data: {
          tenantId: role.tenantId,
          userId: null,
          action: "role.permissions_synced",
          entityType: "role",
          entityId: role.id,
          meta: { roleKey, addedPermissions: missingKeys },
        },
      });
    }
  }

  return {
    apply,
    entries,
    tenantsChanged: new Set(entries.map((e) => e.tenantId)).size,
    rolesChanged: entries.length,
    grantsAdded: entries.reduce((sum, e) => sum + e.addedPermissions.length, 0),
  };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const adminUrl = process.env.ADMIN_DATABASE_URL;
  if (!adminUrl) {
    throw new Error("ADMIN_DATABASE_URL is required to run this script");
  }
  const db = new PrismaClient({ datasourceUrl: adminUrl });

  try {
    const summary = await syncRolePermissions(db, { apply });
    for (const entry of summary.entries) {
      console.log(
        `${apply ? "" : "[dry run] "}${entry.tenantName} (${entry.tenantId}) — role "${entry.roleKey}": +${entry.addedPermissions.join(", +")}`,
      );
    }
    console.log(
      `\n${apply ? "Applied" : "[dry run] Would apply"}: ${summary.grantsAdded} permission grant(s) across ${summary.rolesChanged} role(s) in ${summary.tenantsChanged} tenant(s).`,
    );
    if (!apply && summary.grantsAdded > 0) {
      console.log("Re-run with --apply to write these changes.");
    }
  } finally {
    await db.$disconnect();
  }
}

// Only run the CLI when executed directly (`ts-node sync-role-permissions.ts`),
// not when a test imports syncRolePermissions from this module.
if (require.main === module) {
  void main();
}
