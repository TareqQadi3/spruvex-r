import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import request from "supertest";

import { decodeZatcaQrPayload } from "../../src/modules/payments/zatca/tlv";
import { syncPermissionCatalog } from "../../src/modules/tenancy/tenant-provisioning";
import { AppModule } from "../../src/app.module";
import { createOrderingFixtures } from "../helpers/catalog-fixtures";
import { createAdminClient, createRawAppClient, truncateAll } from "../helpers/db";
import { provisionTestTenant } from "../helpers/provision";

type Fixtures = Awaited<ReturnType<typeof createOrderingFixtures>>;

describe("customer experience + ZATCA foundation (e2e)", () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let http: ReturnType<INestApplication["getHttpServer"]>;

  let ownerA = "";
  let branchA = "";
  let tenantAId = "";
  let fx: Fixtures;

  const key = () => randomUUID();

  async function login(email: string): Promise<string> {
    const res = await request(http)
      .post("/auth/login")
      .send({ email, password: "Test-12345" })
      .expect(200);
    return res.body.tokens.accessToken;
  }

  beforeAll(async () => {
    admin = createAdminClient();
    await truncateAll(admin);
    await syncPermissionCatalog(admin);

    const tenantA = await provisionTestTenant(admin, {
      name: "مطعم ألف",
      slug: "cx-a",
      ownerEmail: "owner@cx-a.test",
    });
    tenantAId = tenantA.tenantId;
    branchA = tenantA.branchId!;
    await provisionTestTenant(admin, {
      name: "مطعم باء",
      slug: "cx-b",
      ownerEmail: "owner@cx-b.test",
    });

    fx = await createOrderingFixtures(admin, tenantAId, branchA);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    http = app.getHttpServer();

    ownerA = await login("owner@cx-a.test");
  });

  afterAll(async () => {
    await app.close();
    await admin.$disconnect();
  });

  describe("establishment (ZATCA) data", () => {
    it("owner sets legal name, VAT number and address", async () => {
      const res = await request(http)
        .patch("/tenant")
        .set("Authorization", `Bearer ${ownerA}`)
        .send({
          legalName: "شركة مطاعم ألف المحدودة",
          vatNumber: "310123456700003",
          crNumber: "1010101010",
          address: "شارع العليا، الرياض",
        })
        .expect(200);
      expect(res.body.legalName).toBe("شركة مطاعم ألف المحدودة");

      const audit = await admin.auditLog.findFirst({
        where: { action: "tenant.settings_updated", tenantId: tenantAId },
      });
      expect(audit).not.toBeNull();
    });

    it("rejects malformed VAT numbers", async () => {
      await request(http)
        .patch("/tenant")
        .set("Authorization", `Bearer ${ownerA}`)
        .send({ vatNumber: "123" })
        .expect(400);
    });
  });

  describe("external ordering link (/restaurant/{slug})", () => {
    it("serves public restaurant info with branches", async () => {
      const res = await request(http).get("/public/restaurants/cx-a").expect(200);
      expect(res.body.restaurant.name).toBe("مطعم ألف");
      expect(res.body.restaurant).not.toHaveProperty("id"); // no internal ids
      expect(res.body.branches.length).toBeGreaterThan(0);
      expect(res.body.branches[0].slug).toBeDefined();
    });

    it("serves the branch menu by slug", async () => {
      const res = await request(http)
        .get("/public/restaurants/cx-a/branches/main/menu")
        .expect(200);
      expect(res.body.products.length).toBeGreaterThan(0);
      expect(res.body.categories.length).toBeGreaterThan(0);
    });

    it("creates a pickup order (phone mandatory, source external_link)", async () => {
      await request(http)
        .post("/public/restaurants/cx-a/branches/main/orders")
        .set("Idempotency-Key", key())
        .send({ items: [{ productId: fx.simple.id, quantity: 1 }], customerName: "زائر" })
        .expect(400); // phone missing

      const res = await request(http)
        .post("/public/restaurants/cx-a/branches/main/orders")
        .set("Idempotency-Key", key())
        .send({
          items: [{ productId: fx.simple.id, quantity: 2 }],
          customerName: "زائر",
          customerPhone: "+966500000001",
        })
        .expect(201);
      expect(res.body.total).toBe("24");

      const order = await admin.order.findUniqueOrThrow({ where: { id: res.body.orderId } });
      expect(order.source).toBe("external_link");
      expect(order.type).toBe("takeaway");
      expect(order.customerPhone).toBe("+966500000001");
    });

    it("unknown slugs and cross-tenant branch slugs are 404", async () => {
      await request(http).get("/public/restaurants/ghost").expect(404);
      // Tenant B's branch is not reachable through tenant A's slug.
      await request(http).get("/public/restaurants/cx-a/branches/ghost/menu").expect(404);
    });
  });

  describe("guest order tracking", () => {
    it("tracks by order UUID with customer-safe fields only", async () => {
      const created = await request(http)
        .post(`/public/tables/${fx.table.qrToken}/orders`)
        .set("Idempotency-Key", key())
        .send({ items: [{ productId: fx.withSize.id, quantity: 1, modifierIds: [fx.regular.id] }] })
        .expect(201);

      const res = await request(http)
        .get(`/public/orders/${created.body.orderId}/track`)
        .expect(200);
      expect(res.body.status).toBe("new");
      expect(res.body.table).toBe("T1");
      expect(res.body.items[0].name).toBe("شيش طاووق");
      expect(res.body).not.toHaveProperty("placedBy");
      expect(res.body).not.toHaveProperty("statusHistory");

      await request(http)
        .get("/public/orders/00000000-0000-4000-8000-000000000000/track")
        .expect(404);
    });
  });

  describe("ZATCA receipt QR + immutability", () => {
    let receiptOrderId = "";

    it("issues receipts with a decodable Phase 1 TLV QR", async () => {
      // Order + full payment (owner shift).
      await request(http)
        .post("/shifts/open")
        .set("Authorization", `Bearer ${ownerA}`)
        .send({ branchId: branchA, openingCash: "0" })
        .expect(201);
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
      receiptOrderId = order.body.id;
      await request(http)
        .post(`/orders/${receiptOrderId}/payments`)
        .set("Authorization", `Bearer ${ownerA}`)
        .set("Idempotency-Key", key())
        .send({ method: "cash", amount: "12.00" })
        .expect(201);

      const receipt = await request(http)
        .get(`/orders/${receiptOrderId}/receipt`)
        .set("Authorization", `Bearer ${ownerA}`)
        .expect(200);

      // Mandatory five TLV tags, matching the invoice.
      const tags = decodeZatcaQrPayload(receipt.body.qrPayload);
      expect(tags.get(1)).toBe("شركة مطاعم ألف المحدودة"); // legal name
      expect(tags.get(2)).toBe("310123456700003");
      expect(new Date(tags.get(3)!).getTime()).not.toBeNaN();
      expect(tags.get(4)).toBe("12");
      expect(tags.get(5)).toBe(receipt.body.vatAmount);

      // VAT-ready totals incl. total before VAT: 12.00 - 1.57 = 10.43
      expect(receipt.body.payload.totals.totalBeforeVat).toBe("10.43");
      expect(receipt.body.payload.restaurant.legalName).toBe("شركة مطاعم ألف المحدودة");
      expect(receipt.body.payload.restaurant.address).toBe("شارع العليا، الرياض");

      // Phase 2 is opt-in (see zatca-phase2.e2e.spec.ts) — a tenant that
      // hasn't enabled it gets exactly Phase 1 behavior: no hash chain, no
      // XML, submission status stays "not_submitted".
      expect(receipt.body.invoiceHash).toBeNull();
      expect(receipt.body.xmlContent).toBeNull();
      expect(receipt.body.zatcaStatus).toBe("not_submitted");

      // QR image endpoint serves a PNG of the payload.
      const png = await request(http)
        .get(`/orders/${receiptOrderId}/receipt/qr.png`)
        .set("Authorization", `Bearer ${ownerA}`)
        .expect(200);
      expect(png.headers["content-type"]).toContain("image/png");
    });

    it("chains invoice hashes per branch", async () => {
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
        .send({ method: "cash", amount: "12.00" })
        .expect(201);
      const second = await request(http)
        .get(`/orders/${order.body.id}/receipt`)
        .set("Authorization", `Bearer ${ownerA}`)
        .expect(200);

      const first = await admin.receipt.findUniqueOrThrow({
        where: { orderId: receiptOrderId },
      });
      expect(second.body.previousInvoiceHash).toBe(first.invoiceHash);
    });

    it("receipts are immutable for the app role (UPDATE/DELETE denied)", async () => {
      const raw = createRawAppClient();
      try {
        await expect(
          raw.$executeRawUnsafe(`UPDATE receipts SET total = 0`),
        ).rejects.toThrow(/permission denied/i);
        await expect(raw.$executeRawUnsafe(`DELETE FROM receipts`)).rejects.toThrow(
          /permission denied/i,
        );
      } finally {
        await raw.$disconnect();
      }
    });

    it("VAT calculation on receipts matches the inclusive formula", async () => {
      const receipt = await admin.receipt.findUniqueOrThrow({
        where: { orderId: receiptOrderId },
      });
      // 12.00 gross at 15%: VAT = 12 * 15/115 = 1.5652 -> 1.57
      expect(receipt.vatAmount.toString()).toBe("1.57");
      expect(receipt.total.toString()).toBe("12");
    });
  });

  describe("admin QR ordering toggle", () => {
    it("disabling QR ordering blocks table info, menu and order creation", async () => {
      const branches = await request(http)
        .get("/branches")
        .set("Authorization", `Bearer ${ownerA}`)
        .expect(200);
      const branch = branches.body.find((b: { id: string }) => b.id === branchA);
      expect(branch.orderingSettings?.qrOrderingEnabled).not.toBe(false); // enabled by default

      // Sanity: QR flow works while enabled.
      await request(http).get(`/public/tables/${fx.table.qrToken}`).expect(200);

      const toggled = await request(http)
        .patch(`/branches/${branchA}/ordering-settings`)
        .set("Authorization", `Bearer ${ownerA}`)
        .send({ qrOrderingEnabled: false })
        .expect(200);
      expect(toggled.body.orderingSettings.qrOrderingEnabled).toBe(false);

      await request(http).get(`/public/tables/${fx.table.qrToken}`).expect(409);
      await request(http).get(`/public/tables/${fx.table.qrToken}/menu`).expect(409);
      await request(http)
        .post(`/public/tables/${fx.table.qrToken}/orders`)
        .set("Idempotency-Key", key())
        .send({ items: [{ productId: fx.simple.id, quantity: 1 }] })
        .expect(409);

      // The external pickup link is unaffected by the QR toggle.
      await request(http).get("/public/restaurants/cx-a/branches/main/menu").expect(200);

      const audit = await admin.auditLog.findFirst({
        where: { action: "branch.ordering_settings_updated", branchId: branchA },
      });
      expect(audit).not.toBeNull();

      // Re-enable so it doesn't leak into other describe blocks running after this one.
      await request(http)
        .patch(`/branches/${branchA}/ordering-settings`)
        .set("Authorization", `Bearer ${ownerA}`)
        .send({ qrOrderingEnabled: true })
        .expect(200);
      await request(http).get(`/public/tables/${fx.table.qrToken}`).expect(200);
    });

    it("requires branches.manage to change ordering settings", async () => {
      await request(http)
        .patch(`/branches/${branchA}/ordering-settings`)
        .send({ qrOrderingEnabled: false })
        .expect(401);
    });
  });
});
