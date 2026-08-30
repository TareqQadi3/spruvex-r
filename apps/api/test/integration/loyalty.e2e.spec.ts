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

describe("loyalty program (e2e)", () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let http: ReturnType<INestApplication["getHttpServer"]>;

  let ownerToken = "";
  let cashierToken = "";
  let waiterToken = "";
  let tenantId = "";
  let branchId = "";
  let fx: Fixtures;

  const key = () => randomUUID();

  async function login(email: string): Promise<string> {
    const res = await request(http)
      .post("/auth/login")
      .send({ email, password: "Test-12345" })
      .expect(200);
    return res.body.tokens.accessToken;
  }

  async function createOrder(phone: string | undefined, quantity: number, confirm = true) {
    const res = await request(http)
      .post("/orders")
      .set("Authorization", `Bearer ${cashierToken}`)
      .set("Idempotency-Key", key())
      .send({
        type: "walkin",
        branchId,
        confirm,
        items: [{ productId: fx.simple.id, quantity }],
        ...(phone ? { customerPhone: phone } : {}),
      })
      .expect(201);
    return res.body;
  }

  async function payInFull(orderId: string, amount: string) {
    await request(http)
      .post(`/orders/${orderId}/payments`)
      .set("Authorization", `Bearer ${cashierToken}`)
      .set("Idempotency-Key", key())
      .send({ method: "cash", amount })
      .expect(201);
  }

  async function setConfig(type: string, body: { isEnabled: boolean; config: Record<string, unknown> }) {
    await request(http)
      .put(`/loyalty/configs/${type}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send(body)
      .expect(200);
  }

  beforeAll(async () => {
    admin = createAdminClient();
    await truncateAll(admin);
    await syncPermissionCatalog(admin);

    const tenant = await provisionTestTenant(admin, {
      name: "مطعم الولاء",
      slug: "loyalty-test",
      ownerEmail: "owner@loyalty-test.test",
    });
    tenantId = tenant.tenantId;
    branchId = tenant.branchId!;

    const { hashPassword } = await import("../../src/modules/identity/password");
    const cashier = await admin.user.create({
      data: {
        email: "cashier@loyalty-test.test",
        name: "Cashier",
        passwordHash: await hashPassword("Test-12345"),
        emailVerifiedAt: new Date(),
      },
    });
    await admin.userRole.create({
      data: { tenantId, userId: cashier.id, roleId: tenant.roleIdsByKey.cashier, branchId },
    });
    const waiter = await admin.user.create({
      data: {
        email: "waiter@loyalty-test.test",
        name: "Waiter",
        passwordHash: await hashPassword("Test-12345"),
        emailVerifiedAt: new Date(),
      },
    });
    await admin.userRole.create({
      data: { tenantId, userId: waiter.id, roleId: tenant.roleIdsByKey.waiter, branchId },
    });

    fx = await createOrderingFixtures(admin, tenantId, branchId);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    http = app.getHttpServer();

    ownerToken = await login("owner@loyalty-test.test");
    cashierToken = await login("cashier@loyalty-test.test");
    waiterToken = await login("waiter@loyalty-test.test");

    await request(http)
      .post("/shifts/open")
      .set("Authorization", `Bearer ${cashierToken}`)
      .send({ branchId, openingCash: "0" })
      .expect(201);
    // Refunds require an open shift belonging to whoever issues them — the
    // owner does the refund test below, so the owner needs their own shift.
    await request(http)
      .post("/shifts/open")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ branchId, openingCash: "0" })
      .expect(201);
  });

  afterAll(async () => {
    await app.close();
    await admin.$disconnect();
  });

  describe("config CRUD", () => {
    it("creates a tenant-wide stamp_card config and lists it back", async () => {
      await setConfig("stamp_card", {
        isEnabled: false,
        config: { stampsRequired: 2, earnProductId: fx.simple.id, rewardProductId: fx.simple.id },
      });
      const res = await request(http)
        .get("/loyalty/configs")
        .set("Authorization", `Bearer ${ownerToken}`)
        .expect(200);
      const row = res.body.find((r: { type: string }) => r.type === "stamp_card");
      expect(row.isEnabled).toBe(false);
      expect(row.config.stampsRequired).toBe(2);
    });

    it("rejects an invalid config shape", async () => {
      await request(http)
        .put("/loyalty/configs/spend_threshold")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ isEnabled: true, config: { thresholdAmount: "-5", discountPercent: "10", resetPeriod: "none", carryOver: false } })
        .expect(400);
    });

    it("rejects an unknown program type", async () => {
      await request(http)
        .put("/loyalty/configs/not_a_real_type")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ isEnabled: true, config: {} })
        .expect(400);
    });

    it("shows the effective config for a branch, defaulting to the tenant-wide row", async () => {
      const res = await request(http)
        .get(`/loyalty/configs?branchId=${branchId}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .expect(200);
      const row = res.body.find((r: { type: string }) => r.type === "stamp_card");
      expect(row.isOverride).toBe(false);
    });

    it("waiter cannot manage loyalty configs", async () => {
      await request(http)
        .get("/loyalty/configs")
        .set("Authorization", `Bearer ${waiterToken}`)
        .expect(403);
    });
  });

  describe("stamp card: earn, auto-redeem on the next order, and reversal on cancel", () => {
    const phone = "+966500000010";

    beforeAll(async () => {
      await setConfig("stamp_card", {
        isEnabled: true,
        config: { stampsRequired: 2, earnProductId: fx.simple.id, rewardProductId: fx.simple.id },
      });
    });

    it("earns one stamp per matching unit sold on completion", async () => {
      const order = await createOrder(phone, 1);
      await payInFull(order.id, order.total);
      await waitUntil(async () => {
        const customer = await admin.loyaltyCustomer.findUnique({ where: { tenantId_phone: { tenantId, phone } } });
        return customer?.stampCount === 1 ? customer : null;
      });
    });

    it("reaches the stamp target on a second sale, then auto-redeems a free item on the NEXT order", async () => {
      const order2 = await createOrder(phone, 1);
      await payInFull(order2.id, order2.total);
      await waitUntil(async () => {
        const customer = await admin.loyaltyCustomer.findUnique({ where: { tenantId_phone: { tenantId, phone } } });
        return customer?.stampCount === 2 ? customer : null;
      });

      const order3 = await createOrder(phone, 1, true);
      const items = await waitUntil(async () => {
        const rows = await admin.orderItem.findMany({ where: { orderId: order3.id } });
        return rows.length === 2 ? rows : null;
      });
      const freeItem = items.find((i) => i.unitPrice.toString() === "0");
      expect(freeItem).toBeDefined();
      expect(freeItem?.productId).toBe(fx.simple.id);

      const customer = await admin.loyaltyCustomer.findUniqueOrThrow({
        where: { tenantId_phone: { tenantId, phone } },
      });
      expect(customer.stampCount).toBe(0);

      // Cancelling the (still-unpaid) order reverses the redemption — the
      // stamps consumed for it come back.
      await request(http)
        .post(`/orders/${order3.id}/status`)
        .set("Authorization", `Bearer ${ownerToken}`) // cancelling needs orders.void — cashier doesn't have it
        .send({ status: "cancelled", reason: "test" })
        .expect(200);

      await waitUntil(async () => {
        const restored = await admin.loyaltyCustomer.findUnique({ where: { tenantId_phone: { tenantId, phone } } });
        return restored?.stampCount === 2 ? restored : null;
      });
    });
  });

  describe("spend threshold: earn, auto-redeem, then full-refund reversal", () => {
    const phone = "+966500000020";

    beforeAll(async () => {
      await setConfig("stamp_card", { isEnabled: false, config: { stampsRequired: 2, rewardProductId: fx.simple.id, earnProductId: fx.simple.id } });
      await setConfig("spend_threshold", {
        isEnabled: true,
        config: { thresholdAmount: "20", discountPercent: "10", resetPeriod: "none", carryOver: false },
      });
    });

    it("accumulates spend across two sales, then auto-discounts the next order and earns on it too", async () => {
      const order1 = await createOrder(phone, 1);
      await payInFull(order1.id, order1.total);
      const order2 = await createOrder(phone, 1);
      await payInFull(order2.id, order2.total);

      await waitUntil(async () => {
        const customer = await admin.loyaltyCustomer.findUnique({ where: { tenantId_phone: { tenantId, phone } } });
        return Number(customer?.spendAccumulated) === 24 ? customer : null;
      });

      // order3: subtotal 12.00, auto 10% discount -> 1.20 off -> total 10.80.
      const order3 = await createOrder(phone, 1, true);
      const updated = await waitUntil(async () => {
        const o = await admin.order.findUniqueOrThrow({ where: { id: order3.id } });
        return o.discount.toString() !== "0" ? o : null;
      });
      expect(updated.discount.toString()).toBe("1.2");
      expect(updated.total.toString()).toBe("10.8");

      // The order's discount and the customer's counter/ledger update are two
      // separate sequential writes inside the same auto-apply call — wait
      // for the second one specifically rather than assuming it's already
      // landed just because the first (the order's discount) is visible.
      await waitUntil(async () => {
        const customer = await admin.loyaltyCustomer.findUnique({ where: { tenantId_phone: { tenantId, phone } } });
        return customer?.spendAccumulated.toString() === "0" ? customer : null;
      });

      // Pay and complete order3 — it earns spend on its OWN (discounted) total.
      await payInFull(order3.id, updated.total.toString());
      await waitUntil(async () => {
        const customer = await admin.loyaltyCustomer.findUnique({ where: { tenantId_phone: { tenantId, phone } } });
        return Number(customer?.spendAccumulated) === 10.8 ? customer : null;
      });

      // A refund needs an issued receipt — the same lazy getOrCreate() every receipt goes through.
      await request(http)
        .get(`/orders/${order3.id}/receipt`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .expect(200);

      // Full refund reverses BOTH the redemption (-24) and the completion-time earn (+10.80) tied to order3,
      // restoring the pre-order3 balance of 24.
      await request(http)
        .post(`/orders/${order3.id}/refund`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ amount: updated.total.toString(), method: "cash", reason: "test refund" })
        .expect(201);

      await waitUntil(async () => {
        const restored = await admin.loyaltyCustomer.findUnique({ where: { tenantId_phone: { tenantId, phone } } });
        return Number(restored?.spendAccumulated) === 24 ? restored : null;
      });
    });
  });

  describe("points per riyal: earn, and manual redemption at checkout", () => {
    const phone = "+966500000030";

    beforeAll(async () => {
      await setConfig("spend_threshold", { isEnabled: false, config: { thresholdAmount: "20", discountPercent: "10", resetPeriod: "none", carryOver: false } });
      await setConfig("points_per_riyal", {
        isEnabled: true,
        config: { pointsPerRiyal: 1, redemptionPointsUnit: 10, redemptionSarValue: "1" },
      });
    });

    it("earns points on completion", async () => {
      const order = await createOrder(phone, 1);
      await payInFull(order.id, order.total);
      await waitUntil(async () => {
        const customer = await admin.loyaltyCustomer.findUnique({ where: { tenantId_phone: { tenantId, phone } } });
        return customer?.pointsBalance === 12 ? customer : null;
      });
    });

    it("cashier manually redeems points at checkout on an open order", async () => {
      // No phone at creation — the automatic (order.created) redemption path
      // never fires for it, so the only way this reward gets applied is the
      // cashier's manual action below.
      const order = await createOrder(undefined, 1, true);
      await request(http)
        .put(`/orders/${order.id}/customer`)
        .set("Authorization", `Bearer ${cashierToken}`)
        .send({ customerPhone: phone })
        .expect(200);

      const res = await request(http)
        .post(`/loyalty/orders/${order.id}/redeem`)
        .set("Authorization", `Bearer ${cashierToken}`)
        .send({ type: "points_per_riyal" })
        .expect(200);
      expect(res.body.applied).toBe(true);

      const updated = await admin.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(updated.discount.toString()).toBe("1");
      expect(updated.total.toString()).toBe("11");

      const customer = await admin.loyaltyCustomer.findUniqueOrThrow({
        where: { tenantId_phone: { tenantId, phone } },
      });
      expect(customer.pointsBalance).toBe(2);
    });

    it("rejects manual redemption when the balance isn't enough", async () => {
      const order = await createOrder(phone, 1, true);
      await request(http)
        .post(`/loyalty/orders/${order.id}/redeem`)
        .set("Authorization", `Bearer ${cashierToken}`)
        .send({ type: "points_per_riyal" })
        .expect(409);
    });

    it("waiter cannot redeem (lacks loyalty.redeem)", async () => {
      const order = await createOrder(phone, 1, true);
      await request(http)
        .post(`/loyalty/orders/${order.id}/redeem`)
        .set("Authorization", `Bearer ${waiterToken}`)
        .send({ type: "points_per_riyal" })
        .expect(403);
    });
  });

  describe("membership tiers: standing discount recomputed on every order", () => {
    const phone = "+966500000040";

    beforeAll(async () => {
      await setConfig("points_per_riyal", { isEnabled: false, config: { pointsPerRiyal: 1, redemptionPointsUnit: 10, redemptionSarValue: "1" } });
      await setConfig("tier", {
        isEnabled: true,
        config: {
          tiers: [
            { key: "silver", nameAr: "فضي", minSpend: "0", discountPercent: "0" },
            { key: "gold", nameAr: "ذهبي", minSpend: "20", discountPercent: "5" },
          ],
        },
      });
    });

    it("promotes the customer to gold after crossing lifetime spend, then applies the standing discount automatically", async () => {
      const order1 = await createOrder(phone, 1);
      await payInFull(order1.id, order1.total);
      const order2 = await createOrder(phone, 1);
      await payInFull(order2.id, order2.total);

      const customer = await waitUntil(async () => {
        const c = await admin.loyaltyCustomer.findUnique({ where: { tenantId_phone: { tenantId, phone } } });
        return c?.tierKey === "gold" ? c : null;
      });

      const tierChange = await admin.loyaltyLedgerEntry.findFirst({
        where: { customerId: customer.id, type: "tier_changed", meta: { path: ["tierTo"], equals: "gold" } },
      });
      expect(tierChange).not.toBeNull();

      // order3: subtotal 12.00, gold's standing 5% discount -> 0.60 off -> total 11.40.
      const order3 = await createOrder(phone, 1, true);
      const updated = await waitUntil(async () => {
        const o = await admin.order.findUniqueOrThrow({ where: { id: order3.id } });
        return o.discount.toString() !== "0" ? o : null;
      });
      expect(updated.discount.toString()).toBe("0.6");
      expect(updated.total.toString()).toBe("11.4");
    });
  });

  describe("POS: attaching a customer to a walk-in order", () => {
    it("lets the cashier attach a phone number to an already-created order", async () => {
      const order = await createOrder(undefined, 1, false);
      const res = await request(http)
        .put(`/orders/${order.id}/customer`)
        .set("Authorization", `Bearer ${cashierToken}`)
        .send({ customerPhone: "+966500000099", customerName: "زبون" })
        .expect(200);
      expect(res.body.customerPhone).toBe("+966500000099");
    });
  });
});
