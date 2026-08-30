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

describe("ordering (e2e)", () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let http: ReturnType<INestApplication["getHttpServer"]>;

  let ownerA = "";
  let ownerB = "";
  let kitchenA = "";
  let branchA = "";
  let fx: Fixtures;

  const key = () => randomUUID();

  async function login(email: string): Promise<string> {
    const res = await request(http)
      .post("/auth/login")
      .send({ email, password: "Test-12345" })
      .expect(200);
    return res.body.tokens.accessToken;
  }

  function createOrder(token: string, body: Record<string, unknown>, idem = key()) {
    return request(http)
      .post("/orders")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", idem)
      .send(body);
  }

  beforeAll(async () => {
    admin = createAdminClient();
    await truncateAll(admin);
    await syncPermissionCatalog(admin);

    const tenantA = await provisionTestTenant(admin, {
      name: "مطعم ألف",
      slug: "ord-a",
      ownerEmail: "owner@ord-a.test",
    });
    branchA = tenantA.branchId!;
    await provisionTestTenant(admin, {
      name: "مطعم باء",
      slug: "ord-b",
      ownerEmail: "owner@ord-b.test",
    });

    const { hashPassword } = await import("../../src/modules/identity/password");
    const kitchen = await admin.user.create({
      data: {
        email: "kitchen@ord-a.test",
        name: "Kitchen A",
        passwordHash: await hashPassword("Test-12345"),
        emailVerifiedAt: new Date(),
      },
    });
    await admin.userRole.create({
      data: {
        tenantId: tenantA.tenantId,
        userId: kitchen.id,
        roleId: tenantA.roleIdsByKey.kitchen,
        branchId: branchA,
      },
    });

    fx = await createOrderingFixtures(admin, tenantA.tenantId, branchA);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    http = app.getHttpServer();

    ownerA = await login("owner@ord-a.test");
    ownerB = await login("owner@ord-b.test");
    kitchenA = await login("kitchen@ord-a.test");
  });

  afterAll(async () => {
    await app.close();
    await admin.$disconnect();
  });

  describe("order creation", () => {
    let orderId = "";

    it("creates a walk-in order with exact NUMERIC totals and snapshots", async () => {
      const res = await createOrder(ownerA, {
        type: "walkin",
        branchId: branchA,
        confirm: true,
        items: [
          { productId: fx.withSize.id, quantity: 2, modifierIds: [fx.large.id] },
          { productId: fx.simple.id, quantity: 1 },
        ],
      }).expect(201);
      orderId = res.body.id;

      // (30+5)*2 + 12 = 82.00 gross; VAT 15% inclusive = 82*15/115 = 10.70
      expect(res.body.subtotal).toBe("82");
      expect(res.body.vatAmount).toBe("10.7");
      expect(res.body.total).toBe("82");
      expect(res.body.status).toBe("confirmed"); // confirm flag ran a validated transition
      expect(res.body.orderNumber).toBe(1);
      expect(res.body.source).toBe("pos");

      const item = res.body.items.find(
        (i: { productId: string }) => i.productId === fx.withSize.id,
      );
      expect(item.productSnapshot).toMatchObject({ name: "شيش طاووق", price: "30.00" });
      expect(item.unitPrice).toBe("30");
      expect(item.lineTotal).toBe("70");
      expect(item.modifiers[0].modifierSnapshot).toMatchObject({
        name: "كبير",
        groupName: "الحجم",
      });
    });

    it("menu changes do not alter existing orders (frozen snapshots)", async () => {
      await admin.product.update({ where: { id: fx.withSize.id }, data: { basePrice: "99.00" } });
      const res = await request(http)
        .get(`/orders/${orderId}`)
        .set("Authorization", `Bearer ${ownerA}`)
        .expect(200);
      const item = res.body.items.find(
        (i: { productId: string }) => i.productId === fx.withSize.id,
      );
      expect(item.unitPrice).toBe("30");
      expect(item.productSnapshot.price).toBe("30.00");
      expect(res.body.total).toBe("82");
      await admin.product.update({ where: { id: fx.withSize.id }, data: { basePrice: "30.00" } });
    });

    it("assigns sequential daily numbers per branch", async () => {
      const res = await createOrder(ownerA, {
        type: "walkin",
        branchId: branchA,
        items: [{ productId: fx.simple.id, quantity: 1 }],
      }).expect(201);
      expect(res.body.orderNumber).toBeGreaterThan(1);
    });

    it("is idempotent per Idempotency-Key", async () => {
      const idem = key();
      const first = await createOrder(
        ownerA,
        { type: "walkin", branchId: branchA, items: [{ productId: fx.simple.id, quantity: 1 }] },
        idem,
      ).expect(201);
      const replay = await createOrder(
        ownerA,
        { type: "walkin", branchId: branchA, items: [{ productId: fx.simple.id, quantity: 1 }] },
        idem,
      ).expect(201);
      expect(replay.body.id).toBe(first.body.id);
    });

    it("requires the Idempotency-Key header", async () => {
      await request(http)
        .post("/orders")
        .set("Authorization", `Bearer ${ownerA}`)
        .send({ type: "walkin", branchId: branchA, items: [{ productId: fx.simple.id, quantity: 1 }] })
        .expect(400);
    });

    it("enforces required modifier groups", async () => {
      await createOrder(ownerA, {
        type: "walkin",
        branchId: branchA,
        items: [{ productId: fx.withSize.id, quantity: 1 }], // size missing
      }).expect(400);
    });

    it("rejects modifiers from groups not attached to the product", async () => {
      await createOrder(ownerA, {
        type: "walkin",
        branchId: branchA,
        items: [{ productId: fx.simple.id, quantity: 1, modifierIds: [fx.large.id] }],
      }).expect(400);
    });

    it("rejects products unavailable in the branch", async () => {
      await admin.productBranchSetting.create({
        data: {
          tenantId: fx.simple.tenantId,
          productId: fx.simple.id,
          branchId: branchA,
          isAvailable: false,
        },
      });
      await createOrder(ownerA, {
        type: "walkin",
        branchId: branchA,
        items: [{ productId: fx.simple.id, quantity: 1 }],
      }).expect(409);
      await admin.productBranchSetting.deleteMany({ where: { productId: fx.simple.id } });
    });
  });

  describe("dine-in and table sessions", () => {
    it("attaches the order to the table's session, opening one when needed", async () => {
      const res = await createOrder(ownerA, {
        type: "dine_in",
        tableId: fx.table.id,
        items: [{ productId: fx.simple.id, quantity: 1 }],
      }).expect(201);
      expect(res.body.tableId).toBe(fx.table.id);
      expect(res.body.tableSessionId).toBeDefined();

      const table = await admin.table.findUniqueOrThrow({ where: { id: fx.table.id } });
      expect(table.status).toBe("occupied");

      // A second order from the same table joins the SAME open session.
      const second = await createOrder(ownerA, {
        type: "dine_in",
        tableId: fx.table.id,
        items: [{ productId: fx.simple.id, quantity: 2 }],
      }).expect(201);
      expect(second.body.tableSessionId).toBe(res.body.tableSessionId);

      const sessions = await admin.tableSession.findMany({
        where: { tableId: fx.table.id, closedAt: null },
      });
      expect(sessions).toHaveLength(1); // sessions are NOT closed automatically
    });
  });

  describe("status state machine", () => {
    let orderId = "";

    async function transition(token: string, id: string, status: string, expected: number) {
      return request(http)
        .post(`/orders/${id}/status`)
        .set("Authorization", `Bearer ${token}`)
        .send({ status })
        .expect(expected);
    }

    beforeAll(async () => {
      const res = await createOrder(ownerA, {
        type: "walkin",
        branchId: branchA,
        confirm: true,
        items: [{ productId: fx.simple.id, quantity: 1 }],
      }).expect(201);
      orderId = res.body.id;
    });

    it("rejects skipping states (confirmed -> ready)", async () => {
      await transition(ownerA, orderId, "ready", 409);
    });

    it("kitchen staff advance confirmed -> preparing -> ready", async () => {
      await transition(kitchenA, orderId, "preparing", 200);
      await transition(kitchenA, orderId, "ready", 200);
    });

    it("READY cannot return to NEW or be cancelled", async () => {
      await transition(ownerA, orderId, "new", 409);
      await transition(ownerA, orderId, "cancelled", 409);
    });

    it("ready -> served -> completed, with full audited history", async () => {
      await transition(ownerA, orderId, "served", 200);

      // Phase 5 guard: completion requires full payment.
      await transition(ownerA, orderId, "completed", 409);
      await request(http)
        .post("/shifts/open")
        .set("Authorization", `Bearer ${ownerA}`)
        .send({ branchId: branchA, openingCash: "0" })
        .expect(201);
      await request(http)
        .post(`/orders/${orderId}/payments`)
        .set("Authorization", `Bearer ${ownerA}`)
        .set("Idempotency-Key", key())
        .send({ method: "cash", amount: "12.00" })
        .expect(201);

      const row = await admin.order.findUniqueOrThrow({ where: { id: orderId } });
      expect(row.status).toBe("completed"); // auto-completed on full payment

      const history = await admin.orderStatusHistory.findMany({
        where: { orderId },
        orderBy: { createdAt: "asc" },
      });
      expect(history.map((h) => h.toStatus)).toEqual([
        "new",
        "confirmed",
        "preparing",
        "ready",
        "served",
        "completed",
      ]);
      // Every transition records who changed it.
      expect(history.slice(1).every((h) => h.changedBy !== null)).toBe(true);
    });

    it("completed is terminal", async () => {
      await transition(ownerA, orderId, "preparing", 409);
    });

    it("cancellation requires orders.void (kitchen denied, owner allowed, with reason)", async () => {
      const res = await createOrder(ownerA, {
        type: "walkin",
        branchId: branchA,
        items: [{ productId: fx.simple.id, quantity: 1 }],
      }).expect(201);

      await request(http)
        .post(`/orders/${res.body.id}/status`)
        .set("Authorization", `Bearer ${kitchenA}`)
        .send({ status: "cancelled" })
        .expect(403);

      const cancelled = await request(http)
        .post(`/orders/${res.body.id}/status`)
        .set("Authorization", `Bearer ${ownerA}`)
        .send({ status: "cancelled", reason: "طلب العميل" })
        .expect(200);
      expect(cancelled.body.status).toBe("cancelled");
      expect(cancelled.body.cancelledReason).toBe("طلب العميل");

      const audit = await admin.auditLog.findFirst({
        where: { action: "order.cancelled", entityId: res.body.id },
      });
      expect(audit).not.toBeNull();
    });
  });

  describe("guest (QR) ordering readiness", () => {
    // Each content-sensitive test below gets its OWN fresh table — fx.table
    // (used by "dine-in and table sessions" above) is left with an open
    // session and an active order, and two tests sharing one fresh table
    // would contaminate each other's totals the same way.
    async function createFreshTable() {
      return admin.table.create({
        data: {
          tenantId: fx.category.tenantId,
          branchId: branchA,
          floorId: fx.floor.id,
          number: `T-guest-${randomUUID().slice(0, 8)}`,
          qrToken: randomUUID(),
        },
      });
    }

    it("resolves table info and branch menu by QR token", async () => {
      const info = await request(http).get(`/public/tables/${fx.table.qrToken}`).expect(200);
      expect(info.body.restaurant.slug).toBe("ord-a");
      expect(info.body.table.number).toBe("T1");

      const menu = await request(http)
        .get(`/public/tables/${fx.table.qrToken}/menu`)
        .expect(200);
      const product = menu.body.products.find((p: { id: string }) => p.id === fx.withSize.id);
      expect(product.price).toBe("30");
      expect(product.modifierGroups[0].modifiers).toHaveLength(2);
    });

    it("creates a guest order attached to the table session, requiring a phone", async () => {
      const guestTable = await createFreshTable();
      const res = await request(http)
        .post(`/public/tables/${guestTable.qrToken}/orders`)
        .set("Idempotency-Key", key())
        .send({
          items: [{ productId: fx.withSize.id, quantity: 1, modifierIds: [fx.regular.id] }],
          customerName: "زائر",
          customerPhone: "+966500000001",
        })
        .expect(201);
      expect(res.body.orderNumber).toBeGreaterThan(0);
      expect(res.body.status).toBe("new");
      expect(res.body.total).toBe("30");
      expect(res.body.sessionId).toBeDefined();

      const order = await admin.order.findUniqueOrThrow({ where: { id: res.body.orderId } });
      expect(order.source).toBe("qr");
      expect(order.type).toBe("dine_in");
      expect(order.placedBy).toBeNull(); // guest
      expect(order.tableSessionId).not.toBeNull();
      expect(order.customerPhone).toBe("+966500000001");

      const item = await admin.orderItem.findFirstOrThrow({ where: { orderId: res.body.orderId } });
      expect(item.participantPhone).toBe("+966500000001");
    });

    it("a second phone scanning the same table joins the SAME order instead of creating a new one", async () => {
      const guestTable = await createFreshTable();
      const first = await request(http)
        .post(`/public/tables/${guestTable.qrToken}/orders`)
        .set("Idempotency-Key", key())
        .send({
          items: [{ productId: fx.simple.id, quantity: 1 }],
          customerPhone: "+966500000010",
        })
        .expect(201);

      const second = await request(http)
        .post(`/public/tables/${guestTable.qrToken}/orders`)
        .set("Idempotency-Key", key())
        .send({
          items: [{ productId: fx.simple.id, quantity: 1 }],
          customerPhone: "+966500000011",
        })
        .expect(201);

      expect(second.body.orderId).toBe(first.body.orderId);
      expect(second.body.sessionId).toBe(first.body.sessionId);
      // total reflects BOTH rounds, not just the second one.
      expect(second.body.total).toBe(
        (Number(first.body.total) * 2).toFixed(0),
      );

      const items = await admin.orderItem.findMany({ where: { orderId: first.body.orderId } });
      const phones = items.map((i) => i.participantPhone).sort();
      expect(phones).toEqual(["+966500000010", "+966500000011"]);

      const participants = await admin.tableSessionParticipant.findMany({
        where: { tableSessionId: first.body.sessionId },
      });
      expect(participants.map((p) => p.phone).sort()).toEqual(["+966500000010", "+966500000011"]);
    });

    it("requires Idempotency-Key and rejects invalid tokens", async () => {
      await request(http)
        .post(`/public/tables/${fx.table.qrToken}/orders`)
        .send({ items: [{ productId: fx.simple.id, quantity: 1 }], customerPhone: "+966500000099" })
        .expect(400);
      await request(http).get("/public/tables/not-a-real-token").expect(404);
    });
  });

  describe("tenant isolation & permissions", () => {
    it("tenant B cannot read or transition tenant A orders", async () => {
      const orders = await admin.order.findMany({ where: { branchId: branchA }, take: 1 });
      const orderId = orders[0].id;

      await request(http)
        .get(`/orders/${orderId}`)
        .set("Authorization", `Bearer ${ownerB}`)
        .expect(404);
      await request(http)
        .post(`/orders/${orderId}/status`)
        .set("Authorization", `Bearer ${ownerB}`)
        .send({ status: "confirmed" })
        .expect(404);
    });

    it("anonymous requests are rejected on authenticated endpoints", async () => {
      await request(http).get("/orders").expect(401);
      await request(http).post("/orders").send({}).expect(401);
    });
  });
});
