import { PrismaClient } from "@prisma/client";

import {
  ALL_PERMISSION_KEYS,
  DEFAULT_PLAN_KEY,
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSIONS,
  ROLE_LABELS,
  SYSTEM_ROLES,
  TRIAL_PERIOD_DAYS,
} from "@spruvex-r/types";

/**
 * Tenant provisioning — creates a tenant, the five system roles wired to the
 * default permission sets, the owner membership, and (optionally) a first
 * branch. The owner user account must already exist (created at registration).
 *
 * Runs on an ADMIN (BYPASSRLS) connection because a tenant cannot be created
 * from inside a tenant context. Used by the onboarding wizard and the seed.
 */

export interface ProvisionTenantInput {
  name: string;
  nameEn?: string;
  slug: string;
  type?: string;
  country?: string;
  currency?: string;
  defaultLocale?: string;
  logoUrl?: string;
  vatNumber?: string;
  crNumber?: string;
  address?: string;
  city?: string;
  district?: string;
  buildingNumber?: string;
  postalCode?: string;
  additionalAddress?: string;
  contactPhone?: string;
  /** Omit to create the tenant without a branch (wizard creates it in step 3). */
  branch?: { name?: string; nameEn?: string; slug?: string };
  ownerUserId: string;
}

export interface ProvisionedTenant {
  tenantId: string;
  branchId?: string;
  ownerUserId: string;
  roleIdsByKey: Record<string, string>;
}

/** URL-safe slug from a restaurant name — keeps Arabic letters, ASCII-lowercases the rest. */
export function slugify(value: string): string {
  const base = value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9؀-ۿ]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "restaurant";
}

/** Appends `-2`, `-3`, ... to `base` until an unused tenant slug is found. */
export async function findAvailableSlug(db: PrismaClient, base: string): Promise<string> {
  let candidate = base;
  for (let i = 2; ; i++) {
    const taken = await db.tenant.findUnique({ where: { slug: candidate } });
    if (!taken) return candidate;
    candidate = `${base}-${i}`;
  }
}

/** Upserts the global permission catalog from @spruvex-r/types. Idempotent. */
export async function syncPermissionCatalog(db: PrismaClient): Promise<void> {
  for (const key of ALL_PERMISSION_KEYS) {
    await db.permission.upsert({
      where: { key },
      update: { description: PERMISSIONS[key] },
      create: { key, description: PERMISSIONS[key] },
    });
  }
}

export async function provisionTenant(
  db: PrismaClient,
  input: ProvisionTenantInput,
): Promise<ProvisionedTenant> {
  return db.$transaction(async (tx) => {
    const tenant = await tx.tenant.create({
      data: {
        name: input.name,
        nameEn: input.nameEn,
        slug: input.slug,
        type: input.type,
        country: input.country ?? "SA",
        currency: input.currency ?? "SAR",
        defaultLocale: input.defaultLocale ?? "ar",
        logoUrl: input.logoUrl,
        vatNumber: input.vatNumber,
        crNumber: input.crNumber,
        address: input.address,
        city: input.city,
        district: input.district,
        buildingNumber: input.buildingNumber,
        postalCode: input.postalCode,
        additionalAddress: input.additionalAddress,
        contactPhone: input.contactPhone,
        createdBy: input.ownerUserId,
      },
    });

    let branchId: string | undefined;
    if (input.branch) {
      const branch = await tx.branch.create({
        data: {
          tenantId: tenant.id,
          name: input.branch.name ?? "الفرع الرئيسي",
          nameEn: input.branch.nameEn ?? "Main Branch",
          slug: input.branch.slug ?? "main",
          createdBy: input.ownerUserId,
        },
      });
      branchId = branch.id;
    }

    const permissions = await tx.permission.findMany();
    const permissionIdByKey = new Map(permissions.map((p) => [p.key, p.id]));

    const roleIdsByKey: Record<string, string> = {};
    for (const roleKey of SYSTEM_ROLES) {
      const role = await tx.role.create({
        data: {
          tenantId: tenant.id,
          key: roleKey,
          nameAr: ROLE_LABELS[roleKey].ar,
          nameEn: ROLE_LABELS[roleKey].en,
          isSystem: true,
          createdBy: input.ownerUserId,
        },
      });
      roleIdsByKey[roleKey] = role.id;

      await tx.rolePermission.createMany({
        data: DEFAULT_ROLE_PERMISSIONS[roleKey].map((permissionKey) => {
          const permissionId = permissionIdByKey.get(permissionKey);
          if (!permissionId) {
            throw new Error(
              `Permission catalog out of sync — missing key: ${permissionKey}`,
            );
          }
          return { tenantId: tenant.id, roleId: role.id, permissionId };
        }),
      });
    }

    await tx.userRole.create({
      data: {
        tenantId: tenant.id,
        userId: input.ownerUserId,
        roleId: roleIdsByKey.owner,
        branchId: null, // tenant-wide
        createdBy: input.ownerUserId,
      },
    });

    // Every new tenant starts on a 14-day trial of the default plan (plan
    // doc §5 MVP decision) — no payment gateway call, activation is manual.
    const defaultPlan = await tx.plan.findUnique({ where: { key: DEFAULT_PLAN_KEY } });
    if (!defaultPlan) {
      throw new Error(`Plan catalog out of sync — missing default plan: ${DEFAULT_PLAN_KEY}`);
    }
    await tx.subscription.create({
      data: {
        tenantId: tenant.id,
        planId: defaultPlan.id,
        status: "trialing",
        trialEndsAt: new Date(Date.now() + TRIAL_PERIOD_DAYS * 24 * 60 * 60 * 1000),
        createdBy: input.ownerUserId,
      },
    });

    return {
      tenantId: tenant.id,
      branchId,
      ownerUserId: input.ownerUserId,
      roleIdsByKey,
    };
  });
}
