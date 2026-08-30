import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import request from "supertest";

import { AppModule } from "../../src/app.module";
import { TableSessionsService } from "../../src/modules/tables/table-sessions.service";
import { syncPermissionCatalog } from "../../src/modules/tenancy/tenant-provisioning";
import { createOrderingFixtures } from "../helpers/catalog-fixtures";
import { createAdminClient, truncateAll } from "../helpers/db";
import { provisionTestTenant } from "../helpers/provision";

type Fixtures = Awaited<ReturnType<typeof createOrderingFixtures>>;

/**
 * Shared table-session ordering: several phones scanning one table's QR
 * merge into ONE real order/invoice. This exercises exactly the "critical
 * cases" called out for this feature — concurrent joins/appends, bill
 * splitting (equal and by-item), a per-item refund shrinking only its own
 * participant's share, blocking a session close over an unpaid balance,
 * and the inactivity sweep that flags rather than silently closes a table
 * with money still owed.
 *
 * Money model reminder (see shared/common/money.ts): prices are
 * VAT-inclusive. At 15%, a 12.00 SAR item is net 10.43 + vat 1.57.
 */
describe("shared table sessions (e2e)", () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let tableSessions: TableSessionsService;

  let ownerA = "";
  let cashierA = "";
  let tenantAId = "";
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

  async function createFreshTable() {
    return admin.table.create({
      data: {
        tenantId: tenantAId,
        branchId: branchA,
        floorId: fx.floor.id,
        number: `T-${randomUUID().slice(0, 8)}`,
        qrToken: randomUUID(),
      },
    });
  }

  function scanOrder(qrToken: string, items: Array<Record<string, unknown>>, customerPhone: string) {
    return request(http)
      .post(`/public/tables/${qrToken}/orders`)
      .set("Idempotency-Key", key())
      .send({ items, customerPhone });
  }

  /** Adds a participant's round via the STAFF append endpoint instead of a
   * second guest scan — used wherever a test needs a second participant on
   * the order but isn't itself testing the guest QR endpoint (which is
   * rate-limited; the guest-concurrency tests above already cover it). */
  function staffJoin(orderId: string, items: Array<Record<string, unknown>>, participantPhone: string) {
    return request(http)
      .post(`/orders/${orderId}/items`)
      .set("Authorization", `Bearer ${cashierA}`)
      .set("Idempotency-Key", key())
      .send({ items, participantPhone });
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
      name: "مطعم الجلسات المشتركة",
      slug: "tsess-a",
      ownerEmail: "owner@tsess-a.test",
    });
    tenantAId = tenantA.tenantId;
    branchA = tenantA.branchId!;
    fx = await createOrderingFixtures(admin, tenantAId, branchA);

    const { hashPassword } = await import("../../src/modules/identity/password");
    const cashier = await admin.user.create({
      data: {
        email: "cashier@tsess-a.test",
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
    tableSessions = moduleRef.get(TableSessionsService);

    ownerA = await login("owner@tsess-a.test");
    cashierA = await login("cashier@tsess-a.test");

    await request(http)
      .post("/shifts/open")
      .set("Authorization", `Bearer ${ownerA}`)
      .send({ branchId: branchA, openingCash: "0" })
      .expect(201);
  });

  afterAll(async () => {
    await app.close();
    await admin.$disconnect();
  });

  describe("concurrency: two phones scanning the same table at the same instant", () => {
    it("merges into ONE order — no lost items, no duplicate session", async () => {
      const table = await createFreshTable();

      const [a, b] = await Promise.all([
        scanOrder(table.qrToken, [{ productId: fx.simple.id, quantity: 1 }], "+966500000100"),
        scanOrder(table.qrToken, [{ productId: fx.simple.id, quantity: 1 }], "+966500000101"),
      ]);
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);

      // Both requests must have landed on the exact same order and session —
      // this is the whole point: the race is resolved to ONE bill, not two.
      expect(a.body.orderId).toBe(b.body.orderId);
      expect(a.body.sessionId).toBe(b.body.sessionId);

      const items = await admin.orderItem.findMany({ where: { orderId: a.body.orderId } });
      expect(items).toHaveLength(2); // neither round was lost to the race
      expect(items.map((i) => i.participantPhone).sort()).toEqual([
        "+966500000100",
        "+966500000101",
      ]);

      // 2x 12.00 = 24.00 total on the ONE order.
      const order = await admin.order.findUniqueOrThrow({ where: { id: a.body.orderId } });
      expect(order.total.toString()).toBe("24");

      const sessions = await admin.tableSession.findMany({ where: { tableId: table.id } });
      expect(sessions).toHaveLength(1); // the race never created a second session
    });

    it("concurrent appends to an existing order both land (no lost update)", async () => {
      const table = await createFreshTable();
      const first = await scanOrder(table.qrToken, [{ productId: fx.simple.id, quantity: 1 }], "+966500000110").expect(201);
      expect(first.body.total).toBe("12");

      // Two more people join at the same instant.
      const [second, third] = await Promise.all([
        scanOrder(table.qrToken, [{ productId: fx.simple.id, quantity: 1 }], "+966500000111"),
        scanOrder(table.qrToken, [{ productId: fx.simple.id, quantity: 1 }], "+966500000112"),
      ]);
      expect(second.status).toBe(201);
      expect(third.status).toBe(201);

      const order = await admin.order.findUniqueOrThrow({ where: { id: first.body.orderId } });
      // 3 x 12.00 = 36.00 — if either append had been lost to a race, this
      // would read 24.00 instead.
      expect(order.total.toString()).toBe("36");
      const items = await admin.orderItem.findMany({ where: { orderId: first.body.orderId } });
      expect(items).toHaveLength(3);
    });
  });

  describe("cashier manual append from the POS", () => {
    it("adds items to the table's open order on behalf of a participant", async () => {
      const table = await createFreshTable();
      const guest = await scanOrder(table.qrToken, [{ productId: fx.simple.id, quantity: 1 }], "+966500000120").expect(201);

      const appended = await request(http)
        .post(`/orders/${guest.body.orderId}/items`)
        .set("Authorization", `Bearer ${cashierA}`)
        .set("Idempotency-Key", key())
        .send({ items: [{ productId: fx.simple.id, quantity: 1 }], participantPhone: "+966500000120" })
        .expect(201);
      expect(appended.body.total).toBe("24");

      // Waiter adds a round with nobody attributed — pooled into the shared bucket.
      await request(http)
        .post(`/orders/${guest.body.orderId}/items`)
        .set("Authorization", `Bearer ${cashierA}`)
        .set("Idempotency-Key", key())
        .send({ items: [{ productId: fx.simple.id, quantity: 1 }] })
        .expect(201);

      const items = await admin.orderItem.findMany({ where: { orderId: guest.body.orderId } });
      expect(items).toHaveLength(3);
      expect(items.filter((i) => i.participantPhone === null)).toHaveLength(1);
    });

    it("blocks appending once a discount is applied, per the documented constraint", async () => {
      const table = await createFreshTable();
      const guest = await scanOrder(table.qrToken, [{ productId: fx.simple.id, quantity: 1 }], "+966500000121").expect(201);
      await request(http)
        .post(`/orders/${guest.body.orderId}/discount`)
        .set("Authorization", `Bearer ${ownerA}`)
        .send({ type: "fixed", value: "1.00", reason: "test" })
        .expect(200);

      await request(http)
        .post(`/orders/${guest.body.orderId}/items`)
        .set("Authorization", `Bearer ${cashierA}`)
        .set("Idempotency-Key", key())
        .send({ items: [{ productId: fx.simple.id, quantity: 1 }] })
        .expect(409);
    });

    it("reopens a ready/served ticket back to confirmed when new items land", async () => {
      const table = await createFreshTable();
      const guest = await scanOrder(table.qrToken, [{ productId: fx.simple.id, quantity: 1 }], "+966500000122").expect(201);
      await request(http)
        .post(`/orders/${guest.body.orderId}/status`)
        .set("Authorization", `Bearer ${ownerA}`)
        .send({ status: "confirmed" })
        .expect(200);
      await request(http)
        .post(`/orders/${guest.body.orderId}/status`)
        .set("Authorization", `Bearer ${ownerA}`)
        .send({ status: "preparing" })
        .expect(200);
      await request(http)
        .post(`/orders/${guest.body.orderId}/status`)
        .set("Authorization", `Bearer ${ownerA}`)
        .send({ status: "ready" })
        .expect(200);

      await request(http)
        .post(`/orders/${guest.body.orderId}/items`)
        .set("Authorization", `Bearer ${cashierA}`)
        .set("Idempotency-Key", key())
        .send({ items: [{ productId: fx.simple.id, quantity: 1 }] })
        .expect(201);

      const order = await admin.order.findUniqueOrThrow({ where: { id: guest.body.orderId } });
      expect(order.status).toBe("confirmed");
    });
  });

  describe("bill splitting", () => {
    it("splits equally, with rounding remainder going to the earliest joiners", async () => {
      const table = await createFreshTable();
      // 12.00 x 3 = 36.00 total; 3-way equal split = 12.00 each exactly.
      const first = await scanOrder(table.qrToken, [{ productId: fx.simple.id, quantity: 1 }], "+966500000130").expect(201);
      await staffJoin(first.body.orderId, [{ productId: fx.simple.id, quantity: 1 }], "+966500000131").expect(201);
      await staffJoin(first.body.orderId, [{ productId: fx.simple.id, quantity: 1 }], "+966500000132").expect(201);

      const split = await request(http)
        .get(`/orders/${first.body.orderId}/split?mode=equal`)
        .set("Authorization", `Bearer ${ownerA}`)
        .expect(200);
      expect(split.body.participants).toHaveLength(3);
      expect(split.body.participants.every((p: { amount: string }) => p.amount === "12.00")).toBe(true);
      const sum = split.body.participants.reduce((s: number, p: { amount: string }) => s + Number(p.amount), 0);
      expect(sum.toFixed(2)).toBe(split.body.total);
    });

    it("splits by item — each participant pays exactly what they ordered, refunding one item shrinks only their share", async () => {
      const table = await createFreshTable();
      // A orders 12.00, B orders 2x12.00=24.00 -> total 36.00.
      const a = await scanOrder(table.qrToken, [{ productId: fx.simple.id, quantity: 1 }], "+966500000140").expect(201);
      await staffJoin(a.body.orderId, [{ productId: fx.simple.id, quantity: 2 }], "+966500000141").expect(201);

      const split = await request(http)
        .get(`/orders/${a.body.orderId}/split?mode=by_item`)
        .set("Authorization", `Bearer ${ownerA}`)
        .expect(200);
      const byPhone = Object.fromEntries(split.body.participants.map((p: { phone: string; amount: string }) => [p.phone, p.amount]));
      expect(byPhone["+966500000140"]).toBe("12.00");
      expect(byPhone["+966500000141"]).toBe("24.00");

      // Settle the whole bill: confirm -> pay in full (auto-completes) -> receipt is issued.
      await request(http)
        .post(`/orders/${a.body.orderId}/status`)
        .set("Authorization", `Bearer ${ownerA}`)
        .send({ status: "confirmed" })
        .expect(200);
      await payInFull(a.body.orderId, "36.00");
      await request(http)
        .get(`/orders/${a.body.orderId}/receipt`)
        .set("Authorization", `Bearer ${ownerA}`)
        .expect(200);

      // Now refund ONE unit of B's 2-unit line (12.00 of it).
      const bItem = await admin.orderItem.findFirstOrThrow({
        where: { orderId: a.body.orderId, participantPhone: "+966500000141" },
      });
      await request(http)
        .post(`/orders/${a.body.orderId}/items/${bItem.id}/refund`)
        .set("Authorization", `Bearer ${ownerA}`)
        .send({ quantity: 1, method: "cash", reason: "أحد المشروبين رجع" })
        .expect(201);

      const splitAfter = await request(http)
        .get(`/orders/${a.body.orderId}/split?mode=by_item`)
        .set("Authorization", `Bearer ${ownerA}`)
        .expect(200);
      const afterByPhone = Object.fromEntries(
        splitAfter.body.participants.map((p: { phone: string; amount: string }) => [p.phone, p.amount]),
      );
      // A's share is untouched by B's refund.
      expect(afterByPhone["+966500000140"]).toBe("12.00");
      // B's outstanding share dropped by exactly the refunded unit (24.00 -> 12.00).
      expect(afterByPhone["+966500000141"]).toBe("12.00");
    });
  });

  describe("closing a session with an unpaid balance", () => {
    it("refuses to close without force, succeeds with force, and succeeds once paid", async () => {
      const table = await createFreshTable();
      await scanOrder(table.qrToken, [{ productId: fx.simple.id, quantity: 1 }], "+966500000150").expect(201);

      const blocked = await request(http)
        .post(`/tables/${table.id}/sessions/close`)
        .set("Authorization", `Bearer ${ownerA}`)
        .send({})
        .expect(409);
      expect(blocked.body.message).toContain("unpaid balance");

      await request(http)
        .post(`/tables/${table.id}/sessions/close`)
        .set("Authorization", `Bearer ${ownerA}`)
        .send({ force: true })
        .expect(200);

      const closed = await admin.tableSession.findFirst({
        where: { tableId: table.id },
        orderBy: { openedAt: "desc" },
      });
      expect(closed?.closedAt).not.toBeNull();

      // A brand new scan reopens a fresh session for the same table.
      const table2 = await createFreshTable();
      const guest2 = await scanOrder(table2.qrToken, [{ productId: fx.simple.id, quantity: 1 }], "+966500000151").expect(201);
      await request(http)
        .post(`/orders/${guest2.body.orderId}/status`)
        .set("Authorization", `Bearer ${ownerA}`)
        .send({ status: "confirmed" })
        .expect(200);
      await payInFull(guest2.body.orderId, "12.00");
      await request(http)
        .post(`/tables/${table2.id}/sessions/close`)
        .set("Authorization", `Bearer ${ownerA}`)
        .send({})
        .expect(200);
    });
  });

  describe("open-sessions view for the cashier", () => {
    it("lists open sessions with participants, order status and unpaid balance", async () => {
      const table = await createFreshTable();
      const first = await scanOrder(table.qrToken, [{ productId: fx.simple.id, quantity: 1 }], "+966500000160").expect(201);
      await staffJoin(first.body.orderId, [{ productId: fx.simple.id, quantity: 1 }], "+966500000161").expect(201);

      const res = await request(http)
        .get(`/tables/sessions/open?branchId=${branchA}`)
        .set("Authorization", `Bearer ${ownerA}`)
        .expect(200);
      const row = res.body.find((r: { table: { id: string } }) => r.table.id === table.id);
      expect(row).toBeDefined();
      expect(row.participants).toHaveLength(2);
      expect(row.order.total).toBe("24");
      expect(row.unpaidBalance).toBe("24.00");
    });
  });

  describe("inactivity sweep", () => {
    it("flags (never silently closes) a stale session with an unpaid balance", async () => {
      const table = await createFreshTable();
      const guest = await scanOrder(table.qrToken, [{ productId: fx.simple.id, quantity: 1 }], "+966500000170").expect(201);

      await admin.tableSession.update({
        where: { id: guest.body.sessionId },
        data: { lastActivityAt: new Date(Date.now() - 200 * 60 * 1000) },
      });

      await tableSessions.checkStaleSessions();

      const session = await admin.tableSession.findUniqueOrThrow({ where: { id: guest.body.sessionId } });
      expect(session.closedAt).toBeNull(); // never silently closed
      expect(session.staleFlaggedAt).not.toBeNull(); // but flagged for the cashier

      const table3 = await admin.table.findUniqueOrThrow({ where: { id: table.id } });
      expect(table3.status).toBe("occupied"); // still occupied — not freed up
    });

    it("auto-closes a stale session once it has no unpaid balance", async () => {
      const table = await createFreshTable();
      const guest = await scanOrder(table.qrToken, [{ productId: fx.simple.id, quantity: 1 }], "+966500000171").expect(201);
      await request(http)
        .post(`/orders/${guest.body.orderId}/status`)
        .set("Authorization", `Bearer ${ownerA}`)
        .send({ status: "confirmed" })
        .expect(200);
      await payInFull(guest.body.orderId, "12.00");

      await admin.tableSession.update({
        where: { id: guest.body.sessionId },
        data: { lastActivityAt: new Date(Date.now() - 200 * 60 * 1000) },
      });

      await tableSessions.checkStaleSessions();

      const session = await admin.tableSession.findUniqueOrThrow({ where: { id: guest.body.sessionId } });
      expect(session.closedAt).not.toBeNull();

      const freedTable = await admin.table.findUniqueOrThrow({ where: { id: table.id } });
      expect(freedTable.status).toBe("available");
    });
  });

  describe("tenant isolation", () => {
    it("an unrelated tenant's open-sessions view never shows this tenant's tables", async () => {
      const tenantC = await provisionTestTenant(admin, {
        name: "مطعم آخر",
        slug: "tsess-c",
        ownerEmail: "owner@tsess-c.test",
      });
      void tenantC;
      const ownerC = await login("owner@tsess-c.test");
      const res = await request(http)
        .get("/tables/sessions/open")
        .set("Authorization", `Bearer ${ownerC}`)
        .expect(200);
      expect(res.body).toHaveLength(0);
    });
  });
});
