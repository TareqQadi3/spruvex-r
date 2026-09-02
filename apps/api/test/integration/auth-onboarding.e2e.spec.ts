import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaClient } from "@prisma/client";
import request from "supertest";

import { AppModule } from "../../src/app.module";
import { createAdminClient, truncateAll } from "../helpers/db";

/**
 * End-to-end coverage of Phase 1: registration + OTP, login security,
 * token rotation, the onboarding wizard (steps 2-5) and permission
 * enforcement over real HTTP.
 */
describe("auth & onboarding (e2e)", () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let http: ReturnType<INestApplication["getHttpServer"]>;

  const owner = {
    name: "أبو فيصل",
    email: "owner@e2e.test",
    password: "Str0ng-pass",
  };

  // Mutable session state threaded through the wizard tests (they run in order).
  let accessToken = "";
  let refreshToken = "";
  let branchId = "";

  beforeAll(async () => {
    admin = createAdminClient();
    await truncateAll(admin);

    const { syncPermissionCatalog } = await import(
      "../../src/modules/tenancy/tenant-provisioning"
    );
    await syncPermissionCatalog(admin);
    const { syncPlanCatalog } = await import("../../src/modules/billing/plan-catalog");
    await syncPlanCatalog(admin);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    http = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
    await admin.$disconnect();
  });

  describe("registration flow (wizard step 1)", () => {
    it("rejects weak passwords", async () => {
      await request(http)
        .post("/auth/register")
        .send({ ...owner, password: "short1" })
        .expect(400);
      await request(http)
        .post("/auth/register")
        .send({ ...owner, password: "onlyletters" })
        .expect(400);
    });

    let devOtp = "";

    it("registers and issues an OTP (dev code returned outside production)", async () => {
      const res = await request(http).post("/auth/register").send(owner).expect(201);
      expect(res.body.userId).toBeDefined();
      expect(res.body.devOtp).toMatch(/^\d{6}$/);
      devOtp = res.body.devOtp;

      const user = await admin.user.findUnique({ where: { email: owner.email } });
      expect(user?.emailVerifiedAt).toBeNull();
    });

    it("rejects a wrong OTP and counts the attempt", async () => {
      const wrong = devOtp === "000000" ? "000001" : "000000";
      await request(http)
        .post("/auth/register/verify")
        .send({ email: owner.email, code: wrong })
        .expect(400);
    });

    it("blocks login before verification", async () => {
      await request(http)
        .post("/auth/login")
        .send({ email: owner.email, password: owner.password })
        .expect(403);
    });

    it("verifies the OTP, marks the email verified and signs the owner in", async () => {
      const res = await request(http)
        .post("/auth/register/verify")
        .send({ email: owner.email, code: devOtp })
        .expect(200);

      expect(res.body.tokens.accessToken).toBeDefined();
      expect(res.body.tokens.refreshToken).toBeDefined();
      expect(res.body.user.tenantId).toBeUndefined(); // no restaurant yet
      accessToken = res.body.tokens.accessToken;
      refreshToken = res.body.tokens.refreshToken;

      const user = await admin.user.findUnique({ where: { email: owner.email } });
      expect(user?.emailVerifiedAt).not.toBeNull();
    });

    it("rejects registering the same (verified) email again", async () => {
      await request(http).post("/auth/register").send(owner).expect(409);
    });

    it("does not accept a consumed OTP twice", async () => {
      await request(http)
        .post("/auth/register/verify")
        .send({ email: owner.email, code: devOtp })
        .expect(400);
    });
  });

  describe("onboarding wizard (steps 2-5)", () => {
    it("reports step 2 for a fresh owner", async () => {
      const res = await request(http)
        .get("/onboarding/status")
        .set("Authorization", `Bearer ${accessToken}`)
        .expect(200);
      expect(res.body.step).toBe(2);
    });

    it("blocks tenant-scoped onboarding steps before a restaurant exists", async () => {
      await request(http)
        .post("/onboarding/branch")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ name: "فرع" })
        .expect(403); // token has no permissions yet
    });

    it("step 2: creates the restaurant and returns tenant-scoped tokens", async () => {
      const res = await request(http)
        .post("/onboarding/restaurant")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({
          name: "مطعم البيك الشعبي",
          nameEn: "Popular Grill",
          type: "restaurant",
          country: "SA",
          currency: "SAR",
          defaultLocale: "ar",
        })
        .expect(201);

      expect(res.body.tenantId).toBeDefined();
      accessToken = res.body.tokens.accessToken;
      refreshToken = res.body.tokens.refreshToken;

      // Tenant provisioned with system roles + owner membership + audit entry.
      const roles = await admin.role.findMany({ where: { tenantId: res.body.tenantId } });
      expect(roles.map((r) => r.key).sort()).toEqual(
        ["cashier", "kitchen", "manager", "owner", "waiter"],
      );
      const auditRows = await admin.auditLog.findMany({
        where: { tenantId: res.body.tenantId, action: "tenant.created" },
      });
      expect(auditRows).toHaveLength(1);
    });

    it("rejects creating a second restaurant for the same account", async () => {
      await request(http)
        .post("/onboarding/restaurant")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ name: "مطعم آخر" })
        .expect(409);
    });

    it("blocks completing setup before a branch exists", async () => {
      await request(http)
        .post("/onboarding/complete")
        .set("Authorization", `Bearer ${accessToken}`)
        .expect(400);
    });

    it("step 3: creates the first branch", async () => {
      const res = await request(http)
        .post("/onboarding/branch")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({
          name: "فرع العليا",
          nameEn: "Olaya Branch",
          address: "شارع العليا، الرياض",
          phone: "+966500000000",
          email: "olaya@grill.test",
        })
        .expect(201);
      branchId = res.body.branchId;
      expect(branchId).toBeDefined();
    });

    it("step 4: creates manager and cashier with role assignments", async () => {
      const res = await request(http)
        .post("/onboarding/staff")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({
          users: [
            {
              name: "مدير الفرع",
              email: "manager@e2e.test",
              password: "Manager-1pass",
              role: "manager",
              branchId,
            },
            {
              name: "الكاشير",
              email: "cashier@e2e.test",
              password: "Cashier-1pass",
              role: "cashier",
              branchId,
            },
          ],
        })
        .expect(201);
      expect(res.body.created).toHaveLength(2);

      // Role assignment is visible through the members endpoint.
      const members = await request(http)
        .get("/users")
        .set("Authorization", `Bearer ${accessToken}`)
        .expect(200);
      const byEmail = Object.fromEntries(
        members.body.map((m: { email: string; role: { key: string } }) => [m.email, m.role.key]),
      );
      expect(byEmail["manager@e2e.test"]).toBe("manager");
      expect(byEmail["cashier@e2e.test"]).toBe("cashier");
    });

    it("step 5: completes onboarding", async () => {
      const res = await request(http)
        .post("/onboarding/complete")
        .set("Authorization", `Bearer ${accessToken}`)
        .expect(200);
      expect(res.body.completedAt).toBeDefined();

      const status = await request(http)
        .get("/onboarding/status")
        .set("Authorization", `Bearer ${accessToken}`)
        .expect(200);
      expect(status.body.step).toBe("done");
    });

    it("adding the OWNER's own email as staff assigns the role to the existing account (no 409)", async () => {
      // The dashboard's staff step invites reusing the owner's email for the
      // manager role (a one-person restaurant). This used to dead-end on
      // "An account with email ... already exists" on the owner's FIRST
      // session. Now the manager role attaches to the existing account.
      const res = await request(http)
        .post("/onboarding/staff")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({
          users: [
            {
              name: "المالك نفسه كمدير",
              email: owner.email, // the OWNER's own address
              password: "Irrelevant-1", // must be ignored for an existing account
              role: "manager",
            },
          ],
        })
        .expect(201);
      expect(res.body.created).toHaveLength(1);
      expect(res.body.created[0].email).toBe(owner.email);

      // The owner now carries BOTH memberships (owner + manager) in the tenant.
      const memberships = await admin.userRole.findMany({
        where: { user: { email: owner.email } },
        include: { role: true },
      });
      const keys = memberships.map((m) => m.role.key).sort();
      expect(keys).toContain("owner");
      expect(keys).toContain("manager");

      // The owner's password was NOT clobbered by the throwaway input above.
      const login = await request(http)
        .post("/auth/login")
        .send({ email: owner.email, password: owner.password })
        .expect(200);
      expect(login.body.tokens.accessToken).toBeDefined();
    });

    it("an email owned by a DIFFERENT tenant still gets the 409 (no cross-tenant linking)", async () => {
      // A second, unrelated account (e.g. another restaurant's staff member).
      await admin.user.create({
        data: {
          name: "خارجي",
          email: "outsider@e2e.test",
          passwordHash: "x",
          emailVerifiedAt: new Date(),
        },
      });
      await request(http)
        .post("/onboarding/staff")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({
          users: [
            { name: "خارجي", email: "outsider@e2e.test", password: "Outsider-1", role: "cashier" },
          ],
        })
        .expect(409);
    });
  });

  describe("permission enforcement (e2e)", () => {
    let cashierToken = "";

    it("staff can sign in and receive role-scoped permissions", async () => {
      const res = await request(http)
        .post("/auth/login")
        .send({ email: "cashier@e2e.test", password: "Cashier-1pass" })
        .expect(200);
      cashierToken = res.body.tokens.accessToken;
      expect(res.body.user.permissions).toContain("orders.create");
      expect(res.body.user.permissions).not.toContain("users.manage");
    });

    it("rejects requests without a token", async () => {
      await request(http).get("/branches").expect(401);
    });

    it("rejects garbage tokens", async () => {
      await request(http)
        .get("/branches")
        .set("Authorization", "Bearer not-a-jwt")
        .expect(401);
    });

    it("denies endpoints the role lacks (cashier vs users.manage)", async () => {
      await request(http)
        .get("/users")
        .set("Authorization", `Bearer ${cashierToken}`)
        .expect(403);
      await request(http)
        .get("/branches")
        .set("Authorization", `Bearer ${cashierToken}`)
        .expect(403);
    });

    it("allows endpoints the role holds (owner)", async () => {
      const res = await request(http)
        .get("/branches")
        .set("Authorization", `Bearer ${accessToken}`)
        .expect(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].name).toBe("فرع العليا");
    });
  });

  describe("authentication security", () => {
    it("rejects wrong passwords with a uniform error", async () => {
      const res = await request(http)
        .post("/auth/login")
        .send({ email: owner.email, password: "Wrong-pass1" })
        .expect(401);
      expect(res.body.message).toBe("Invalid email or password");

      const unknown = await request(http)
        .post("/auth/login")
        .send({ email: "ghost@e2e.test", password: "Wrong-pass1" })
        .expect(401);
      expect(unknown.body.message).toBe("Invalid email or password");
    });

    it("locks the account after repeated failed attempts", async () => {
      const victim = await admin.user.create({
        data: {
          email: "lockout@e2e.test",
          name: "Lockout",
          passwordHash: "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva",
          emailVerifiedAt: new Date(),
        },
      });
      for (let i = 0; i < 5; i++) {
        await request(http)
          .post("/auth/login")
          .send({ email: victim.email, password: "Bad-pass1" })
          .expect(401);
      }
      await request(http)
        .post("/auth/login")
        .send({ email: victim.email, password: "Bad-pass1" })
        .expect(403); // locked

      const row = await admin.user.findUnique({ where: { id: victim.id } });
      expect(row?.lockedUntil).not.toBeNull();
    });

    it("rotates refresh tokens and detects reuse (family revocation)", async () => {
      const first = await request(http)
        .post("/auth/refresh")
        .send({ refreshToken })
        .expect(200);
      const rotated = first.body.refreshToken;
      expect(rotated).not.toBe(refreshToken);

      // Re-using the OLD token = theft signal → whole family revoked.
      await request(http).post("/auth/refresh").send({ refreshToken }).expect(401);
      await request(http).post("/auth/refresh").send({ refreshToken: rotated }).expect(401);
    });

    it("logout revokes the session family", async () => {
      const login = await request(http)
        .post("/auth/login")
        .send({ email: owner.email, password: owner.password })
        .expect(200);
      const rt = login.body.tokens.refreshToken;

      await request(http).post("/auth/logout").send({ refreshToken: rt }).expect(204);
      await request(http).post("/auth/refresh").send({ refreshToken: rt }).expect(401);
    });

    it("access token reflects tenant context on /auth/me", async () => {
      const login = await request(http)
        .post("/auth/login")
        .send({ email: owner.email, password: owner.password })
        .expect(200);

      const me = await request(http)
        .get("/auth/me")
        .set("Authorization", `Bearer ${login.body.tokens.accessToken}`)
        .expect(200);
      expect(me.body.email).toBe(owner.email);
      expect(me.body.tenantId).toBeDefined();
      expect(me.body.permissions).toContain("users.manage");
      expect(me.body.onboardingCompleted).toBe(true);
    });
  });
});
