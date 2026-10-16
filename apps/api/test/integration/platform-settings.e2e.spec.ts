import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaClient } from "@prisma/client";
import request from "supertest";

import { AppModule } from "../../src/app.module";
import { hashPassword } from "../../src/modules/identity/password";
import { PLATFORM_SETTINGS_DEFAULTS } from "../../src/shared/platform-settings/platform-settings.types";
import { syncPermissionCatalog } from "../../src/modules/tenancy/tenant-provisioning";
import { createAdminClient, truncateAll } from "../helpers/db";
import { provisionTestTenant } from "../helpers/provision";

/**
 * Cleanup-round follow-up: platform-wide settings (OTP/lockout policy,
 * upload ceiling) moved from hardcoded constants to one editable row, shared
 * by tenant-user login (identity/auth.service.ts) AND platform-admin login
 * (platform/platform-auth.service.ts) — the whole point of this suite's
 * "unify the lockout policy" test.
 */
describe("platform settings (e2e)", () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let tenantOwnerEmail = "";
  let tenantOwnerToken = "";

  async function createPlatformAdmin(email: string, password: string) {
    await admin.platformAdmin.create({
      data: { email, name: "Ops", passwordHash: await hashPassword(password) },
    });
  }

  async function platformLoginToken(email: string, password: string): Promise<string> {
    const res = await request(http).post("/platform/auth/login").send({ email, password }).expect(200);
    return res.body.accessToken;
  }

  beforeAll(async () => {
    admin = createAdminClient();
    await truncateAll(admin);
    await syncPermissionCatalog(admin);

    tenantOwnerEmail = "owner@platform-settings.test";
    await provisionTestTenant(admin, {
      name: "مطعم إعدادات المنصة",
      slug: "platform-settings",
      ownerEmail: tenantOwnerEmail,
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    http = app.getHttpServer();

    tenantOwnerToken = (
      await request(http).post("/auth/login").send({ email: tenantOwnerEmail, password: "Test-12345" }).expect(200)
    ).body.tokens.accessToken;
  });

  afterAll(async () => {
    await app.close();
    await admin.$disconnect();
  });

  it("rejects unauthenticated and tenant-token access", async () => {
    await request(http).get("/platform/settings").expect(401);
    await request(http)
      .get("/platform/settings")
      .set("Authorization", `Bearer ${tenantOwnerToken}`)
      .expect(401);
  });

  it("returns documented defaults before any admin ever touches them", async () => {
    await createPlatformAdmin("defaults@spruvex.internal", "Defaults-1pass");
    const token = await platformLoginToken("defaults@spruvex.internal", "Defaults-1pass");

    const res = await request(http)
      .get("/platform/settings")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body).toEqual(PLATFORM_SETTINGS_DEFAULTS);
  });

  it("rejects an out-of-bounds value without writing anything", async () => {
    await createPlatformAdmin("bounds@spruvex.internal", "Bounds-1pass");
    const token = await platformLoginToken("bounds@spruvex.internal", "Bounds-1pass");

    await request(http)
      .patch("/platform/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({ otpTtlMinutes: 0 })
      .expect(400);
    await request(http)
      .patch("/platform/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({ maxUploadBytes: 100 * 1024 * 1024 }) // above the multer hard ceiling
      .expect(400);

    const res = await request(http)
      .get("/platform/settings")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(res.body).toEqual(PLATFORM_SETTINGS_DEFAULTS);
  });

  it("updates one field, leaves the rest untouched, and audits the exact before/after", async () => {
    await createPlatformAdmin("update@spruvex.internal", "Update-1pass");
    const token = await platformLoginToken("update@spruvex.internal", "Update-1pass");

    const updated = await request(http)
      .patch("/platform/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({ otpTtlMinutes: 20 })
      .expect(200);
    expect(updated.body).toEqual({ ...PLATFORM_SETTINGS_DEFAULTS, otpTtlMinutes: 20 });

    const auditRows = await admin.platformAuditLog.findMany({
      where: { action: "platform.settings_updated" },
      orderBy: { createdAt: "desc" },
    });
    expect(auditRows[0].meta).toMatchObject({
      changes: { otpTtlMinutes: { from: PLATFORM_SETTINGS_DEFAULTS.otpTtlMinutes, to: 20 } },
      platformAdminEmail: "update@spruvex.internal",
    });

    const auditList = await request(http)
      .get("/platform/settings/audit-log")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(auditList.body[0].action).toBe("platform.settings_updated");
    expect(auditList.body[0].platformAdmin.email).toBe("update@spruvex.internal");

    // Reset for later tests in this file.
    await request(http)
      .patch("/platform/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({ otpTtlMinutes: PLATFORM_SETTINGS_DEFAULTS.otpTtlMinutes })
      .expect(200);
  });

  it("does not write an audit row when the patch changes nothing", async () => {
    await createPlatformAdmin("noop@spruvex.internal", "Noop-1pass");
    const token = await platformLoginToken("noop@spruvex.internal", "Noop-1pass");

    await request(http)
      .patch("/platform/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({ otpTtlMinutes: PLATFORM_SETTINGS_DEFAULTS.otpTtlMinutes })
      .expect(200);

    const auditCount = await admin.platformAuditLog.count({
      where: { action: "platform.settings_updated", meta: { path: ["platformAdminEmail"], equals: "noop@spruvex.internal" } },
    });
    expect(auditCount).toBe(0);
  });

  it("one lockout policy governs BOTH tenant-user login and platform-admin login", async () => {
    await createPlatformAdmin("lockout-setter@spruvex.internal", "Setter-1pass");
    const setterToken = await platformLoginToken("lockout-setter@spruvex.internal", "Setter-1pass");
    await request(http)
      .patch("/platform/settings")
      .set("Authorization", `Bearer ${setterToken}`)
      .send({ maxFailedLogins: 2, lockoutMinutes: 5 })
      .expect(200);

    // Tenant-user side: locks after exactly 2 wrong attempts now, not 5.
    const lockoutTenantEmail = "lockout-tenant@platform-settings.test";
    await provisionTestTenant(admin, {
      name: "مطعم اختبار القفل",
      slug: "lockout-tenant",
      ownerEmail: lockoutTenantEmail,
    });
    await request(http).post("/auth/login").send({ email: lockoutTenantEmail, password: "Wrong-pass1" }).expect(401);
    await request(http).post("/auth/login").send({ email: lockoutTenantEmail, password: "Wrong-pass1" }).expect(401);
    const lockedTenant = await request(http)
      .post("/auth/login")
      .send({ email: lockoutTenantEmail, password: "Test-12345" }) // correct password, now locked
      .expect(403);
    expect(lockedTenant.body.message).toMatch(/locked/i);

    // Platform-admin side: same 2-attempt threshold, same shared setting.
    await createPlatformAdmin("lockout-victim@spruvex.internal", "Victim-1pass");
    await request(http)
      .post("/platform/auth/login")
      .send({ email: "lockout-victim@spruvex.internal", password: "Wrong-pass1" })
      .expect(401);
    await request(http)
      .post("/platform/auth/login")
      .send({ email: "lockout-victim@spruvex.internal", password: "Wrong-pass1" })
      .expect(401);
    const lockedAdmin = await request(http)
      .post("/platform/auth/login")
      .send({ email: "lockout-victim@spruvex.internal", password: "Victim-1pass" }) // correct, now locked
      .expect(403);
    expect(lockedAdmin.body.message).toMatch(/locked/i);

    // Restore defaults so no other suite/file is affected.
    await request(http)
      .patch("/platform/settings")
      .set("Authorization", `Bearer ${setterToken}`)
      .send({
        maxFailedLogins: PLATFORM_SETTINGS_DEFAULTS.maxFailedLogins,
        lockoutMinutes: PLATFORM_SETTINGS_DEFAULTS.lockoutMinutes,
      })
      .expect(200);
  });
});
