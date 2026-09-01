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
      .send({ restaurantName: "مطعم بلا مفتاح", phone: "+966511111111", email: "nokey@e2e.test" })
      .expect(401);

    await request(http)
      .post("/public/trial-signup")
      .set("x-spruvex-site-key", "not-the-real-key")
      .send({ restaurantName: "مطعم مفتاح خاطئ", phone: "+966511111112", email: "wrongkey@e2e.test" })
      .expect(401);
  });

  it("rejects invalid input, e.g. a malformed phone number (hit 3/5)", async () => {
    await request(http)
      .post("/public/trial-signup")
      .set("x-spruvex-site-key", API_KEY)
      .send({ restaurantName: "مطعم", phone: "not-a-phone", email: "bad@e2e.test" })
      .expect(400);
  });

  describe("a valid trial signup (hit 4/5)", () => {
    const payload = {
      restaurantName: "مطعم التجربة المجانية",
      phone: "+966522222222",
      email: "trial-owner@e2e.test",
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

    it("rejects a second trial for the same phone number (hit 5/5)", async () => {
      const res = await request(http)
        .post("/public/trial-signup")
        .set("x-spruvex-site-key", API_KEY)
        .send({ ...payload, email: "different-email@e2e.test" })
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
});
