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
 * Business hours, manual channel pause, item/modifier availability
 * (sold-out-today / unavailable / stock-auto), per-channel product
 * visibility/pricing, and the first-party delivery order flow — all
 * verified as REAL server-side enforcement (never a frontend-only check):
 * a request is sent straight at the API with no client involved, and the
 * assertion is the HTTP status/body it comes back with.
 */
describe("menu channels: hours, availability, delivery (e2e)", () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let http: ReturnType<INestApplication["getHttpServer"]>;

  let ownerToken = "";
  let cashierToken = "";
  let tenantId = "";
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
      name: "مطعم القنوات",
      slug: "channels-a",
      ownerEmail: "owner@channels-a.test",
    });
    tenantId = tenant.tenantId;
    branchId = tenant.branchId!;
    fx = await createOrderingFixtures(admin, tenantId, branchId);

    const { hashPassword } = await import("../../src/modules/identity/password");
    const cashier = await admin.user.create({
      data: {
        email: "cashier@channels-a.test",
        name: "Cashier",
        passwordHash: await hashPassword("Test-12345"),
        emailVerifiedAt: new Date(),
      },
    });
    await admin.userRole.create({
      data: { tenantId, userId: cashier.id, roleId: tenant.roleIdsByKey.cashier, branchId },
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    http = app.getHttpServer();

    ownerToken = await login("owner@channels-a.test");
    cashierToken = await login("cashier@channels-a.test");
  });

  afterAll(async () => {
    await app.close();
  });

  async function resetHours() {
    await request(http)
      .patch(`/branches/${branchId}/hours`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ workingHours: {} })
      .expect(200);
  }

  describe("business hours — server-side enforcement", () => {
    afterEach(resetHours);

    it("a branch with no configured hours is always open (backward compatible)", async () => {
      const status = await request(http).get(`/public/tables/${fx.table.qrToken}`).expect(200);
      expect(status.body.channelStatus.open).toBe(true);
      expect(status.body.channelStatus.reason).toBe("always_open_unconfigured");
    });

    it("rejects a table order when the weekly schedule says the branch is closed right now, and accepts it once configured open", async () => {
      // A schedule with every day EXCEPT today closed makes "now" fall outside all ranges.
      await request(http)
        .patch(`/branches/${branchId}/hours`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ workingHours: { schedule: { mon: [{ from: "00:00", to: "00:01" }] } } })
        .expect(200);

      const menu = await request(http).get(`/public/tables/${fx.table.qrToken}/menu`).expect(200);
      expect(Array.isArray(menu.body.products)).toBe(true); // browsing still works while "closed"

      await request(http)
        .post(`/public/tables/${fx.table.qrToken}/orders`)
        .set("Idempotency-Key", key())
        .send({ items: [{ productId: fx.simple.id, quantity: 1 }], customerPhone: "0500000001" })
        .expect(409);

      // Now open it 24/7 and the same order succeeds.
      await request(http)
        .patch(`/branches/${branchId}/hours`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          workingHours: {
            schedule: {
              sun: [{ from: "00:00", to: "23:59" }],
              mon: [{ from: "00:00", to: "23:59" }],
              tue: [{ from: "00:00", to: "23:59" }],
              wed: [{ from: "00:00", to: "23:59" }],
              thu: [{ from: "00:00", to: "23:59" }],
              fri: [{ from: "00:00", to: "23:59" }],
              sat: [{ from: "00:00", to: "23:59" }],
            },
          },
        })
        .expect(200);

      await request(http)
        .post(`/public/tables/${fx.table.qrToken}/orders`)
        .set("Idempotency-Key", key())
        .send({ items: [{ productId: fx.simple.id, quantity: 1 }], customerPhone: "0500000002" })
        .expect(201);
    });

    it("rejects a malformed working-hours payload with 400", async () => {
      await request(http)
        .patch(`/branches/${branchId}/hours`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ workingHours: { schedule: { funday: [{ from: "08:00", to: "23:00" }] } } })
        .expect(400);
    });
  });

  describe("manual channel pause — immediate, independent per channel", () => {
    it("pauses takeaway only, leaving dine-in unaffected, then resumes it", async () => {
      await request(http)
        .post(`/branches/${branchId}/pause`)
        .set("Authorization", `Bearer ${cashierToken}`) // menu.toggle_availability, not branches.manage
        .send({ channel: "takeaway", reason: "المطبخ مشغول" })
        .expect(201);

      await request(http)
        .post(`/public/restaurants/channels-a/branches/main/orders`)
        .set("Idempotency-Key", key())
        .send({ items: [{ productId: fx.simple.id, quantity: 1 }], customerPhone: "0500000003" })
        .expect(409);

      // Dine-in is a completely separate channel — still open.
      await request(http)
        .post(`/public/tables/${fx.table.qrToken}/orders`)
        .set("Idempotency-Key", key())
        .send({ items: [{ productId: fx.simple.id, quantity: 1 }], customerPhone: "0500000004" })
        .expect(201);

      await request(http)
        .post(`/branches/${branchId}/resume/takeaway`)
        .set("Authorization", `Bearer ${cashierToken}`)
        .expect(201);

      await request(http)
        .post(`/public/restaurants/channels-a/branches/main/orders`)
        .set("Idempotency-Key", key())
        .send({ items: [{ productId: fx.simple.id, quantity: 1 }], customerPhone: "0500000005" })
        .expect(201);
    });
  });

  describe("item availability — one flip, reflected everywhere that reads it", () => {
    it("sold-out-today hides the product from the guest menu and blocks ordering it, until re-enabled", async () => {
      await request(http)
        .post(`/catalog/products/${fx.simple.id}/branch-settings/${branchId}/sold-out-today`)
        .set("Authorization", `Bearer ${cashierToken}`) // menu.toggle_availability suffices
        .expect(201);

      const menu = await request(http).get(`/public/tables/${fx.table.qrToken}/menu`).expect(200);
      expect(menu.body.products.find((p: { id: string }) => p.id === fx.simple.id)).toBeUndefined();

      await request(http)
        .post(`/public/tables/${fx.table.qrToken}/orders`)
        .set("Idempotency-Key", key())
        .send({ items: [{ productId: fx.simple.id, quantity: 1 }], customerPhone: "0500000006" })
        .expect(409);

      const branchSetting = await admin.productBranchSetting.findUnique({
        where: { productId_branchId: { productId: fx.simple.id, branchId } },
      });
      expect(branchSetting?.unavailableReason).toBe("sold_out_today");

      await request(http)
        .post(`/catalog/products/${fx.simple.id}/branch-settings/${branchId}/available`)
        .set("Authorization", `Bearer ${cashierToken}`)
        .expect(201);

      const menuAfter = await request(http).get(`/public/tables/${fx.table.qrToken}/menu`).expect(200);
      expect(menuAfter.body.products.find((p: { id: string }) => p.id === fx.simple.id)).toBeDefined();
    });

    it("a cashier CANNOT edit the product itself (menu.manage), only toggle availability", async () => {
      await request(http)
        .patch(`/catalog/products/${fx.simple.id}`)
        .set("Authorization", `Bearer ${cashierToken}`)
        .send({ name: "hacked" })
        .expect(403);
    });

    it("disables a single modifier option per branch without touching the product", async () => {
      await request(http)
        .put(`/catalog/modifiers/${fx.large.id}/branch-settings/${branchId}`)
        .set("Authorization", `Bearer ${cashierToken}`)
        .send({ isAvailable: false })
        .expect(200);

      const menu = await request(http).get(`/public/tables/${fx.table.qrToken}/menu`).expect(200);
      const product = menu.body.products.find((p: { id: string }) => p.id === fx.withSize.id);
      const sizeGroup = product.modifierGroups.find((g: { id: string }) => g.id === fx.sizeGroup.id);
      expect(sizeGroup.modifiers.find((m: { id: string }) => m.id === fx.large.id)).toBeUndefined();
      expect(sizeGroup.modifiers.find((m: { id: string }) => m.id === fx.regular.id)).toBeDefined();

      await request(http)
        .post(`/public/tables/${fx.table.qrToken}/orders`)
        .set("Idempotency-Key", key())
        .send({
          items: [{ productId: fx.withSize.id, quantity: 1, modifierIds: [fx.large.id] }],
          customerPhone: "0500000007",
        })
        .expect(409);

      await request(http)
        .put(`/catalog/modifiers/${fx.large.id}/branch-settings/${branchId}`)
        .set("Authorization", `Bearer ${cashierToken}`)
        .send({ isAvailable: true })
        .expect(200);
    });
  });

  describe("per-channel visibility/pricing overrides", () => {
    it("hides a product from delivery only, and applies a delivery-specific price when visible", async () => {
      await request(http)
        .put(`/catalog/products/${fx.withSize.id}/branch-settings/${branchId}/channel`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ channel: "delivery", isVisible: false })
        .expect(200);

      const deliveryMenu = await request(http)
        .get(`/public/restaurants/channels-a/branches/main/menu?channel=delivery`)
        .expect(200);
      expect(deliveryMenu.body.products.find((p: { id: string }) => p.id === fx.withSize.id)).toBeUndefined();

      const tableMenu = await request(http).get(`/public/tables/${fx.table.qrToken}/menu`).expect(200);
      expect(tableMenu.body.products.find((p: { id: string }) => p.id === fx.withSize.id)).toBeDefined();

      await request(http)
        .put(`/catalog/products/${fx.simple.id}/branch-settings/${branchId}/channel`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ channel: "delivery", isVisible: true, priceOverride: "20.00" })
        .expect(200);

      const priced = await request(http)
        .get(`/public/restaurants/channels-a/branches/main/menu?channel=delivery`)
        .expect(200);
      const juice = priced.body.products.find((p: { id: string }) => p.id === fx.simple.id);
      expect(Number(juice.price)).toBe(20);

      const dineInMenu = await request(http).get(`/public/tables/${fx.table.qrToken}/menu`).expect(200);
      const juiceDineIn = dineInMenu.body.products.find((p: { id: string }) => p.id === fx.simple.id);
      expect(Number(juiceDineIn.price)).toBe(Number(fx.simple.basePrice));

      // Restore both overrides so later describe blocks (which reuse these
      // same fixture products for delivery orders) start from a clean slate.
      await request(http)
        .put(`/catalog/products/${fx.withSize.id}/branch-settings/${branchId}/channel`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ channel: "delivery", isVisible: true })
        .expect(200);
      await request(http)
        .put(`/catalog/products/${fx.simple.id}/branch-settings/${branchId}/channel`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ channel: "delivery", isVisible: true })
        .expect(200);
    });
  });

  describe("first-party delivery ordering", () => {
    beforeAll(async () => {
      await request(http)
        .patch(`/branches/${branchId}/delivery-settings`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          deliveryFeeAmount: "10.00",
          deliveryMinOrderAmount: "50.00",
          selfServicePaymentMethods: ["cash", "online"],
        })
        .expect(200);
    });

    it("rejects an order below the minimum", async () => {
      await request(http)
        .post(`/public/restaurants/channels-a/branches/main/delivery-orders`)
        .set("Idempotency-Key", key())
        .send({
          items: [{ productId: fx.simple.id, quantity: 1 }],
          customerPhone: "0500000008",
          deliveryAddress: "شارع الملك فهد، الرياض",
        })
        .expect(409);
    });

    it("accepts a valid delivery order and folds the fee into the total", async () => {
      const res = await request(http)
        .post(`/public/restaurants/channels-a/branches/main/delivery-orders`)
        .set("Idempotency-Key", key())
        .send({
          items: [{ productId: fx.withSize.id, quantity: 2, modifierIds: [fx.large.id] }],
          customerPhone: "0500000009",
          deliveryAddress: "شارع الملك فهد، الرياض",
          paymentMethod: "cash",
        })
        .expect(201);

      expect(Number(res.body.deliveryFeeAmount)).toBeCloseTo(10, 2);
      const order = await admin.order.findUniqueOrThrow({ where: { id: res.body.orderId } });
      expect(order.type).toBe("delivery");
      expect(order.deliveryAddress).toBe("شارع الملك فهد، الرياض");
      expect(Number(order.total)).toBeCloseTo(2 * (30 + 5) + 10, 2);
    });

    it("rejects a disallowed payment method", async () => {
      await admin.branch.update({
        where: { id: branchId },
        data: { selfServicePaymentMethods: ["cash"] },
      });
      await request(http)
        .post(`/public/restaurants/channels-a/branches/main/delivery-orders`)
        .set("Idempotency-Key", key())
        .send({
          items: [{ productId: fx.withSize.id, quantity: 2 }],
          customerPhone: "0500000010",
          deliveryAddress: "شارع الملك فهد، الرياض",
          paymentMethod: "online",
        })
        .expect(400);
    });
  });
});
