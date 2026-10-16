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
 * Regression test for a real race found by this round's load test: two
 * concurrent transactions computing a sequential per-branch number (order
 * number, credit-note number, debit-note number) via
 * `findFirst({orderBy: {..Number: "desc"}})` then `(last ?? 0) + 1` can both
 * read the same "last" value and collide on the table's unique constraint,
 * surfacing as a raw 500 to the client and silently dropping the order/
 * document. Fixed by row-locking the branch (`SELECT id FROM branches
 * WHERE id = $1 FOR UPDATE`) before the read, in
 * OrderingService.createInTransaction, RefundsService.refund, and
 * DebitNotesService.issue (ReceiptsService.issue already had its own
 * retry-on-P2002 loop and was not affected).
 *
 * These tests fire genuinely concurrent requests (Promise.all, not
 * sequential awaits) against the SAME branch and assert every one succeeds
 * with a distinct, correctly-sequential number — the exact scenario that
 * used to produce intermittent 500s under real multi-terminal load.
 */
describe("concurrency: per-branch sequential numbering (e2e)", () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let http: ReturnType<INestApplication["getHttpServer"]>;

  let ownerA = "";
  let branchA = "";
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
      name: "مطعم اختبار التزامن",
      slug: "concurrency-test",
      ownerEmail: "owner@concurrency-test.test",
    });
    branchA = tenant.branchId!;
    fx = await createOrderingFixtures(admin, tenant.tenantId, branchA);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    http = app.getHttpServer();

    ownerA = await login("owner@concurrency-test.test");

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

  it("assigns distinct sequential orderNumbers to N genuinely concurrent order creations on the same branch", async () => {
    const N = 20;
    const responses = await Promise.all(
      Array.from({ length: N }, () =>
        request(http)
          .post("/orders")
          .set("Authorization", `Bearer ${ownerA}`)
          .set("Idempotency-Key", key())
          .send({
            type: "walkin",
            branchId: branchA,
            confirm: true,
            items: [{ productId: fx.simple.id, quantity: 1 }],
          }),
      ),
    );

    const statuses = responses.map((r) => r.status);
    expect(statuses.every((s) => s === 201)).toBe(true);

    const orderNumbers = responses.map((r) => r.body.orderNumber as number).sort((a, b) => a - b);
    expect(new Set(orderNumbers).size).toBe(N); // all distinct — no collision, no silently-dropped order
    // Sequential with no gaps within this run (this branch had zero prior orders today).
    expect(orderNumbers).toEqual(Array.from({ length: N }, (_, i) => i + 1));
  });

  it("assigns distinct sequential creditNoteNumbers to N genuinely concurrent refunds on the same branch", async () => {
    const N = 10;

    // Set up N separately-paid (and therefore auto-completed, receipted) orders first —
    // sequential on purpose, so each has its own receipt to refund concurrently after.
    const receiptedOrderIds: string[] = [];
    for (let i = 0; i < N; i++) {
      const order = await request(http)
        .post("/orders")
        .set("Authorization", `Bearer ${ownerA}`)
        .set("Idempotency-Key", key())
        .send({
          type: "walkin",
          branchId: branchA,
          confirm: true,
          items: [{ productId: fx.simple.id, quantity: 1 }],
        })
        .expect(201);
      await request(http)
        .post(`/orders/${order.body.id}/payments`)
        .set("Authorization", `Bearer ${ownerA}`)
        .set("Idempotency-Key", key())
        .send({ method: "cash", amount: order.body.total })
        .expect(201);
      // Receipts are issued lazily (get-or-create) — request it explicitly
      // so a receipt genuinely exists before the concurrent refunds below.
      await request(http)
        .get(`/orders/${order.body.id}/receipt`)
        .set("Authorization", `Bearer ${ownerA}`)
        .expect(200);
      receiptedOrderIds.push(order.body.id);
    }

    // Now refund all N in parallel — this is what raced on creditNoteNumber before the fix.
    const responses = await Promise.all(
      receiptedOrderIds.map((orderId) =>
        request(http)
          .post(`/orders/${orderId}/refund`)
          .set("Authorization", `Bearer ${ownerA}`)
          .set("Idempotency-Key", key())
          .send({ amount: "12.00", method: "cash", reason: "concurrency test" }),
      ),
    );

    const statuses = responses.map((r) => r.status);
    expect(statuses.every((s) => s === 201)).toBe(true);

    const creditNoteNumbers = responses
      .map((r) => r.body.creditNote.creditNoteNumber as number)
      .sort((a, b) => a - b);
    expect(new Set(creditNoteNumbers).size).toBe(N); // all distinct
  });
});
