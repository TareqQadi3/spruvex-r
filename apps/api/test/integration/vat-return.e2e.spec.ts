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
 * VAT return export — read-only, built from real Receipt/CreditNote/DebitNote
 * rows. Every number here is hand-computed independently of the service
 * under test (see the comments above each expectation) so this doubles as
 * the mandatory manual accuracy check, not just a snapshot of whatever the
 * code currently produces.
 *
 * Money model reminder: product prices are VAT-INCLUSIVE (gross). At 15%,
 * a 12.00 SAR sale contains vat = round(1200*15/115)/100 = 1.57 SAR and
 * net = 10.43 SAR (see shared/common/money.ts:vatFromGross). The same
 * formula applies to credit/debit note amounts, which are entered gross.
 */
describe("VAT return export (e2e)", () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let http: ReturnType<INestApplication["getHttpServer"]>;

  let ownerA = "";
  let viewOnlyA = ""; // reports.view but NOT reports.export
  let ownerC = ""; // unrelated tenant, isolation check
  let tenantAId = "";
  let branchA = "";
  let branchB = "";
  let fxA: Fixtures;

  let order1Id = "";
  let order2Id = "";
  let orderBId = "";
  let receipt1Number = 0;
  let receipt2Number = 0;
  let receiptBNumber = 0;

  const key = () => randomUUID();

  async function login(email: string): Promise<string> {
    const res = await request(http)
      .post("/auth/login")
      .send({ email, password: "Test-12345" })
      .expect(200);
    return res.body.tokens.accessToken;
  }

  async function placeAndPay(token: string, branchId: string, productId: string): Promise<string> {
    const order = await request(http)
      .post("/orders")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", key())
      .send({ type: "walkin", branchId, confirm: true, items: [{ productId, quantity: 1 }] })
      .expect(201);
    await request(http)
      .post(`/orders/${order.body.id}/payments`)
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", key())
      .send({ method: "cash", amount: order.body.total })
      .expect(201);
    return order.body.id;
  }

  beforeAll(async () => {
    admin = createAdminClient();
    await truncateAll(admin);
    await syncPermissionCatalog(admin);

    const tenantA = await provisionTestTenant(admin, {
      name: "مطعم الإقرار الضريبي",
      slug: "vat-a",
      ownerEmail: "owner@vat-a.test",
    });
    tenantAId = tenantA.tenantId;
    branchA = tenantA.branchId!;
    fxA = await createOrderingFixtures(admin, tenantAId, branchA);

    const branchBRow = await admin.branch.create({
      data: { tenantId: tenantAId, name: "الفرع الثاني", nameEn: "Second Branch", slug: "branch-b" },
    });
    branchB = branchBRow.id;

    const tenantC = await provisionTestTenant(admin, {
      name: "مطعم آخر",
      slug: "vat-c",
      ownerEmail: "owner@vat-c.test",
    });
    void tenantC;

    const { hashPassword } = await import("../../src/modules/identity/password");
    const viewOnlyUser = await admin.user.create({
      data: {
        email: "viewonly@vat-a.test",
        name: "View Only",
        passwordHash: await hashPassword("Test-12345"),
        emailVerifiedAt: new Date(),
      },
    });
    const reportsViewPermission = await admin.permission.findFirstOrThrow({
      where: { key: "reports.view" },
    });
    const viewOnlyRole = await admin.role.create({
      data: { tenantId: tenantAId, key: "reports-viewer", nameAr: "مشاهد التقارير", nameEn: "Reports Viewer" },
    });
    await admin.rolePermission.create({
      data: { tenantId: tenantAId, roleId: viewOnlyRole.id, permissionId: reportsViewPermission.id },
    });
    await admin.userRole.create({
      data: { tenantId: tenantAId, userId: viewOnlyUser.id, roleId: viewOnlyRole.id, branchId: null },
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    http = app.getHttpServer();

    ownerA = await login("owner@vat-a.test");
    ownerC = await login("owner@vat-c.test");
    viewOnlyA = await login("viewonly@vat-a.test");

    await request(http)
      .patch("/tenant")
      .set("Authorization", `Bearer ${ownerA}`)
      .send({
        legalName: "شركة الإقرار الضريبي التجريبية",
        vatNumber: "310987654300099",
        crNumber: "1010999999",
      })
      .expect(200);

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

    // Two 12.00 SAR sales on branch A, one 12.00 SAR sale on branch B.
    order1Id = await placeAndPay(ownerA, branchA, fxA.simple.id);
    order2Id = await placeAndPay(ownerA, branchA, fxA.simple.id);
    orderBId = await placeAndPay(ownerA, branchB, fxA.simple.id);

    const receipt1 = await request(http)
      .get(`/orders/${order1Id}/receipt`)
      .set("Authorization", `Bearer ${ownerA}`)
      .expect(200);
    receipt1Number = receipt1.body.receiptNumber;

    const receipt2 = await request(http)
      .get(`/orders/${order2Id}/receipt`)
      .set("Authorization", `Bearer ${ownerA}`)
      .expect(200);
    receipt2Number = receipt2.body.receiptNumber;

    const receiptB = await request(http)
      .get(`/orders/${orderBId}/receipt`)
      .set("Authorization", `Bearer ${ownerA}`)
      .expect(200);
    receiptBNumber = receiptB.body.receiptNumber;

    // Full refund of order 2 (credit note, 12.00 gross).
    await request(http)
      .post(`/orders/${order2Id}/refund`)
      .set("Authorization", `Bearer ${ownerA}`)
      .send({ amount: "12.00", method: "cash", reason: "طلب العميل" })
      .expect(201);

    // Debit note correcting order 1's receipt (3.00 gross extra owed).
    await request(http)
      .post(`/orders/${order1Id}/debit-note`)
      .set("Authorization", `Bearer ${ownerA}`)
      .send({ amount: "3.00", reason: "تصحيح سعر" })
      .expect(201);
  });

  afterAll(async () => {
    await app.close();
    await admin.$disconnect();
  });

  describe("permissions", () => {
    it("reports.view is enough for the JSON summary", async () => {
      await request(http)
        .get("/reports/vat-return")
        .set("Authorization", `Bearer ${viewOnlyA}`)
        .expect(200);
    });

    it("reports.export is required for CSV/PDF downloads, reports.view alone is not enough", async () => {
      await request(http)
        .get("/reports/vat-return.csv")
        .set("Authorization", `Bearer ${viewOnlyA}`)
        .expect(403);
      await request(http)
        .get("/reports/vat-return.pdf")
        .set("Authorization", `Bearer ${viewOnlyA}`)
        .expect(403);
    });

    it("owner (who has every permission) can download both formats", async () => {
      await request(http)
        .get("/reports/vat-return.csv")
        .set("Authorization", `Bearer ${ownerA}`)
        .expect(200);
      await request(http)
        .get("/reports/vat-return.pdf")
        .set("Authorization", `Bearer ${ownerA}`)
        .expect(200);
    });
  });

  describe("consolidated return (all branches, one VAT number)", () => {
    it("matches the hand-computed totals exactly", async () => {
      const res = await request(http)
        .get("/reports/vat-return")
        .set("Authorization", `Bearer ${ownerA}`)
        .expect(200);

      expect(res.body.tenant.vatNumber).toBe("310987654300099");
      expect(res.body.branch).toBeNull();

      const bucket = res.body.byRate.find((b: { vatRatePercent: string }) => b.vatRatePercent === "15");
      expect(bucket).toBeDefined();

      // 3 sales at 12.00 gross: net 10.43 + vat 1.57 each.
      expect(bucket.salesCount).toBe(3);
      expect(bucket.salesNet).toBe("31.29"); // 10.43 * 3
      expect(bucket.salesVat).toBe("4.71"); // 1.57 * 3

      // 1 full-refund credit note (12.00 gross -> net 10.43, vat 1.57).
      expect(bucket.creditNoteCount).toBe(1);
      expect(bucket.creditNoteNet).toBe("10.43");
      expect(bucket.creditNoteVat).toBe("1.57");

      // 1 debit note (3.00 gross -> net 2.61, vat 0.39).
      expect(bucket.debitNoteCount).toBe(1);
      expect(bucket.debitNoteNet).toBe("2.61");
      expect(bucket.debitNoteVat).toBe("0.39");

      // netTaxableSales = 31.29 - 10.43 + 2.61 = 23.47
      // netVat          =  4.71 -  1.57 + 0.39 =  3.53
      expect(bucket.netTaxableSales).toBe("23.47");
      expect(bucket.netVat).toBe("3.53");
      expect(res.body.totals.netTaxableSales).toBe("23.47");
      expect(res.body.totals.outputVat).toBe("3.53");
      expect(res.body.netVatDue).toBe("3.53");

      // No confirmed purchase invoices recorded in this test's period —
      // input VAT is a real, computed zero, not an "unsupported" placeholder.
      expect(res.body.inputTax.supported).toBe(true);
      expect(res.body.inputTax.vatAmount).toBe("0.00");
      expect(res.body.inputTax.invoiceCount).toBe(0);
      expect(typeof res.body.inputTax.note).toBe("string");

      // 3 sales + 1 credit note + 1 debit note = 5 traceable line items.
      expect(res.body.lineItems).toHaveLength(5);
    });

    it("carries a per-document traceability trail an accountant can audit", async () => {
      const res = await request(http)
        .get("/reports/vat-return")
        .set("Authorization", `Bearer ${ownerA}`)
        .expect(200);

      const sale1 = res.body.lineItems.find(
        (li: { type: string; documentNumber: number; branchName: string }) =>
          li.type === "sale" && li.documentNumber === receipt1Number && li.branchName === "الفرع الرئيسي",
      );
      expect(sale1).toBeDefined();

      const sale2 = res.body.lineItems.find(
        (li: { type: string; documentNumber: number }) => li.type === "sale" && li.documentNumber === receipt2Number,
      );
      expect(sale2).toBeDefined();

      const saleB = res.body.lineItems.find(
        (li: { type: string; branchName: string }) => li.type === "sale" && li.branchName === "الفرع الثاني",
      );
      expect(saleB).toBeDefined();
      expect(saleB.documentNumber).toBe(receiptBNumber);

      const creditNote = res.body.lineItems.find((li: { type: string }) => li.type === "credit_note");
      expect(creditNote.referenceReceiptNumber).toBe(receipt2Number);

      const debitNote = res.body.lineItems.find((li: { type: string }) => li.type === "debit_note");
      expect(debitNote.referenceReceiptNumber).toBe(receipt1Number);
    });
  });

  describe("branch filtering", () => {
    it("branch A alone: excludes branch B's sale but keeps its own credit/debit notes", async () => {
      const res = await request(http)
        .get(`/reports/vat-return?branchId=${branchA}`)
        .set("Authorization", `Bearer ${ownerA}`)
        .expect(200);

      expect(res.body.branch.id).toBe(branchA);
      const bucket = res.body.byRate.find((b: { vatRatePercent: string }) => b.vatRatePercent === "15");
      expect(bucket.salesCount).toBe(2);
      expect(bucket.salesNet).toBe("20.86"); // 10.43 * 2
      expect(bucket.netTaxableSales).toBe("13.04"); // 20.86 - 10.43 + 2.61
      expect(bucket.netVat).toBe("1.96"); // 3.14 - 1.57 + 0.39
    });

    it("branch B alone: just its one untouched sale, no notes", async () => {
      const res = await request(http)
        .get(`/reports/vat-return?branchId=${branchB}`)
        .set("Authorization", `Bearer ${ownerA}`)
        .expect(200);

      const bucket = res.body.byRate.find((b: { vatRatePercent: string }) => b.vatRatePercent === "15");
      expect(bucket.salesCount).toBe(1);
      expect(bucket.creditNoteCount).toBe(0);
      expect(bucket.debitNoteCount).toBe(0);
      expect(bucket.netTaxableSales).toBe("10.43");
      expect(bucket.netVat).toBe("1.57");
      expect(res.body.lineItems).toHaveLength(1);
    });
  });

  describe("CSV export", () => {
    it("opens as UTF-8 (BOM) and carries the same totals as the JSON summary", async () => {
      const res = await request(http)
        .get("/reports/vat-return.csv")
        .set("Authorization", `Bearer ${ownerA}`)
        .expect(200);

      expect(res.headers["content-type"]).toContain("text/csv");
      expect(res.headers["content-disposition"]).toContain("attachment");
      const body: string = res.text;
      expect(body.charCodeAt(0)).toBe(0xfeff); // UTF-8 BOM
      expect(body).toContain("23.47");
      expect(body).toContain("3.53");
      expect(body).toContain(String(receipt1Number));
      expect(body).toContain(String(receipt2Number));
    });
  });

  describe("PDF export", () => {
    it("renders without throwing despite Arabic tenant/branch names (standard fonts can't shape Arabic)", async () => {
      const res = await request(http)
        .get("/reports/vat-return.pdf")
        .set("Authorization", `Bearer ${ownerA}`)
        .expect(200);

      expect(res.headers["content-type"]).toContain("application/pdf");
      expect((res.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
    });
  });

  describe("tenant isolation", () => {
    it("an unrelated tenant sees an empty return, never tenant A's figures", async () => {
      const res = await request(http)
        .get("/reports/vat-return")
        .set("Authorization", `Bearer ${ownerC}`)
        .expect(200);
      expect(res.body.lineItems).toHaveLength(0);
      expect(res.body.totals.outputVat).toBe("0.00");
    });
  });
});
