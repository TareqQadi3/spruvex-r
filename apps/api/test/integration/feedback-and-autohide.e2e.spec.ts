import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import request from "supertest";

import { AppModule } from "../../src/app.module";
import { syncPermissionCatalog } from "../../src/modules/tenancy/tenant-provisioning";
import { createOrderingFixtures } from "../helpers/catalog-fixtures";
import { createAdminClient, truncateAll } from "../helpers/db";
import { setupUnits } from "../helpers/inventory-fixtures";
import { provisionTestTenant } from "../helpers/provision";

type Fixtures = Awaited<ReturnType<typeof createOrderingFixtures>>;
type Units = Awaited<ReturnType<typeof setupUnits>>;

/** Polls until `check` returns a truthy value or the timeout elapses. */
async function waitUntil<T>(check: () => Promise<T | null | undefined>, timeoutMs = 4000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() > deadline) {
      throw new Error("waitUntil: condition not met before timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("post-order feedback & critical-stock auto-hide (e2e)", () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let http: ReturnType<INestApplication["getHttpServer"]>;

  let ownerToken = "";
  let cashierToken = "";
  let tenantId = "";
  let branchId = "";
  let fx: Fixtures;
  let units: Units;
  let ingredientId = "";

  const key = () => randomUUID();

  async function login(email: string): Promise<string> {
    const res = await request(http)
      .post("/auth/login")
      .send({ email, password: "Test-12345" })
      .expect(200);
    return res.body.tokens.accessToken;
  }

  async function placeAndCompleteOrder(quantity: number) {
    const order = await request(http)
      .post("/orders")
      .set("Authorization", `Bearer ${cashierToken}`)
      .set("Idempotency-Key", key())
      .send({
        type: "walkin",
        branchId,
        confirm: true,
        items: [{ productId: fx.simple.id, quantity }],
      })
      .expect(201);

    await request(http)
      .post(`/orders/${order.body.id}/payments`)
      .set("Authorization", `Bearer ${cashierToken}`)
      .set("Idempotency-Key", key())
      .send({ method: "cash", amount: order.body.total })
      .expect(201);

    return order.body;
  }

  beforeAll(async () => {
    admin = createAdminClient();
    await truncateAll(admin);
    await syncPermissionCatalog(admin);
    units = await setupUnits(admin);

    const tenant = await provisionTestTenant(admin, {
      name: "مطعم الاختبار",
      slug: "feedback-autohide-test",
      ownerEmail: "owner@feedback-autohide-test.test",
    });
    tenantId = tenant.tenantId;
    branchId = tenant.branchId!;

    const { hashPassword } = await import("../../src/modules/identity/password");
    const cashier = await admin.user.create({
      data: {
        email: "cashier@feedback-autohide-test.test",
        name: "Cashier",
        passwordHash: await hashPassword("Test-12345"),
        emailVerifiedAt: new Date(),
      },
    });
    await admin.userRole.create({
      data: {
        tenantId,
        userId: cashier.id,
        roleId: tenant.roleIdsByKey.cashier,
        branchId,
      },
    });

    fx = await createOrderingFixtures(admin, tenantId, branchId);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    http = app.getHttpServer();

    ownerToken = await login("owner@feedback-autohide-test.test");
    cashierToken = await login("cashier@feedback-autohide-test.test");

    await request(http)
      .post("/shifts/open")
      .set("Authorization", `Bearer ${cashierToken}`)
      .send({ branchId, openingCash: "0" })
      .expect(201);

    const ingredient = await request(http)
      .post("/inventory/ingredients")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "طماطم", nameEn: "Tomato", unitType: "mass" })
      .expect(201);
    ingredientId = ingredient.body.id;

    // fx.simple ("عصير") consumes 200g of tomato per unit, marked critical
    // (hide the product the instant this branch's tomato stock hits 0).
    await request(http)
      .put(`/products/${fx.simple.id}/recipe`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ items: [{ ingredientId, unitId: units.gram.id, quantity: "200", isCritical: true }] })
      .expect(200);
  });

  afterAll(async () => {
    await app.close();
    await admin.$disconnect();
  });

  describe("critical-ingredient auto-hide (86'd item)", () => {
    it("hides the product the moment its critical ingredient hits zero stock", async () => {
      // Stock exactly one order's worth (200g) — completing it drains the ingredient to 0.
      await request(http)
        .post("/inventory/stock/purchase")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId, ingredientId, quantity: "200", unitCost: "0.02" })
        .expect(201);

      await placeAndCompleteOrder(1);

      const hide = await waitUntil(() =>
        admin.productStockHide.findFirst({ where: { productId: fx.simple.id, branchId } }),
      );
      expect(hide.ingredientId).toBe(ingredientId);

      const setting = await admin.productBranchSetting.findUniqueOrThrow({
        where: { productId_branchId: { productId: fx.simple.id, branchId } },
      });
      expect(setting.isAvailable).toBe(false);

      const audit = await admin.auditLog.findFirst({
        where: { action: "product.auto_hidden_stockout", entityId: fx.simple.id },
      });
      expect(audit).not.toBeNull();
    });

    it("excludes the hidden product from the public digital menu and blocks new orders for it", async () => {
      const menu = await request(http).get(`/public/tables/${fx.table.qrToken}/menu`).expect(200);
      const ids = menu.body.products.map((p: { id: string }) => p.id);
      expect(ids).not.toContain(fx.simple.id);

      await request(http)
        .post("/orders")
        .set("Authorization", `Bearer ${cashierToken}`)
        .set("Idempotency-Key", key())
        .send({ type: "walkin", branchId, confirm: true, items: [{ productId: fx.simple.id, quantity: 1 }] })
        .expect(409);
    });

    it("shows the product again once the ingredient is restocked, and releases the hide row", async () => {
      await request(http)
        .post("/inventory/stock/purchase")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId, ingredientId, quantity: "200", unitCost: "0.02" })
        .expect(201);

      await waitUntil(async () => {
        const setting = await admin.productBranchSetting.findUnique({
          where: { productId_branchId: { productId: fx.simple.id, branchId } },
        });
        return setting?.isAvailable ? setting : null;
      });

      const hide = await admin.productStockHide.findFirst({ where: { productId: fx.simple.id, branchId } });
      expect(hide).toBeNull();

      const audit = await admin.auditLog.findFirst({
        where: { action: "product.auto_shown_restocked", entityId: fx.simple.id },
      });
      expect(audit).not.toBeNull();
    });

    it("a merchant's manual re-enable always wins, even while still out of stock", async () => {
      // Drain the ingredient back to 0 — the system hides it again.
      await placeAndCompleteOrder(1);
      await waitUntil(() =>
        admin.productStockHide.findFirst({ where: { productId: fx.simple.id, branchId } }),
      );

      await request(http)
        .put(`/catalog/products/${fx.simple.id}/branch-settings/${branchId}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ isAvailable: true })
        .expect(200);

      const hide = await admin.productStockHide.findFirst({ where: { productId: fx.simple.id, branchId } });
      expect(hide).toBeNull();
      const setting = await admin.productBranchSetting.findUniqueOrThrow({
        where: { productId_branchId: { productId: fx.simple.id, branchId } },
      });
      expect(setting.isAvailable).toBe(true);
    });
  });

  describe("post-order WhatsApp feedback request", () => {
    let feedbackId = "";
    let orderId = "";

    beforeAll(async () => {
      // Restock so this order actually succeeds (previous describe block drained it to 0 again).
      await request(http)
        .post("/inventory/stock/purchase")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId, ingredientId, quantity: "200", unitCost: "0.02" })
        .expect(201);

      const order = await placeAndCompleteOrder(1);
      orderId = order.id;

      const request_ = await waitUntil(() =>
        admin.orderFeedbackRequest.findUnique({ where: { orderId } }),
      );
      feedbackId = request_.id;
    });

    it("creates exactly one feedback request per completed order, not yet sent", async () => {
      const row = await admin.orderFeedbackRequest.findUniqueOrThrow({ where: { orderId } });
      expect(row.sentAt).toBeNull();
      expect(row.rating).toBeNull();
      expect(row.sendAfter.getTime()).toBeGreaterThan(Date.now());
    });

    it("public GET returns the restaurant/order context, not yet rated", async () => {
      const res = await request(http).get(`/public/feedback/${feedbackId}`).expect(200);
      expect(res.body.alreadyRated).toBe(false);
      expect(res.body.restaurant.name).toBe("مطعم الاختبار");
    });

    it("404s for an unknown feedback id", async () => {
      await request(http).get(`/public/feedback/${randomUUID()}`).expect(404);
    });

    it("accepts a 1-5 rating with an optional comment", async () => {
      await request(http)
        .post(`/public/feedback/${feedbackId}`)
        .send({ rating: 2, comment: "الطلب تأخر كثيرًا" })
        .expect(201);

      const row = await admin.orderFeedbackRequest.findUniqueOrThrow({ where: { id: feedbackId } });
      expect(row.rating).toBe(2);
      expect(row.comment).toBe("الطلب تأخر كثيرًا");
      expect(row.ratedAt).not.toBeNull();
    });

    it("rejects answering the same feedback request twice", async () => {
      await request(http).post(`/public/feedback/${feedbackId}`).send({ rating: 4 }).expect(409);
    });

    it("rejects an out-of-range rating on a fresh (unanswered) request", async () => {
      // A second completed order creates a fresh, still-unanswered request —
      // proves the 400 is genuine DTO validation, not just always-409 reuse
      // of the already-answered one above. Restock first: the earlier
      // describe block's last order drained the critical ingredient again.
      await request(http)
        .post("/inventory/stock/purchase")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId, ingredientId, quantity: "200", unitCost: "0.02" })
        .expect(201);

      const order = await placeAndCompleteOrder(1);
      const fresh = await waitUntil(() => admin.orderFeedbackRequest.findUnique({ where: { orderId: order.id } }));
      await request(http).post(`/public/feedback/${fresh.id}`).send({ rating: 6 }).expect(400);
    });

    it("surfaces the low rating in the ratings report", async () => {
      const res = await request(http)
        .get(`/reports/ratings?branchId=${branchId}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .expect(200);
      expect(res.body.count).toBeGreaterThanOrEqual(1);
      const match = res.body.lowRatings.find((row: { id: string }) => row.id === feedbackId);
      expect(match).toBeDefined();
      expect(match.rating).toBe(2);
    });
  });

  describe("feedback settings — tenant-configurable send delay", () => {
    it("cashier (no tenant.settings.manage) is forbidden", async () => {
      await request(http).get("/feedback/settings").set("Authorization", `Bearer ${cashierToken}`).expect(403);
    });

    it("defaults to 30 minutes before any owner has touched it", async () => {
      const res = await request(http)
        .get("/feedback/settings")
        .set("Authorization", `Bearer ${ownerToken}`)
        .expect(200);
      expect(res.body).toEqual({ feedbackDelayMinutes: 30 });
    });

    it("rejects an out-of-bounds delay", async () => {
      await request(http)
        .patch("/feedback/settings")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ feedbackDelayMinutes: 0 })
        .expect(400);
      await request(http)
        .patch("/feedback/settings")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ feedbackDelayMinutes: 5000 })
        .expect(400);
    });

    it("persists a valid delay and every new completed order's request uses it", async () => {
      const updated = await request(http)
        .patch("/feedback/settings")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ feedbackDelayMinutes: 2 })
        .expect(200);
      expect(updated.body).toEqual({ feedbackDelayMinutes: 2 });

      await request(http)
        .post("/inventory/stock/purchase")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ branchId, ingredientId, quantity: "200", unitCost: "0.02" })
        .expect(201);

      const before = Date.now();
      const order = await placeAndCompleteOrder(1);
      const row = await waitUntil(() => admin.orderFeedbackRequest.findUnique({ where: { orderId: order.id } }));

      const delayMs = row.sendAfter.getTime() - before;
      // Configured to 2 minutes, not the old hardcoded 30 — generous window
      // for test-run jitter, but nowhere near the old default.
      expect(delayMs).toBeGreaterThan(1.5 * 60 * 1000);
      expect(delayMs).toBeLessThan(10 * 60 * 1000);
    });
  });
});
