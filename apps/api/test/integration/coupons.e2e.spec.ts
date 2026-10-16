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

/**
 * Discount coupon codes at first-party digital checkout (takeaway/
 * delivery): dashboard CRUD (owner-only), the guest-facing preview
 * endpoint, and real server-side redemption at order creation — min order,
 * channel restriction, expiry/inactive, and both redemption caps (total
 * and per-customer), all enforced against the API directly.
 */
describe("coupons (e2e)", () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let http: ReturnType<INestApplication["getHttpServer"]>;

  let ownerToken = "";
  let cashierToken = "";
  let branchId = "";
  let fx: Fixtures;

  const key = () => randomUUID();

  async function login(email: string): Promise<string> {
    const res = await request(http).post("/auth/login").send({ email, password: "Test-12345" }).expect(200);
    return res.body.tokens.accessToken;
  }

  beforeAll(async () => {
    admin = createAdminClient();
    await truncateAll(admin);
    await syncPermissionCatalog(admin);

    const tenant = await provisionTestTenant(admin, {
      name: "مطعم الكوبونات",
      slug: "coupons-a",
      ownerEmail: "owner@coupons-a.test",
    });
    branchId = tenant.branchId!;
    fx = await createOrderingFixtures(admin, tenant.tenantId, branchId);

    const { hashPassword } = await import("../../src/modules/identity/password");
    const cashier = await admin.user.create({
      data: {
        email: "cashier@coupons-a.test",
        name: "Cashier",
        passwordHash: await hashPassword("Test-12345"),
        emailVerifiedAt: new Date(),
      },
    });
    await admin.userRole.create({
      data: { tenantId: tenant.tenantId, userId: cashier.id, roleId: tenant.roleIdsByKey.cashier, branchId },
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    http = app.getHttpServer();

    ownerToken = await login("owner@coupons-a.test");
    cashierToken = await login("cashier@coupons-a.test");

    await request(http)
      .patch(`/branches/${branchId}/delivery-settings`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ deliveryFeeAmount: "10.00", deliveryMinOrderAmount: "0.00", selfServicePaymentMethods: ["cash"] })
      .expect(200);
  });

  afterAll(async () => {
    await app.close();
  });

  describe("dashboard CRUD — owner/manager only", () => {
    it("a cashier cannot create a coupon (lacks marketing.manage_coupons)", async () => {
      await request(http)
        .post("/marketing/coupons")
        .set("Authorization", `Bearer ${cashierToken}`)
        .send({ code: "NOPE10", discountType: "percentage", discountValue: "10" })
        .expect(403);
    });

    it("owner creates, lists and updates a coupon; code is normalized upper-case", async () => {
      const created = await request(http)
        .post("/marketing/coupons")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ code: "welcome10", discountType: "percentage", discountValue: "10" })
        .expect(201);
      expect(created.body.code).toBe("WELCOME10");

      const list = await request(http)
        .get("/marketing/coupons")
        .set("Authorization", `Bearer ${ownerToken}`)
        .expect(200);
      expect(list.body.some((c: { code: string }) => c.code === "WELCOME10")).toBe(true);

      await request(http)
        .patch(`/marketing/coupons/${created.body.id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ isActive: false })
        .expect(200);
    });

    it("rejects a duplicate code for the same tenant", async () => {
      await request(http)
        .post("/marketing/coupons")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ code: "DUPE1", discountType: "fixed", discountValue: "5" })
        .expect(201);
      await request(http)
        .post("/marketing/coupons")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ code: "dupe1", discountType: "fixed", discountValue: "5" })
        .expect(409);
    });
  });

  describe("guest preview endpoint", () => {
    it("returns the computed discount for a valid, usable coupon", async () => {
      await request(http)
        .post("/marketing/coupons")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ code: "PREVIEW20", discountType: "percentage", discountValue: "20", maxDiscountAmount: "15.00" })
        .expect(201);

      const res = await request(http)
        .post("/public/restaurants/coupons-a/branches/main/coupons/validate")
        .send({ code: "preview20", channel: "takeaway", subtotal: "100.00" })
        .expect(201);
      // 20% of 100 = 20, capped at 15.
      expect(res.body).toEqual({ valid: true, discountAmount: "15.00" });
    });

    it("404s on an unknown code", async () => {
      await request(http)
        .post("/public/restaurants/coupons-a/branches/main/coupons/validate")
        .send({ code: "DOES-NOT-EXIST", channel: "takeaway", subtotal: "100.00" })
        .expect(404);
    });
  });

  describe("redemption at order creation — real server-side enforcement", () => {
    it("applies a fixed-amount coupon to a takeaway order and folds it into the total", async () => {
      await request(http)
        .post("/marketing/coupons")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ code: "FIXED5", discountType: "fixed", discountValue: "5.00" })
        .expect(201);

      const res = await request(http)
        .post("/public/restaurants/coupons-a/branches/main/orders")
        .set("Idempotency-Key", key())
        .send({
          items: [{ productId: fx.simple.id, quantity: 1 }],
          customerPhone: "0599999001",
          couponCode: "fixed5",
        })
        .expect(201);
      expect(Number(res.body.discount)).toBeCloseTo(5, 2);
      expect(Number(res.body.total)).toBeCloseTo(12 - 5, 2);

      const order = await admin.order.findUniqueOrThrow({ where: { id: res.body.orderId } });
      expect(order.discountType).toBe("coupon");
      expect(order.couponId).not.toBeNull();
    });

    it("rejects an order whose subtotal is below the coupon's minimum", async () => {
      await request(http)
        .post("/marketing/coupons")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ code: "MIN50", discountType: "fixed", discountValue: "5.00", minOrderAmount: "50.00" })
        .expect(201);

      await request(http)
        .post("/public/restaurants/coupons-a/branches/main/orders")
        .set("Idempotency-Key", key())
        .send({
          items: [{ productId: fx.simple.id, quantity: 1 }],
          customerPhone: "0599999002",
          couponCode: "MIN50",
        })
        .expect(409);
    });

    it("rejects a coupon restricted to a different channel", async () => {
      await request(http)
        .post("/marketing/coupons")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ code: "DELIVERYONLY", discountType: "fixed", discountValue: "5.00", channels: ["delivery"] })
        .expect(201);

      await request(http)
        .post("/public/restaurants/coupons-a/branches/main/orders")
        .set("Idempotency-Key", key())
        .send({
          items: [{ productId: fx.simple.id, quantity: 1 }],
          customerPhone: "0599999003",
          couponCode: "DELIVERYONLY",
        })
        .expect(400);
    });

    it("rejects an expired coupon", async () => {
      await request(http)
        .post("/marketing/coupons")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          code: "EXPIRED1",
          discountType: "fixed",
          discountValue: "5.00",
          endAt: "2020-01-01T00:00:00.000Z",
        })
        .expect(201);

      await request(http)
        .post("/public/restaurants/coupons-a/branches/main/orders")
        .set("Idempotency-Key", key())
        .send({
          items: [{ productId: fx.simple.id, quantity: 1 }],
          customerPhone: "0599999004",
          couponCode: "EXPIRED1",
        })
        .expect(400);
    });

    it("rejects an unknown coupon code", async () => {
      await request(http)
        .post("/public/restaurants/coupons-a/branches/main/orders")
        .set("Idempotency-Key", key())
        .send({
          items: [{ productId: fx.simple.id, quantity: 1 }],
          customerPhone: "0599999005",
          couponCode: "TOTALLY-MADE-UP",
        })
        .expect(404);
    });

    // The remaining two tests use the delivery endpoint instead of the
    // takeaway one above (a separate, still-fresh rate-limit bucket — each
    // guest route is throttled independently per handler, and the takeaway
    // one has already taken several hits in this file).
    it("enforces the total redemption cap across different customers", async () => {
      await request(http)
        .post("/marketing/coupons")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ code: "ONCEONLY", discountType: "fixed", discountValue: "1.00", maxRedemptions: 1 })
        .expect(201);

      await request(http)
        .post("/public/restaurants/coupons-a/branches/main/delivery-orders")
        .set("Idempotency-Key", key())
        .send({
          items: [{ productId: fx.simple.id, quantity: 1 }],
          customerPhone: "0599999006",
          deliveryAddress: "شارع الملك فهد، الرياض",
          couponCode: "ONCEONLY",
        })
        .expect(201);

      await request(http)
        .post("/public/restaurants/coupons-a/branches/main/delivery-orders")
        .set("Idempotency-Key", key())
        .send({
          items: [{ productId: fx.simple.id, quantity: 1 }],
          customerPhone: "0599999007",
          deliveryAddress: "شارع الملك فهد، الرياض",
          couponCode: "ONCEONLY",
        })
        .expect(409);
    });

    it("enforces the per-customer redemption cap", async () => {
      await request(http)
        .post("/marketing/coupons")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ code: "ONEPERCUSTOMER", discountType: "fixed", discountValue: "1.00", maxRedemptionsPerCustomer: 1 })
        .expect(201);

      await request(http)
        .post("/public/restaurants/coupons-a/branches/main/delivery-orders")
        .set("Idempotency-Key", key())
        .send({
          items: [{ productId: fx.simple.id, quantity: 1 }],
          customerPhone: "0599999008",
          deliveryAddress: "شارع الملك فهد، الرياض",
          couponCode: "ONEPERCUSTOMER",
        })
        .expect(201);

      // Same customer, second order — rejected even though the coupon still has global capacity.
      await request(http)
        .post("/public/restaurants/coupons-a/branches/main/delivery-orders")
        .set("Idempotency-Key", key())
        .send({
          items: [{ productId: fx.simple.id, quantity: 1 }],
          customerPhone: "0599999008",
          deliveryAddress: "شارع الملك فهد، الرياض",
          couponCode: "ONEPERCUSTOMER",
        })
        .expect(409);

      // A different customer can still use it.
      await request(http)
        .post("/public/restaurants/coupons-a/branches/main/delivery-orders")
        .set("Idempotency-Key", key())
        .send({
          items: [{ productId: fx.simple.id, quantity: 1 }],
          customerPhone: "0599999009",
          deliveryAddress: "شارع الملك فهد، الرياض",
          couponCode: "ONEPERCUSTOMER",
        })
        .expect(201);
    });
  });
});
