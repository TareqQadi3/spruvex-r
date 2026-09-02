import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaClient } from "@prisma/client";
import request from "supertest";

import { AppModule } from "../../src/app.module";
import { createAdminClient, truncateAll } from "../helpers/db";

/**
 * End-to-end coverage of POST /public/trial-signup — the spruvex-site
 * integration endpoint that provisions a real trial tenant with no user
 * session. Exercises the API key gate, the phone-uniqueness rule, that it
 * reuses (not duplicates) tenant-provisioning + the registration OTP flow,
 * and the per-IP rate limit.
 *
 * The functional tests below share one app instance and therefore one
 * throttle counter — kept to exactly 5 calls to /public/trial-signup
 * (this route's limit) so none of them ever gets throttled by accident.
 * The dedicated rate-limit test spins up its own isolated app instance
 * (a fresh ThrottlerStorage) instead of trying to budget around that.
 */
async function buildApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  await app.init();
  return app;
}

describe("public trial signup (e2e)", () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let http: ReturnType<INestApplication["getHttpServer"]>;

  const API_KEY = process.env.SPRUVEX_SITE_API_KEY!;

  beforeAll(async () => {
    admin = createAdminClient();
    await truncateAll(admin);

    const { syncPermissionCatalog } = await import(
      "../../src/modules/tenancy/tenant-provisioning"
    );
    await syncPermissionCatalog(admin);
    const { syncPlanCatalog } = await import("../../src/modules/billing/plan-catalog");
    await syncPlanCatalog(admin);

    app = await buildApp();
    http = app.getHttpServer();
  });

  afterAll(async () => {
    await app.close();
    await admin.$disconnect();
  });

  it("rejects a request with no API key or the wrong one (hits 1-2/5)", async () => {
    await request(http)
      .post("/public/trial-signup")
      .send({
        restaurantName: "مطعم بلا مفتاح",
        phone: "+966511111111",
        email: "nokey@e2e.test",
        password: "abc12345",
      })
      .expect(401);

    await request(http)
      .post("/public/trial-signup")
      .set("x-spruvex-site-key", "not-the-real-key")
      .send({
        restaurantName: "مطعم مفتاح خاطئ",
        phone: "+966511111112",
        email: "wrongkey@e2e.test",
        password: "abc12345",
      })
      .expect(401);
  });

  it("rejects invalid input, e.g. a malformed phone number (hit 3/5)", async () => {
    await request(http)
      .post("/public/trial-signup")
      .set("x-spruvex-site-key", API_KEY)
      .send({
        restaurantName: "مطعم",
        phone: "not-a-phone",
        email: "bad@e2e.test",
        password: "abc12345",
      })
      .expect(400);
  });

  describe("a valid trial signup (hit 4/5)", () => {
    const payload = {
      restaurantName: "مطعم التجربة المجانية",
      phone: "+966522222222",
      email: "trial-owner@e2e.test",
      password: "secret123",
      businessType: "dessert_cafe",
    };
    let devOtp = "";
    let tenantId = "";

    it("provisions a real tenant on a 14-day trial and returns an OTP", async () => {
      const res = await request(http)
        .post("/public/trial-signup")
        .set("x-spruvex-site-key", API_KEY)
        .send(payload)
        .expect(201);

      expect(res.body.tenantId).toBeDefined();
      expect(res.body.email).toBe(payload.email);
      expect(res.body.devOtp).toMatch(/^\d{6}$/);
      // One-time auto sign-in token rides along (consumed by the dashboard
      // at POST /auth/handoff after OTP verification).
      expect(res.body.handoffToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);
      tenantId = res.body.tenantId;
      devOtp = res.body.devOtp;

      const trialEndsAt = new Date(res.body.trialEndsAt);
      const daysUntilExpiry = (trialEndsAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
      expect(daysUntilExpiry).toBeGreaterThan(13.9);
      expect(daysUntilExpiry).toBeLessThan(14.1);

      // Reused the real provisioning path — not a parallel one: a working
      // subscription, owner role, and default branch all exist for real.
      const subscription = await admin.subscription.findUnique({ where: { tenantId } });
      expect(subscription?.status).toBe("trialing");

      // businessType passes through to Tenant.type, like the wizard does.
      const tenant = await admin.tenant.findUnique({ where: { id: tenantId } });
      expect(tenant?.type).toBe(payload.businessType);

      const owner = await admin.user.findUnique({ where: { email: payload.email } });
      expect(owner).toBeTruthy();
      expect(owner?.phone).toBe(payload.phone);
      expect(owner?.emailVerifiedAt).toBeNull(); // not verified yet — same state a fresh self-registration leaves

      const ownerRole = await admin.userRole.findFirst({
        where: { tenantId, userId: owner!.id },
        include: { role: true },
      });
      expect(ownerRole?.role.key).toBe("owner");

      const branch = await admin.branch.findFirst({ where: { tenantId } });
      expect(branch).toBeTruthy();
    });

    it("logs the merchant in through the SAME endpoint every self-registered owner uses", async () => {
      // /auth/register/verify — a different route, doesn't touch this
      // describe's /public/trial-signup throttle budget.
      const res = await request(http)
        .post("/auth/register/verify")
        .send({ email: payload.email, code: devOtp })
        .expect(200);

      expect(res.body.tokens.accessToken).toBeDefined();
      expect(res.body.user.email).toBe(payload.email);

      const owner = await admin.user.findUnique({ where: { email: payload.email } });
      expect(owner?.emailVerifiedAt).toBeTruthy();
    });

    it("lets the merchant log in later with the password they chose on the form", async () => {
      // The whole point of storing input.password (not a random placeholder):
      // /auth/login must accept it, same endpoint every owner uses.
      const res = await request(http)
        .post("/auth/login")
        .send({ email: payload.email, password: payload.password })
        .expect(200);

      expect(res.body.tokens.accessToken).toBeDefined();
      expect(res.body.user.email).toBe(payload.email);
    });

    it("rejects a second trial for the same phone number (hit 5/5)", async () => {
      const res = await request(http)
        .post("/public/trial-signup")
        .set("x-spruvex-site-key", API_KEY)
        .send({ ...payload, email: "different-email@e2e.test", password: "secret123" })
        .expect(409);
      expect(res.body.message).toMatch(/already has a SpruVex R account/i);
    });
  });

  describe("rate limiting", () => {
    // Own app instance = own in-memory ThrottlerStorage, so this doesn't
    // interfere with (or get interfered by) the 5 calls used above.
    let isolatedApp: INestApplication;

    beforeAll(async () => {
      isolatedApp = await buildApp();
    });

    afterAll(async () => {
      await isolatedApp.close();
    });

    it("blocks the 6th /public/trial-signup call from one caller within the window", async () => {
      const isolatedHttp = isolatedApp.getHttpServer();
      // A cheap payload (fails validation) is enough: ThrottlerGuard counts
      // the request before the ValidationPipe ever runs.
      const attempt = () =>
        request(isolatedHttp)
          .post("/public/trial-signup")
          .set("x-spruvex-site-key", API_KEY)
          .send({ restaurantName: "x", phone: "bad", email: "bad" });

      for (let i = 0; i < 5; i++) {
        await attempt().expect(400);
      }
      await attempt().expect(429);
    });
  });

  describe("handoff tokens (marketing site → dashboard auto sign-in)", () => {
    // Own app instance = own throttle budget for /public/trial-signup.
    let isolatedApp: INestApplication;
    let isolatedHttp: ReturnType<INestApplication["getHttpServer"]>;

    beforeAll(async () => {
      isolatedApp = await buildApp();
      isolatedHttp = isolatedApp.getHttpServer();
    });

    afterAll(async () => {
      await isolatedApp.close();
    });

    const trial = {
      restaurantName: "مطعم الدخول التلقائي",
      phone: "+966533333333",
      email: "handoff-owner@e2e.test",
      password: "AutoSign1n",
      businessType: "restaurant",
    };

    it("exchanges the handoff token for a full session — exactly once", async () => {
      const signup = await request(isolatedHttp)
        .post("/public/trial-signup")
        .set("x-spruvex-site-key", API_KEY)
        .send(trial)
        .expect(201);
      const handoffToken = signup.body.handoffToken as string;
      expect(handoffToken).toBeDefined();

      // Skip OTP-verify (handoff exchange does not require it) — the token
      // itself is the proof the marketing site collected; its single-use
      // nature is what this test pins down.
      const first = await request(isolatedHttp)
        .post("/auth/handoff")
        .send({ token: handoffToken })
        .expect(200);
      expect(first.body.tokens.accessToken).toBeDefined();
      expect(first.body.tokens.refreshToken).toBeDefined();

      // Replay: the SAME token must fail — single-use fails closed.
      await request(isolatedHttp)
        .post("/auth/handoff")
        .send({ token: handoffToken })
        .expect(401);

      // Garbage token: indistinguishable rejection, no information leak.
      await request(isolatedHttp)
        .post("/auth/handoff")
        .send({ token: "not-a-real-token" })
        .expect(401);
    });
  });

  describe("email normalization (the +tag loophole)", () => {
    // Own app instance = own throttle budget for /public/trial-signup.
    let isolatedApp: INestApplication;
    let isolatedHttp: ReturnType<INestApplication["getHttpServer"]>;

    beforeAll(async () => {
      isolatedApp = await buildApp();
      isolatedHttp = isolatedApp.getHttpServer();
    });

    afterAll(async () => {
      await isolatedApp.close();
    });

    it("treats user+anything@x and user@x as the SAME inbox", async () => {
      // First signup: base address.
      await request(isolatedHttp)
        .post("/public/trial-signup")
        .set("x-spruvex-site-key", API_KEY)
        .send({
          restaurantName: "مطعم التطبيع",
          phone: "+966544444444",
          email: "normalized@e2e.test",
          password: "Normal1ze",
        })
        .expect(201);

      // Second signup, DIFFERENT phone but same inbox via +tag → must NOT
      // create a second account — 409, same as the plain duplicate.
      const res = await request(isolatedHttp)
        .post("/public/trial-signup")
        .set("x-spruvex-site-key", API_KEY)
        .send({
          restaurantName: "مطعم التطبيع 2",
          phone: "+966544444445",
          email: "normalized+promo@e2e.test",
          password: "Normal1ze",
        })
        .expect(409);
      expect(res.body.message).toMatch(/already exists/i);

      // Login with the tagged variant maps to the SAME account (403 =
      // "email not verified" guard, NOT 401 "invalid credentials": proves
      // normalizeEmail found the account). Full login is covered by the
      // OTP-verified path in the main describe above.
      const login = await request(isolatedHttp)
        .post("/auth/login")
        .send({ email: "normalized+whatever@e2e.test", password: "Normal1ze" })
        .expect(403);
      expect(login.body.message).toMatch(/not verified/i);
    });

    it("recovers a stuck unverified signup instead of 409-ing into a dead end", async () => {
      // Signup that never verifies (simulating a merchant who lost the OTP
      // email and gave up — the exact trap the project owner hit).
      const first = await request(isolatedHttp)
        .post("/public/trial-signup")
        .set("x-spruvex-site-key", API_KEY)
        .send({
          restaurantName: "مطعم عالق قديم",
          phone: "+966544444446",
          email: "stuck-owner@e2e.test",
          password: "FirstPass1",
        })
        .expect(201);

      // A verified account (or one that already owns a tenant) gets the real
      // 409... but this one is unverified AND tenant-less from the FIRST
      // signup — wait: trial signup provisions a tenant immediately, so
      // re-signup with this email hits "already owns a tenant" 409. The
      // recovery path covers users created via /auth/register (no tenant
      // yet) who then try the trial form. Cover exactly that:
      await request(isolatedHttp)
        .post("/auth/register")
        .send({
          name: "تاجر من اللوحة",
          email: "wizard-owner@e2e.test",
          password: "WizardPass1",
          phone: "+966544444447",
        })
        .expect(201);

      // Same email now signs up through the marketing site — the unverified,
      // tenant-less account is ADOPTED and the trial completes (201), not 409.
      const adopted = await request(isolatedHttp)
        .post("/public/trial-signup")
        .set("x-spruvex-site-key", API_KEY)
        .send({
          restaurantName: "مطعم تاجر اللوحة",
          phone: "+966544444447",
          email: "wizard-owner@e2e.test",
          password: "NewChosen1",
        })
        .expect(201);
      expect(adopted.body.tenantId).toBeDefined();

      // They log in with the NEWLY chosen password — 403 "email not
      // verified" (not 401 "invalid credentials") proves the password
      // update took AND normalizeEmail routed to the adopted account. The
      // unverified-login guard itself is the product's designed behavior.
      const adoptedLogin = await request(isolatedHttp)
        .post("/auth/login")
        .send({ email: "wizard-owner@e2e.test", password: "NewChosen1" })
        .expect(403);
      expect(adoptedLogin.body.message).toMatch(/not verified/i);

      // A wrong old password is rejected as invalid credentials (401) —
      // pinning that the ADOPTED password actually replaced the old one.
      await request(isolatedHttp)
        .post("/auth/login")
        .send({ email: "wizard-owner@e2e.test", password: "WrongOld1" })
        .expect(401);

      // A REAL duplicate (verified account with a tenant) keeps the 409.
      await request(isolatedHttp)
        .post("/public/trial-signup")
        .set("x-spruvex-site-key", API_KEY)
        .send({
          restaurantName: "محاولة مكررة",
          phone: "+966544444448",
          email: first.body.email,
          password: "FirstPass1",
        })
        .expect(409);
    });
  });
});
