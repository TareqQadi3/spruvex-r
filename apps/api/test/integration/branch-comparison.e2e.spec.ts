import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import request from "supertest";

import { AppModule } from "../../src/app.module";
import { syncPermissionCatalog } from "../../src/modules/tenancy/tenant-provisioning";
import { createOrderingFixtures } from "../helpers/catalog-fixtures";
import { createAdminClient, truncateAll } from "../helpers/db";
import { provisionTestTenant } from "../helpers/provision";

type Fixtures = Awaited<ReturnType<typeof createOrderingFixtures>>;

async function waitUntil<T>(check: () => Promise<T | null | undefined | false>, timeoutMs = 4000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result) return result as T;
    if (Date.now() > deadline) {
      throw new Error("waitUntil: condition not met before timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Branch comparison dashboard — read-only, built from real orders, the
 * loyalty ledger, and ratings. Numbers below are hand-computed (see comments)
 * against two branches under one tenant:
 *
 * Branch A: 4 completed orders (12.00 + 12.00 + 35.00 + 11.00-after-a-1.00-
 * loyalty-discount) = 70.00 SAR, avg 17.50; 1 of those 4 orders redeemed
 * loyalty -> 25% usage.
 * Branch B: 1 completed order of 24.00 SAR (2x the 12.00 item); loyalty is
 * enabled tenant-wide but never used there -> 0% usage (not "unavailable").
 */
describe("branch comparison report (e2e)", () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let http: ReturnType<INestApplication["getHttpServer"]>;

  let ownerA = "";
  let cashierA = ""; // no reports.view
  let ownerC = "";
  let tenantAId = "";
  let branchA = "";
  let branchB = "";
  let fx: Fixtures;

  let orderA1Id = "";
  let orderA2Id = "";

  const key = () => randomUUID();

  async function login(email: string): Promise<string> {
    const res = await request(http)
      .post("/auth/login")
      .send({ email, password: "Test-12345" })
      .expect(200);
    return res.body.tokens.accessToken;
  }

  async function newOrder(
    branchId: string,
    items: Array<Record<string, unknown>>,
    customerPhone?: string,
  ): Promise<{ id: string; total: string }> {
    const res = await request(http)
      .post("/orders")
      .set("Authorization", `Bearer ${ownerA}`)
      .set("Idempotency-Key", key())
      .send({ type: "walkin", branchId, confirm: true, items, ...(customerPhone ? { customerPhone } : {}) })
      .expect(201);
    return res.body;
  }

  async function payInFull(orderId: string, amount: string) {
    await request(http)
      .post(`/orders/${orderId}/payments`)
      .set("Authorization", `Bearer ${ownerA}`)
      .set("Idempotency-Key", key())
      .send({ method: "cash", amount })
      .expect(201);
  }

  beforeAll(async () => {
    admin = createAdminClient();
    await truncateAll(admin);
    await syncPermissionCatalog(admin);

    const tenantA = await provisionTestTenant(admin, {
      name: "مطعم مقارنة الفروع",
      slug: "branchcmp-a",
      ownerEmail: "owner@branchcmp-a.test",
    });
    tenantAId = tenantA.tenantId;
    branchA = tenantA.branchId!;
    fx = await createOrderingFixtures(admin, tenantAId, branchA);

    const branchBRow = await admin.branch.create({
      data: { tenantId: tenantAId, name: "فرع كورنيش", nameEn: "Corniche Branch", slug: "branch-corniche" },
    });
    branchB = branchBRow.id;

    const tenantC = await provisionTestTenant(admin, {
      name: "مطعم آخر",
      slug: "branchcmp-c",
      ownerEmail: "owner@branchcmp-c.test",
    });
    void tenantC;

    const { hashPassword } = await import("../../src/modules/identity/password");
    const cashier = await admin.user.create({
      data: {
        email: "cashier@branchcmp-a.test",
        name: "Cashier",
        passwordHash: await hashPassword("Test-12345"),
        emailVerifiedAt: new Date(),
      },
    });
    await admin.userRole.create({
      data: { tenantId: tenantAId, userId: cashier.id, roleId: tenantA.roleIdsByKey.cashier, branchId: branchA },
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    http = app.getHttpServer();

    ownerA = await login("owner@branchcmp-a.test");
    ownerC = await login("owner@branchcmp-c.test");
    cashierA = await login("cashier@branchcmp-a.test");

    await request(http)
      .post("/shifts/open")
      .set("Authorization", `Bearer ${ownerA}`)
      .send({ branchId: branchA, openingCash: "0" })
      .expect(201);
    await request(http)
      .post("/shifts/open")
      .set("Authorization", `Bearer ${ownerA}`)
      .send({ branchId: branchB, openingCash: "0" })
      .expect(201);

    // Tenant-wide points-per-riyal loyalty: 1 point/SAR, 10 points -> 1.00 SAR off.
    await request(http)
      .put("/loyalty/configs/points_per_riyal")
      .set("Authorization", `Bearer ${ownerA}`)
      .send({ isEnabled: true, config: { pointsPerRiyal: 1, redemptionPointsUnit: 10, redemptionSarValue: "1" } })
      .expect(200);

    const phone = "+966500000077";

    // Branch A: 3 plain sales (12 + 12 + 35), one of them carrying the phone
    // that will accumulate the points redeemed on order A4 below.
    const orderA1 = await newOrder(branchA, [{ productId: fx.simple.id, quantity: 1 }], phone);
    orderA1Id = orderA1.id;
    await payInFull(orderA1.id, orderA1.total);

    const orderA2 = await newOrder(branchA, [{ productId: fx.simple.id, quantity: 1 }]);
    orderA2Id = orderA2.id;
    await payInFull(orderA2.id, orderA2.total);

    const orderA3 = await newOrder(branchA, [{ productId: fx.withSize.id, quantity: 1, modifierIds: [fx.large.id] }]);
    await payInFull(orderA3.id, orderA3.total);

    await waitUntil(async () => {
      const customer = await admin.loyaltyCustomer.findUnique({
        where: { tenantId_phone: { tenantId: tenantAId, phone } },
      });
      return customer?.pointsBalance === 12 ? customer : null;
    });

    // Order A4: giving the phone at creation triggers the automatic
    // (order.created) redemption path — 10 of the 12 accumulated points
    // become a 1.00 SAR discount (12.00 -> 11.00), applied asynchronously.
    const orderA4 = await newOrder(branchA, [{ productId: fx.simple.id, quantity: 1 }], phone);
    const orderA4Updated = await waitUntil(async () => {
      const o = await admin.order.findUniqueOrThrow({ where: { id: orderA4.id } });
      return o.discount.toString() !== "0" ? o : null;
    });
    expect(orderA4Updated.total.toString()).toBe("11");
    await payInFull(orderA4.id, orderA4Updated.total.toString());

    // Branch B: one sale, no loyalty use -> tests "enabled but 0%", not "unavailable".
    const orderB1 = await newOrder(branchB, [{ productId: fx.simple.id, quantity: 2 }]);
    await payInFull(orderB1.id, orderB1.total);

    // Ratings: only branch A has any, to test the ratingsAvailable/absent split.
    // Completing a paid order auto-schedules a feedback request row, so the
    // row already exists here — rate it rather than creating a duplicate.
    await admin.orderFeedbackRequest.update({
      where: { orderId: orderA1Id },
      data: { rating: 4, ratedAt: new Date() },
    });
    await admin.orderFeedbackRequest.update({
      where: { orderId: orderA2Id },
      data: { rating: 5, ratedAt: new Date() },
    });
  });

  afterAll(async () => {
    await app.close();
    await admin.$disconnect();
  });

  it("denies reports.view to roles without it", async () => {
    await request(http)
      .get("/reports/branch-comparison")
      .set("Authorization", `Bearer ${cashierA}`)
      .expect(403);
  });

  it("computes sales, top products, loyalty usage and ratings per branch", async () => {
    const res = await request(http)
      .get("/reports/branch-comparison")
      .set("Authorization", `Bearer ${ownerA}`)
      .expect(200);

    expect(res.body.loyaltyAvailable).toBe(true);
    expect(res.body.ratingsAvailable).toBe(true);
    expect(res.body.rows).toHaveLength(2);

    const rowA = res.body.rows.find((r: { branchId: string }) => r.branchId === branchA);
    const rowB = res.body.rows.find((r: { branchId: string }) => r.branchId === branchB);

    // 12.00 + 12.00 + 35.00 + 11.00 = 70.00, avg 70.00/4 = 17.50.
    expect(rowA.orderCount).toBe(4);
    expect(rowA.totalSales).toBe("70.00");
    expect(rowA.avgOrderValue).toBe("17.50");
    expect(rowA.topProducts[0].productId).toBe(fx.simple.id);
    expect(rowA.topProducts[0].quantitySold).toBe(3); // A1 + A2 + A4
    expect(rowA.topProducts[1].productId).toBe(fx.withSize.id);
    expect(rowA.topProducts[1].quantitySold).toBe(1);

    // 1 of branch A's 4 orders (A4) redeemed loyalty -> 25%.
    expect(rowA.loyalty.enabled).toBe(true);
    expect(rowA.loyalty.ordersWithLoyalty).toBe(1);
    expect(rowA.loyalty.usagePercent).toBe(25);

    expect(rowA.ratings.count).toBe(2);
    expect(rowA.ratings.avgRating).toBe(4.5);

    // 2x 12.00 = 24.00.
    expect(rowB.orderCount).toBe(1);
    expect(rowB.totalSales).toBe("24.00");
    expect(rowB.avgOrderValue).toBe("24.00");
    expect(rowB.topProducts[0].quantitySold).toBe(2);

    // Loyalty is enabled tenant-wide but never redeemed at branch B: 0%, not "unavailable".
    expect(rowB.loyalty.enabled).toBe(true);
    expect(rowB.loyalty.ordersWithLoyalty).toBe(0);
    expect(rowB.loyalty.usagePercent).toBe(0);

    expect(rowB.ratings.count).toBe(0);
    expect(rowB.ratings.avgRating).toBeNull();
  });

  it("branchIds filter narrows the comparison to just the requested branches", async () => {
    const res = await request(http)
      .get(`/reports/branch-comparison?branchIds=${branchB}`)
      .set("Authorization", `Bearer ${ownerA}`)
      .expect(200);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].branchId).toBe(branchB);
  });

  it("an unrelated tenant sees no branches, never tenant A's figures", async () => {
    const res = await request(http)
      .get("/reports/branch-comparison")
      .set("Authorization", `Bearer ${ownerC}`)
      .expect(200);
    expect(res.body.rows).toHaveLength(1); // tenant C's own single default branch
    expect(res.body.rows[0].orderCount).toBe(0);
  });
});
