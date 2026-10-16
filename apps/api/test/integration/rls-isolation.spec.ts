import { PrismaClient } from "@prisma/client";

import { syncPermissionCatalog } from "../../src/modules/tenancy/tenant-provisioning";
import { PrismaService } from "../../src/shared/prisma/prisma.service";
import { TenantContextService } from "../../src/shared/tenancy/tenant-context.service";
import { createAdminClient, createRawAppClient, truncateAll } from "../helpers/db";
import { provisionTestTenant } from "../helpers/provision";

type ProvisionedTenant = Awaited<ReturnType<typeof provisionTestTenant>>;

/**
 * The Phase 0 gate: proves that Row-Level Security + the tenant-scoped Prisma
 * client make cross-tenant reads/writes impossible, and that queries without
 * a tenant context fail closed (return nothing / reject writes).
 */
describe("multi-tenant isolation (RLS)", () => {
  let admin: PrismaClient;
  let prisma: PrismaService;
  let tenantContext: TenantContextService;
  let tenantA: ProvisionedTenant;
  let tenantB: ProvisionedTenant;

  beforeAll(async () => {
    admin = createAdminClient();
    await truncateAll(admin);
    await syncPermissionCatalog(admin);

    tenantA = await provisionTestTenant(admin, {
      name: "مطعم ألف",
      slug: "tenant-a",
      ownerEmail: "owner-a@rls.test",
    });
    tenantB = await provisionTestTenant(admin, {
      name: "مطعم باء",
      slug: "tenant-b",
      ownerEmail: "owner-b@rls.test",
    });

    tenantContext = new TenantContextService();
    prisma = new PrismaService(tenantContext);
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await admin.$disconnect();
  });

  it("scopes reads to the current tenant", async () => {
    const branches = await prisma.forTenant(tenantA.tenantId).branch.findMany();
    expect(branches).toHaveLength(1);
    expect(branches[0].id).toBe(tenantA.branchId);
    expect(branches.every((b) => b.tenantId === tenantA.tenantId)).toBe(true);
  });

  it("cannot read another tenant's rows, even by primary key", async () => {
    const scopedToA = prisma.forTenant(tenantA.tenantId);

    const branchB = await scopedToA.branch.findUnique({
      where: { id: tenantB.branchId! },
    });
    expect(branchB).toBeNull();

    const tenantRowB = await scopedToA.tenant.findUnique({
      where: { id: tenantB.tenantId },
    });
    expect(tenantRowB).toBeNull();

    const rolesVisible = await scopedToA.role.findMany();
    expect(rolesVisible.every((r) => r.tenantId === tenantA.tenantId)).toBe(true);
  });

  it("rejects inserting rows that claim another tenant's id", async () => {
    await expect(
      prisma.forTenant(tenantA.tenantId).branch.create({
        data: {
          tenantId: tenantB.tenantId,
          name: "فرع مزور",
          slug: "forged",
        },
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it("cannot update or delete another tenant's rows", async () => {
    const scopedToA = prisma.forTenant(tenantA.tenantId);

    const updated = await scopedToA.branch.updateMany({
      where: { id: tenantB.branchId! },
      data: { name: "hijacked" },
    });
    expect(updated.count).toBe(0);

    const deleted = await scopedToA.role.deleteMany({
      where: { tenantId: tenantB.tenantId },
    });
    expect(deleted.count).toBe(0);

    // Verify tenant B is untouched.
    const branchB = await admin.branch.findUniqueOrThrow({ where: { id: tenantB.branchId! } });
    expect(branchB.name).not.toBe("hijacked");
  });

  it("fails closed when no tenant context is set", async () => {
    const raw = createRawAppClient();
    try {
      // Reads return nothing.
      expect(await raw.tenant.findMany()).toHaveLength(0);
      expect(await raw.branch.findMany()).toHaveLength(0);
      expect(await raw.role.findMany()).toHaveLength(0);

      // Writes are rejected.
      await expect(
        raw.branch.create({
          data: { tenantId: tenantA.tenantId, name: "no-context", slug: "no-context" },
        }),
      ).rejects.toThrow(/row-level security/i);
    } finally {
      await raw.$disconnect();
    }
  });

  it("`scoped` uses the request context and throws without one", () => {
    expect(() => prisma.scoped).toThrow(/tenant context/i);

    tenantContext.run(
      { userId: tenantA.ownerUserId, tenantId: tenantA.tenantId, permissions: new Set() },
      () => {
        expect(() => prisma.scoped).not.toThrow();
      },
    );
  });

  it("rejects malformed tenant ids before touching the database", () => {
    expect(() => prisma.forTenant("not-a-uuid")).toThrow(/invalid tenant id/i);
  });

  it("provisions the five system roles with default permissions", async () => {
    const scopedToA = prisma.forTenant(tenantA.tenantId);
    const roles = await scopedToA.role.findMany({ include: { rolePermissions: true } });
    expect(roles.map((r) => r.key).sort()).toEqual(
      ["cashier", "kitchen", "manager", "owner", "waiter"],
    );
    const owner = roles.find((r) => r.key === "owner");
    expect(owner!.rolePermissions.length).toBeGreaterThan(20);
  });

  /**
   * Schema-driven sweep (cleanup-round audit item #2): rather than one
   * hand-written assertion per table — which silently stops covering a new
   * table the day someone forgets to add its RLS block to a migration —
   * this derives the list of tables that MUST be tenant-isolated straight
   * from the schema itself (any table with a tenant_id column) and checks
   * every one of them against Postgres's actual RLS state, not just "the
   * migration file that created it looked right at the time".
   */
  describe("RLS coverage sweep — every tenant-owned table, derived from the schema", () => {
    it("has RLS enabled, FORCED, and a tenant_isolation policy on every table with a tenant_id column", async () => {
      const rows = await admin.$queryRaw<
        { table_name: string; relrowsecurity: boolean; relforcerowsecurity: boolean; has_policy: boolean }[]
      >`
        SELECT c.relname AS table_name, c.relrowsecurity, c.relforcerowsecurity,
               EXISTS(
                 SELECT 1 FROM pg_policies p
                 WHERE p.schemaname = 'public' AND p.tablename = c.relname AND p.policyname = 'tenant_isolation'
               ) AS has_policy
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND EXISTS (
            SELECT 1 FROM information_schema.columns col
            WHERE col.table_schema = 'public' AND col.table_name = c.relname AND col.column_name = 'tenant_id'
          )
        ORDER BY c.relname
      `;

      // Guards against this test silently passing vacuously (e.g. a query
      // typo returning zero rows) — a real deployment has dozens of these.
      expect(rows.length).toBeGreaterThan(30);

      const unprotected = rows.filter((r) => !r.relrowsecurity || !r.relforcerowsecurity || !r.has_policy);
      expect(unprotected).toEqual([]);
    });
  });
});
