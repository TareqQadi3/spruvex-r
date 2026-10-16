import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import request from "supertest";

import { AppModule } from "../../src/app.module";
import { syncPermissionCatalog } from "../../src/modules/tenancy/tenant-provisioning";
import { createAdminClient, truncateAll } from "../helpers/db";
import { provisionTestTenant } from "../helpers/provision";

describe("purchases: suppliers, purchase invoices & input VAT (e2e)", () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let http: ReturnType<INestApplication["getHttpServer"]>;

  let ownerA = "";
  let cashierA = "";
  let ownerB = "";
  let tenantAId = "";
  let branchA = "";
  let sugarId = "";
  let defaultLocationId = "";

  const key = () => randomUUID();

  async function login(email: string): Promise<string> {
    const res = await request(http)
      .post("/auth/login")
      .send({ email, password: "Test-12345" })
      .expect(200);
    return res.body.tokens.accessToken;
  }

  async function createSupplier(token: string, overrides: Record<string, unknown> = {}) {
    const res = await request(http)
      .post("/purchases/suppliers")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "مورد الخضار", nameEn: "Veg Supplier", ...overrides })
      .expect(201);
    return res.body.id as string;
  }

  beforeAll(async () => {
    admin = createAdminClient();
    await truncateAll(admin);
    await syncPermissionCatalog(admin);

    const tenantA = await provisionTestTenant(admin, {
      name: "مطعم المشتريات",
      slug: "purch-a",
      ownerEmail: "owner@purch-a.test",
    });
    tenantAId = tenantA.tenantId;
    branchA = tenantA.branchId!;
    await provisionTestTenant(admin, {
      name: "مطعم آخر",
      slug: "purch-b",
      ownerEmail: "owner@purch-b.test",
    });

    const { hashPassword } = await import("../../src/modules/identity/password");
    const cashier = await admin.user.create({
      data: {
        email: "cashier@purch-a.test",
        name: "Cashier A",
        passwordHash: await hashPassword("Test-12345"),
        emailVerifiedAt: new Date(),
      },
    });
    await admin.userRole.create({
      data: {
        tenantId: tenantAId,
        userId: cashier.id,
        roleId: tenantA.roleIdsByKey.cashier,
        branchId: branchA,
      },
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    http = app.getHttpServer();

    ownerA = await login("owner@purch-a.test");
    ownerB = await login("owner@purch-b.test");
    cashierA = await login("cashier@purch-a.test");

    const ingredient = await request(http)
      .post("/inventory/ingredients")
      .set("Authorization", `Bearer ${ownerA}`)
      .send({ name: "سكر", nameEn: "Sugar", unitType: "mass" })
      .expect(201);
    sugarId = ingredient.body.id;

    // The branch's default stock location is lazily created on first use —
    // force that here (via the existing manual purchase form) so tests below
    // can reference a real locationId.
    await request(http)
      .post("/inventory/stock/purchase")
      .set("Authorization", `Bearer ${ownerA}`)
      .send({ branchId: branchA, ingredientId: sugarId, quantity: "1", unitCost: "0.01" })
      .expect(201);
    const location = await admin.stockLocation.findFirstOrThrow({
      where: { tenantId: tenantAId, isDefault: true },
    });
    defaultLocationId = location.id;
  });

  afterAll(async () => {
    await app.close();
    await admin.$disconnect();
  });

  describe("suppliers", () => {
    it("cashier has neither purchases.create nor purchases.view by default", async () => {
      await request(http)
        .post("/purchases/suppliers")
        .set("Authorization", `Bearer ${cashierA}`)
        .send({ name: "x" })
        .expect(403);
      await request(http)
        .get("/purchases/suppliers")
        .set("Authorization", `Bearer ${cashierA}`)
        .expect(403);
    });

    it("creates, lists and updates a supplier (VAT number optional)", async () => {
      const res = await request(http)
        .post("/purchases/suppliers")
        .set("Authorization", `Bearer ${ownerA}`)
        .send({ name: "مورد الألبان", nameEn: "Dairy Supplier", contactPhone: "+966500000001" })
        .expect(201);
      expect(res.body.vatNumber).toBeNull();

      const list = await request(http)
        .get("/purchases/suppliers")
        .set("Authorization", `Bearer ${ownerA}`)
        .expect(200);
      expect(list.body.some((s: { id: string }) => s.id === res.body.id)).toBe(true);

      const updated = await request(http)
        .patch(`/purchases/suppliers/${res.body.id}`)
        .set("Authorization", `Bearer ${ownerA}`)
        .send({ vatNumber: "300000000000003" })
        .expect(200);
      expect(updated.body.vatNumber).toBe("300000000000003");
    });

    it("a different tenant cannot see tenant A's suppliers", async () => {
      const supplierId = await createSupplier(ownerA);
      await request(http)
        .get(`/purchases/suppliers/${supplierId}`)
        .set("Authorization", `Bearer ${ownerB}`)
        .expect(404);
    });
  });

  describe("purchase invoice: create, price, confirm", () => {
    it("prices lines net + VAT-on-top (opposite of POS gross pricing) and confirming posts real stock + expense", async () => {
      const supplierId = await createSupplier(ownerA, { name: "مورد رئيسي" });

      const created = await request(http)
        .post("/purchases/invoices")
        .set("Authorization", `Bearer ${ownerA}`)
        .send({
          supplierId,
          branchId: branchA,
          supplierInvoiceNumber: `INV-${key()}`,
          invoiceDate: "2026-06-15",
          items: [
            {
              description: "سكر - 100 كيلو",
              itemType: "stock",
              quantity: "100000", // grams
              unitPrice: "0.05", // SAR per gram, net
              vatRatePercent: "15",
              ingredientId: sugarId,
              locationId: defaultLocationId,
            },
            {
              description: "إيجار المستودع",
              itemType: "expense",
              quantity: "1",
              unitPrice: "1000",
              vatRatePercent: "15",
              expenseCategory: "rent",
            },
          ],
        })
        .expect(201);

      // stock line: 100000 * 0.05 = 5000 net, vat 750
      // expense line: 1 * 1000 = 1000 net, vat 150
      // (Decimal fields returned directly from Prisma print without trailing
      // zeros, same convention as every other create/detail endpoint in this
      // codebase — e.g. Order.total in ordering.e2e.spec.ts asserts "82" not
      // "82.00". Only report-style endpoints that hand-format via
      // halalasToSar(), like vat-return, produce a fixed 2-decimal string.)
      expect(created.body.status).toBe("draft");
      expect(created.body.subtotal).toBe("6000");
      expect(created.body.vatAmount).toBe("900");
      expect(created.body.total).toBe("6900");

      const stockItem = created.body.items.find((i: { itemType: string }) => i.itemType === "stock");
      const expenseItem = created.body.items.find((i: { itemType: string }) => i.itemType === "expense");
      expect(stockItem.lineTotal).toBe("5750");
      expect(expenseItem.lineTotal).toBe("1150");

      const priorAvgCost = (
        await admin.ingredient.findUniqueOrThrow({ where: { id: sugarId } })
      ).averageCost.toString();

      const confirmed = await request(http)
        .post(`/purchases/invoices/${created.body.id}/confirm`)
        .set("Authorization", `Bearer ${ownerA}`)
        .expect(201);
      expect(confirmed.body.status).toBe("confirmed");

      // Real stock receiving happened through the SAME mechanism the manual
      // form uses — moving-average cost actually changed.
      const ingredientAfter = await admin.ingredient.findUniqueOrThrow({ where: { id: sugarId } });
      expect(ingredientAfter.averageCost.toString()).not.toBe(priorAvgCost);

      const movement = await admin.stockMovement.findFirst({
        where: {
          tenantId: tenantAId,
          type: "purchase",
          referenceType: "purchase_invoice_item",
          referenceId: stockItem.id,
        },
      });
      expect(movement).not.toBeNull();
      expect(movement!.quantity.toString()).toBe("100000");

      // Real expense row, not a parallel accounting system.
      const expense = await admin.expense.findFirst({
        where: {
          tenantId: tenantAId,
          referenceType: "purchase_invoice_item",
          referenceId: expenseItem.id,
        },
      });
      expect(expense).not.toBeNull();
      expect(expense!.category).toBe("rent");
      expect(expense!.amount.toString()).toBe("1000");
      expect(expense!.vatAmount.toString()).toBe("150");
      expect(expense!.total.toString()).toBe("1150");
    });

    it("cannot confirm an invoice twice, and a concurrent double-confirm never double-posts stock/expense", async () => {
      const supplierId = await createSupplier(ownerA, { name: "مورد التزامن" });
      const created = await request(http)
        .post("/purchases/invoices")
        .set("Authorization", `Bearer ${ownerA}`)
        .send({
          supplierId,
          branchId: branchA,
          supplierInvoiceNumber: `INV-${key()}`,
          invoiceDate: "2026-06-16",
          items: [
            {
              description: "سكر",
              itemType: "stock",
              quantity: "1000",
              unitPrice: "0.10",
              ingredientId: sugarId,
              locationId: defaultLocationId,
            },
          ],
        })
        .expect(201);

      const [a, b] = await Promise.all([
        request(http)
          .post(`/purchases/invoices/${created.body.id}/confirm`)
          .set("Authorization", `Bearer ${ownerA}`),
        request(http)
          .post(`/purchases/invoices/${created.body.id}/confirm`)
          .set("Authorization", `Bearer ${ownerA}`),
      ]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([201, 409]);

      const movements = await admin.stockMovement.count({
        where: {
          tenantId: tenantAId,
          type: "purchase",
          referenceType: "purchase_invoice_item",
          referenceId: created.body.items[0].id,
        },
      });
      expect(movements).toBe(1);
    });

    it("supports confirm=true at creation time (single round trip)", async () => {
      const supplierId = await createSupplier(ownerA, { name: "مورد فوري" });
      const res = await request(http)
        .post("/purchases/invoices")
        .set("Authorization", `Bearer ${ownerA}`)
        .send({
          supplierId,
          branchId: branchA,
          supplierInvoiceNumber: `INV-${key()}`,
          invoiceDate: "2026-06-17",
          confirm: true,
          items: [{ description: "صيانة", itemType: "expense", quantity: "1", unitPrice: "200" }],
        })
        .expect(201);
      expect(res.body.status).toBe("confirmed");
    });

    it("refuses to enter the same supplier invoice number twice for the same supplier", async () => {
      const supplierId = await createSupplier(ownerA, { name: "مورد مكرر" });
      const number = `INV-${key()}`;
      const body = {
        supplierId,
        branchId: branchA,
        supplierInvoiceNumber: number,
        invoiceDate: "2026-06-18",
        items: [{ description: "صيانة", itemType: "expense", quantity: "1", unitPrice: "50" }],
      };
      await request(http).post("/purchases/invoices").set("Authorization", `Bearer ${ownerA}`).send(body).expect(201);
      await request(http).post("/purchases/invoices").set("Authorization", `Bearer ${ownerA}`).send(body).expect(409);
    });

    it("defaults the VAT rate per line from purchase settings when omitted", async () => {
      await request(http)
        .patch("/purchases/settings")
        .set("Authorization", `Bearer ${ownerA}`)
        .send({ defaultPurchaseVatRate: "5" })
        .expect(200);

      const supplierId = await createSupplier(ownerA, { name: "مورد بدون نسبة" });
      const res = await request(http)
        .post("/purchases/invoices")
        .set("Authorization", `Bearer ${ownerA}`)
        .send({
          supplierId,
          branchId: branchA,
          supplierInvoiceNumber: `INV-${key()}`,
          invoiceDate: "2026-06-19",
          items: [{ description: "صيانة", itemType: "expense", quantity: "1", unitPrice: "100" }],
        })
        .expect(201);
      expect(res.body.items[0].vatRatePercent).toBe("5");
      expect(res.body.vatAmount).toBe("5");

      // restore for other tests
      await request(http)
        .patch("/purchases/settings")
        .set("Authorization", `Bearer ${ownerA}`)
        .send({ defaultPurchaseVatRate: "15" })
        .expect(200);
    });
  });

  describe("cancelling", () => {
    it("cancelling a draft is a clean no-op — nothing was ever posted", async () => {
      const supplierId = await createSupplier(ownerA, { name: "مورد المسودة" });
      const created = await request(http)
        .post("/purchases/invoices")
        .set("Authorization", `Bearer ${ownerA}`)
        .send({
          supplierId,
          branchId: branchA,
          supplierInvoiceNumber: `INV-${key()}`,
          invoiceDate: "2026-06-20",
          items: [{ description: "صيانة", itemType: "expense", quantity: "1", unitPrice: "50" }],
        })
        .expect(201);

      await request(http)
        .post(`/purchases/invoices/${created.body.id}/cancel`)
        .set("Authorization", `Bearer ${cashierA}`)
        .send({ reason: "خطأ" })
        .expect(403); // cashier has neither purchases.void

      const cancelled = await request(http)
        .post(`/purchases/invoices/${created.body.id}/cancel`)
        .set("Authorization", `Bearer ${ownerA}`)
        .send({ reason: "خطأ إدخال" })
        .expect(201);
      expect(cancelled.body.status).toBe("cancelled");
    });

    it("cancelling an already-CONFIRMED invoice stops it counting as input VAT AND posts a real reversal — the original expense row is never edited, but a negative counter-entry cancels it out", async () => {
      const supplierId = await createSupplier(ownerA, { name: "مورد الإلغاء بعد التأكيد" });
      const created = await request(http)
        .post("/purchases/invoices")
        .set("Authorization", `Bearer ${ownerA}`)
        .send({
          supplierId,
          branchId: branchA,
          supplierInvoiceNumber: `INV-${key()}`,
          invoiceDate: "2026-06-21",
          confirm: true,
          items: [{ description: "صيانة", itemType: "expense", quantity: "1", unitPrice: "80", vatRatePercent: "15" }],
        })
        .expect(201);
      const expenseItemId = created.body.items[0].id;

      const cancelled = await request(http)
        .post(`/purchases/invoices/${created.body.id}/cancel`)
        .set("Authorization", `Bearer ${ownerA}`)
        .send({ reason: "تراجع بعد التأكيد" })
        .expect(201);
      expect(cancelled.body.status).toBe("cancelled");

      // The original posting is untouched — never edited, never deleted.
      const originalExpense = await admin.expense.findFirst({
        where: { tenantId: tenantAId, referenceType: "purchase_invoice_item", referenceId: expenseItemId },
      });
      expect(originalExpense).not.toBeNull();
      expect(originalExpense!.amount.toString()).toBe("80");

      // A real negative counter-entry now exists too, netting the impact to zero.
      const allExpensesForItem = await admin.expense.findMany({ where: { tenantId: tenantAId } });
      const reversalExpense = allExpensesForItem.find((e) => Number(e.amount) < 0);
      expect(reversalExpense).toBeDefined();
      expect(reversalExpense!.amount.toString()).toBe("-80");
      expect(reversalExpense!.vatAmount.toString()).toBe("-12");
      expect(reversalExpense!.total.toString()).toBe("-92");

      const vat = await request(http)
        .get("/reports/vat-return")
        .query({ branchId: branchA, from: "2026-06-21", to: "2026-06-21" })
        .set("Authorization", `Bearer ${ownerA}`)
        .expect(200);
      expect(vat.body.inputTax.invoiceCount).toBe(0); // excluded once cancelled
    });

    it("cancelling a confirmed STOCK invoice posts a real negative stock movement and un-blends the average cost", async () => {
      const supplierId = await createSupplier(ownerA, { name: "مورد عكس المخزون" });
      // Seed a distinct prior purchase so blending is meaningfully testable:
      // 1000g @ 0.05 already in stock from the very first beforeAll purchase.
      const before = await admin.ingredient.findUniqueOrThrow({ where: { id: sugarId } });
      const levelBefore = await admin.stockLevel.findUniqueOrThrow({
        where: { locationId_ingredientId: { locationId: defaultLocationId, ingredientId: sugarId } },
      });

      const created = await request(http)
        .post("/purchases/invoices")
        .set("Authorization", `Bearer ${ownerA}`)
        .send({
          supplierId,
          branchId: branchA,
          supplierInvoiceNumber: `INV-${key()}`,
          invoiceDate: "2026-06-22",
          confirm: true,
          items: [
            {
              description: "سكر إضافي",
              itemType: "stock",
              quantity: "500",
              unitPrice: "0.20",
              ingredientId: sugarId,
              locationId: defaultLocationId,
            },
          ],
        })
        .expect(201);
      const afterPurchase = await admin.ingredient.findUniqueOrThrow({ where: { id: sugarId } });
      expect(afterPurchase.averageCost.toString()).not.toBe(before.averageCost.toString());

      await request(http)
        .post(`/purchases/invoices/${created.body.id}/cancel`)
        .set("Authorization", `Bearer ${ownerA}`)
        .send({ reason: "خطأ بالكمية" })
        .expect(201);

      const reversalMovement = await admin.stockMovement.findFirst({
        where: { tenantId: tenantAId, type: "purchase_reversal", referenceType: "purchase_invoice_reversal_item" },
        orderBy: { createdAt: "desc" },
      });
      expect(reversalMovement).not.toBeNull();
      expect(reversalMovement!.quantity.toString()).toBe("-500");

      // Stock level exactly back to what it was before this purchase.
      const levelAfter = await admin.stockLevel.findUniqueOrThrow({
        where: { locationId_ingredientId: { locationId: defaultLocationId, ingredientId: sugarId } },
      });
      expect(levelAfter.quantity.toString()).toBe(levelBefore.quantity.toString());

      // Average cost un-blended back to exactly what it was before this purchase.
      const afterReversal = await admin.ingredient.findUniqueOrThrow({ where: { id: sugarId } });
      expect(afterReversal.averageCost.toString()).toBe(before.averageCost.toString());
    });

    it("refuses to cancel a confirmed invoice when the location no longer holds enough stock to reverse, and leaves the invoice untouched", async () => {
      // A fresh, isolated ingredient — starts at exactly 0 stock, so the
      // scenario below ("only 5 remain of the 50 received") is deterministic
      // regardless of what other tests in this file did to sugarId's level.
      const freshIngredient = await request(http)
        .post("/inventory/ingredients")
        .set("Authorization", `Bearer ${ownerA}`)
        .send({ name: `مكوّن ${key()}`, unitType: "mass" })
        .expect(201);
      const freshIngredientId = freshIngredient.body.id as string;

      const supplierId = await createSupplier(ownerA, { name: "مورد نفاد المخزون" });
      const created = await request(http)
        .post("/purchases/invoices")
        .set("Authorization", `Bearer ${ownerA}`)
        .send({
          supplierId,
          branchId: branchA,
          supplierInvoiceNumber: `INV-${key()}`,
          invoiceDate: "2026-06-23",
          confirm: true,
          items: [
            {
              description: "سكر سينفد",
              itemType: "stock",
              quantity: "50",
              unitPrice: "0.10",
              ingredientId: freshIngredientId,
              locationId: defaultLocationId,
            },
          ],
        })
        .expect(201);

      // Consume most of what was just received via a real waste movement,
      // simulating "it was already used" — only 5 of the 50 units remain.
      await request(http)
        .post("/inventory/stock/waste")
        .set("Authorization", `Bearer ${ownerA}`)
        .send({ branchId: branchA, ingredientId: freshIngredientId, locationId: defaultLocationId, quantity: "45", reason: "اختبار" })
        .expect(201);

      const res = await request(http)
        .post(`/purchases/invoices/${created.body.id}/cancel`)
        .set("Authorization", `Bearer ${ownerA}`)
        .send({ reason: "محاولة إلغاء" })
        .expect(409);
      expect(res.body.message).toMatch(/5/); // available
      expect(res.body.message).toMatch(/50/); // requested

      // Nothing changed — the invoice is still confirmed, no reversal posted.
      const stillConfirmed = await admin.purchaseInvoice.findUniqueOrThrow({ where: { id: created.body.id } });
      expect(stillConfirmed.status).toBe("confirmed");
      const reversalCount = await admin.purchaseInvoiceReversal.count({
        where: { purchaseInvoiceId: created.body.id },
      });
      expect(reversalCount).toBe(0);
    });

    it("cannot cancel the same confirmed invoice twice concurrently — one succeeds, one gets a clean 409, only one reversal is posted", async () => {
      const supplierId = await createSupplier(ownerA, { name: "مورد تزامن الإلغاء" });
      const created = await request(http)
        .post("/purchases/invoices")
        .set("Authorization", `Bearer ${ownerA}`)
        .send({
          supplierId,
          branchId: branchA,
          supplierInvoiceNumber: `INV-${key()}`,
          invoiceDate: "2026-06-24",
          confirm: true,
          items: [{ description: "صيانة", itemType: "expense", quantity: "1", unitPrice: "60" }],
        })
        .expect(201);

      const [a, b] = await Promise.all([
        request(http)
          .post(`/purchases/invoices/${created.body.id}/cancel`)
          .set("Authorization", `Bearer ${ownerA}`)
          .send({ reason: "محاولة أولى" }),
        request(http)
          .post(`/purchases/invoices/${created.body.id}/cancel`)
          .set("Authorization", `Bearer ${ownerA}`)
          .send({ reason: "محاولة ثانية" }),
      ]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([201, 409]);

      const reversalCount = await admin.purchaseInvoiceReversal.count({
        where: { purchaseInvoiceId: created.body.id },
      });
      expect(reversalCount).toBe(1);
    });

    it("exposes the reversal and its resolved stock/expense movements on the invoice detail endpoint for full traceability", async () => {
      const supplierId = await createSupplier(ownerA, { name: "مورد أثر التتبع" });
      const created = await request(http)
        .post("/purchases/invoices")
        .set("Authorization", `Bearer ${ownerA}`)
        .send({
          supplierId,
          branchId: branchA,
          supplierInvoiceNumber: `INV-${key()}`,
          invoiceDate: "2026-06-25",
          confirm: true,
          items: [{ description: "صيانة", itemType: "expense", quantity: "1", unitPrice: "40" }],
        })
        .expect(201);

      await request(http)
        .post(`/purchases/invoices/${created.body.id}/cancel`)
        .set("Authorization", `Bearer ${ownerA}`)
        .send({ reason: "تتبع" })
        .expect(201);

      const detail = await request(http)
        .get(`/purchases/invoices/${created.body.id}`)
        .set("Authorization", `Bearer ${ownerA}`)
        .expect(200);
      expect(detail.body.reversals).toHaveLength(1);
      expect(detail.body.reversals[0].reversalType).toBe("cancellation");
      expect(detail.body.reversals[0].reason).toBe("تتبع");
      expect(detail.body.reversals[0].items).toHaveLength(1);
      expect(detail.body.reversals[0].items[0].expense).not.toBeNull();
      expect(detail.body.reversals[0].items[0].expense.amount).toBe("-40");
      expect(detail.body.reversals[0].items[0].stockMovement).toBeNull();
    });
  });

  describe("VAT return integration (input tax)", () => {
    it("counts only CONFIRMED invoices in the period, excludes draft and cancelled", async () => {
      const supplierId = await createSupplier(ownerA, { name: "مورد إقرار الضريبة" });

      // confirmed — counts
      await request(http)
        .post("/purchases/invoices")
        .set("Authorization", `Bearer ${ownerA}`)
        .send({
          supplierId,
          branchId: branchA,
          supplierInvoiceNumber: `INV-${key()}`,
          invoiceDate: "2026-07-10",
          confirm: true,
          items: [{ description: "توريد", itemType: "expense", quantity: "1", unitPrice: "1000", vatRatePercent: "15" }],
        })
        .expect(201);

      // draft — must NOT count
      await request(http)
        .post("/purchases/invoices")
        .set("Authorization", `Bearer ${ownerA}`)
        .send({
          supplierId,
          branchId: branchA,
          supplierInvoiceNumber: `INV-${key()}`,
          invoiceDate: "2026-07-11",
          items: [{ description: "توريد آخر", itemType: "expense", quantity: "1", unitPrice: "2000", vatRatePercent: "15" }],
        })
        .expect(201);

      const res = await request(http)
        .get("/reports/vat-return")
        .query({ branchId: branchA, from: "2026-07-01", to: "2026-07-31" })
        .set("Authorization", `Bearer ${ownerA}`)
        .expect(200);

      expect(res.body.inputTax.supported).toBe(true);
      expect(res.body.inputTax.invoiceCount).toBe(1);
      expect(res.body.inputTax.netAmount).toBe("1000.00");
      expect(res.body.inputTax.vatAmount).toBe("150.00");

      const purchaseLine = res.body.lineItems.find((li: { type: string }) => li.type === "purchase");
      expect(purchaseLine).toBeDefined();
      expect(purchaseLine.supplierName).toBe("مورد إقرار الضريبة");
      expect(purchaseLine.netAmount).toBe("1000.00");

      // netVatDue = outputVat (0, no sales in this period) - inputVat (150.00) = -150.00 -> refund position
      expect(res.body.netVatDue).toBe("-150.00");
    });
  });

  describe("private attachment", () => {
    it("uploads and downloads an invoice attachment through the gated route, never the public /uploads/ route", async () => {
      const supplierId = await createSupplier(ownerA, { name: "مورد المرفقات" });
      const created = await request(http)
        .post("/purchases/invoices")
        .set("Authorization", `Bearer ${ownerA}`)
        .send({
          supplierId,
          branchId: branchA,
          supplierInvoiceNumber: `INV-${key()}`,
          invoiceDate: "2026-06-25",
          items: [{ description: "صيانة", itemType: "expense", quantity: "1", unitPrice: "10" }],
        })
        .expect(201);

      const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      await request(http)
        .post(`/purchases/invoices/${created.body.id}/attachment`)
        .set("Authorization", `Bearer ${ownerA}`)
        .attach("file", fakePng, { filename: "invoice.png", contentType: "image/png" })
        .expect(201);

      const download = await request(http)
        .get(`/purchases/invoices/${created.body.id}/attachment`)
        .set("Authorization", `Bearer ${ownerA}`)
        .expect(200);
      expect(Buffer.compare(download.body, fakePng)).toBe(0);
      expect(download.headers["content-type"]).toContain("image/png");

      // Another tenant can never reach it, even knowing the invoice id.
      await request(http)
        .get(`/purchases/invoices/${created.body.id}/attachment`)
        .set("Authorization", `Bearer ${ownerB}`)
        .expect(404);
    });
  });
});
