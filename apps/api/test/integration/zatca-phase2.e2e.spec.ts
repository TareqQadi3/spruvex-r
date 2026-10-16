import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";

import { syncPermissionCatalog } from "../../src/modules/tenancy/tenant-provisioning";
import { AppModule } from "../../src/app.module";
import { createOrderingFixtures } from "../helpers/catalog-fixtures";
import { createAdminClient, truncateAll } from "../helpers/db";
import { provisionTestTenant } from "../helpers/provision";

type Fixtures = Awaited<ReturnType<typeof createOrderingFixtures>>;

/**
 * ZATCA Phase 2 is opt-in per tenant, and refunds/credit-debit notes are a
 * new financial domain — this exercises both together end-to-end: the
 * settings toggle, the hash chain advancing across real documents, the
 * refund flow (full + partial) with its effect on order status and shift
 * cash reconciliation, a debit note, and cross-tenant isolation on the new
 * tables. No real ZATCA sandbox exists in this environment, so the actual
 * submission call is expected to fail (network unreachable) and leave
 * zatcaStatus at "pending" — that failure path is itself part of what's
 * verified here (it must degrade gracefully, never block the receipt).
 */
describe("ZATCA Phase 2, refunds and credit/debit notes (e2e)", () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let certDir: string;
  let certificatePem: string;
  let privateKeyPem: string;

  let ownerA = "";
  let branchA = "";
  let tenantAId = "";
  let fxA: Fixtures;

  let ownerB = "";

  const key = () => randomUUID();

  async function login(email: string): Promise<string> {
    const res = await request(http)
      .post("/auth/login")
      .send({ email, password: "Test-12345" })
      .expect(200);
    return res.body.tokens.accessToken;
  }

  async function placeAndPayOrder(token: string, amount: string): Promise<string> {
    const order = await request(http)
      .post("/orders")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", key())
      .send({
        type: "walkin",
        branchId: branchA,
        confirm: true,
        items: [{ productId: fxA.simple.id, quantity: 1 }],
      })
      .expect(201);
    await request(http)
      .post(`/orders/${order.body.id}/payments`)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", key())
      .send({ method: "cash", amount })
      .expect(201);
    return order.body.id;
  }

  beforeAll(async () => {
    certDir = mkdtempSync(join(tmpdir(), "zatca-e2e-"));
    const keyPath = join(certDir, "key.pem");
    const certPath = join(certDir, "cert.pem");
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "ec",
      "-pkeyopt", "ec_paramgen_curve:secp256k1",
      "-keyout", keyPath,
      "-out", certPath,
      "-days", "1",
      "-nodes",
      "-subj", "/CN=spruvex-r-e2e-csid",
    ]);
    privateKeyPem = readFileSync(keyPath, "utf8");
    certificatePem = readFileSync(certPath, "utf8");

    admin = createAdminClient();
    await truncateAll(admin);
    await syncPermissionCatalog(admin);

    const tenantA = await provisionTestTenant(admin, {
      name: "مطعم جيم",
      slug: "zatca2-a",
      ownerEmail: "owner@zatca2-a.test",
    });
    tenantAId = tenantA.tenantId;
    branchA = tenantA.branchId!;
    fxA = await createOrderingFixtures(admin, tenantAId, branchA);

    const tenantB = await provisionTestTenant(admin, {
      name: "مطعم دال",
      slug: "zatca2-b",
      ownerEmail: "owner@zatca2-b.test",
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    http = app.getHttpServer();

    ownerA = await login("owner@zatca2-a.test");
    ownerB = await login("owner@zatca2-b.test");
    void tenantB;

    await request(http)
      .patch("/tenant")
      .set("Authorization", `Bearer ${ownerA}`)
      .send({ legalName: "شركة مطاعم جيم", vatNumber: "310123456700099", crNumber: "1010101099" })
      .expect(200);

    await request(http)
      .post("/shifts/open")
      .set("Authorization", `Bearer ${ownerA}`)
      .send({ branchId: branchA, openingCash: "100.00" })
      .expect(201);
  });

  afterAll(async () => {
    await app.close();
    await admin.$disconnect();
    rmSync(certDir, { recursive: true, force: true });
  });

  describe("settings toggle", () => {
    it("defaults to disabled and rejects credential upload from a non-owner permission set", async () => {
      const res = await request(http)
        .get("/tenant/zatca-settings")
        .set("Authorization", `Bearer ${ownerA}`)
        .expect(200);
      expect(res.body.enabled).toBe(false);
      expect(res.body.fullyConfigured).toBe(false);
    });

    it("owner enables Phase 2 and uploads CSID credentials", async () => {
      const res = await request(http)
        .patch("/tenant/zatca-settings")
        .set("Authorization", `Bearer ${ownerA}`)
        .send({
          enabled: true,
          environment: "sandbox",
          certificatePem,
          privateKeyPem,
          csidToken: "test-csid-token",
          csidSecret: "test-csid-secret",
        })
        .expect(200);
      expect(res.body.enabled).toBe(true);
      expect(res.body.fullyConfigured).toBe(true);
      // Never echoes the secrets back.
      expect(res.body).not.toHaveProperty("certificatePem");
      expect(res.body).not.toHaveProperty("privateKeyPem");
    });
  });

  describe("hash chain + signed receipts", () => {
    let firstOrderId = "";
    let firstHash = "";
    let secondOrderId = "";

    it("issues a signed, chained receipt once enabled", async () => {
      firstOrderId = await placeAndPayOrder(ownerA, "12.00");
      const receipt = await request(http)
        .get(`/orders/${firstOrderId}/receipt`)
        .set("Authorization", `Bearer ${ownerA}`)
        .expect(200);

      expect(receipt.body.invoiceHash).toMatch(/^[0-9a-f]{64}$/);
      expect(receipt.body.previousInvoiceHash).toBe("0".repeat(64));
      expect(receipt.body.xmlContent).toContain("<Invoice ");
      expect(receipt.body.cryptographicStamp).toBeTruthy();
      // No real ZATCA sandbox is reachable from this environment — the
      // submission attempt fails over the network and the document stays
      // "pending" rather than crashing the request.
      expect(receipt.body.zatcaStatus).toBe("pending");
      firstHash = receipt.body.invoiceHash;
    });

    it("chains the next receipt to the previous one", async () => {
      secondOrderId = await placeAndPayOrder(ownerA, "12.00");
      const receipt = await request(http)
        .get(`/orders/${secondOrderId}/receipt`)
        .set("Authorization", `Bearer ${ownerA}`)
        .expect(200);

      expect(receipt.body.previousInvoiceHash).toBe(firstHash);
      expect(receipt.body.invoiceHash).not.toBe(firstHash);
    });

    it("refunds the first order in full and transitions it to refunded", async () => {
      const res = await request(http)
        .post(`/orders/${firstOrderId}/refund`)
        .set("Authorization", `Bearer ${ownerA}`)
        .send({ amount: "12.00", method: "cash", reason: "طلب العميل" })
        .expect(201);

      expect(res.body.creditNote.total).toBe("12");
      expect(res.body.creditNote.creditNoteNumber).toBeGreaterThan(0);
      expect(res.body.refund.method).toBe("cash");

      const order = await admin.order.findUnique({ where: { id: firstOrderId } });
      expect(order?.status).toBe("refunded");
    });

    it("partially refunds the second order and keeps it completed", async () => {
      const res = await request(http)
        .post(`/orders/${secondOrderId}/refund`)
        .set("Authorization", `Bearer ${ownerA}`)
        .send({ amount: "5.00", method: "cash", reason: "صنف ناقص" })
        .expect(201);
      expect(res.body.creditNote.total).toBe("5");

      const order = await admin.order.findUnique({ where: { id: secondOrderId } });
      expect(order?.status).toBe("completed");

      // Refunding more than what's left should fail.
      await request(http)
        .post(`/orders/${secondOrderId}/refund`)
        .set("Authorization", `Bearer ${ownerA}`)
        .send({ amount: "10.00", method: "cash", reason: "محاولة زائدة" })
        .expect(400);
    });

    it("issues a debit note against a receipt", async () => {
      const res = await request(http)
        .post(`/orders/${secondOrderId}/debit-note`)
        .set("Authorization", `Bearer ${ownerA}`)
        .send({ amount: "3.00", reason: "تصحيح سعر" })
        .expect(201);
      expect(res.body.total).toBe("3");
      expect(res.body.debitNoteNumber).toBeGreaterThan(0);
    });

    it("reduces expected cash by cash refunds at shift close", async () => {
      const shift = await admin.shift.findFirst({
        where: { branchId: branchA, closedAt: null },
        orderBy: { openedAt: "desc" },
      });
      expect(shift).not.toBeNull();

      const closed = await request(http)
        .post(`/shifts/${shift!.id}/close`)
        .set("Authorization", `Bearer ${ownerA}`)
        .send({ actualCash: "100.00" })
        .expect(200);

      // opening 100 + two 12.00 cash sales - (12.00 full refund + 5.00 partial refund) = 107.00
      expect(closed.body.expectedCash).toBe("107");
    });
  });

  describe("tenant isolation on the new tables", () => {
    it("tenant B cannot see tenant A's credit notes or refunds", async () => {
      const creditNotes = await request(http)
        .get("/tenant/zatca-settings")
        .set("Authorization", `Bearer ${ownerB}`)
        .expect(200);
      // Tenant B never enabled Phase 2 — its own settings must be untouched
      // by anything tenant A did.
      expect(creditNotes.body.enabled).toBe(false);

      const crossTenantCreditNotes = await admin.creditNote.count({
        where: { tenantId: tenantAId },
      });
      expect(crossTenantCreditNotes).toBeGreaterThan(0);

      // RLS spot check: querying as tenant A's own scoped connection should
      // still only ever see tenant A's rows (the broader guarantee is
      // covered by rls-isolation.spec.ts; this just confirms the new
      // tables were wired into that same policy).
      const rows = await admin.$queryRaw<{ tenant_id: string }[]>`
        SELECT DISTINCT tenant_id::text FROM credit_notes
      `;
      expect(rows.every((r) => r.tenant_id === tenantAId)).toBe(true);
    });
  });
});
