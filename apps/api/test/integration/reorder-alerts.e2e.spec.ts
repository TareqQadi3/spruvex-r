import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import request from "supertest";

import { AppModule } from "../../src/app.module";
import { syncPermissionCatalog } from "../../src/modules/tenancy/tenant-provisioning";
import { createAdminClient, truncateAll } from "../helpers/db";
import { provisionTestTenant } from "../helpers/provision";

/**
 * Reorder alerts — hand-computed scenario:
 *
 *   دقيق (Flour): reorderLevel 1000g, stock 300g -> ratio 0.30 (MOST critical)
 *   أرز   (Rice):  reorderLevel 500g,  stock 490g -> ratio 0.98 (less critical, still included)
 *   سكر   (Sugar): reorderLevel 200g,  stock 250g -> ABOVE threshold, must be EXCLUDED
 *   ملح   (Salt):  no reorderLevel set at all      -> must be EXCLUDED regardless of stock
 *
 * Flour's purchase history: an older CONFIRMED invoice from Supplier X, a
 * newer CONFIRMED invoice from Supplier Y (must win as "last supplier"), a
 * still-later DRAFT invoice from Supplier Z (must be ignored — never
 * confirmed), and an even-later CANCELLED invoice from Supplier W (must
 * also be ignored). Rice has one CONFIRMED purchase, from Supplier X only.
 */
describe("reorder alerts (e2e)", () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let http: ReturnType<INestApplication["getHttpServer"]>;

  let ownerA = "";
  let cashierA = ""; // no inventory.view
  let tenantAId = "";
  let branchA = "";
  let branchB = "";
  let flourId = "";
  let riceId = "";
  let sugarId = "";
  let saltId = "";
  let supplierYId = "";
  let defaultLocationId = "";

  const key = () => randomUUID();

  async function login(email: string): Promise<string> {
    const res = await request(http).post("/auth/login").send({ email, password: "Test-12345" }).expect(200);
    return res.body.tokens.accessToken;
  }

  async function createSupplier(name: string) {
    const res = await request(http)
      .post("/purchases/suppliers")
      .set("Authorization", `Bearer ${ownerA}`)
      .send({ name })
      .expect(201);
    return res.body.id as string;
  }

  async function createInvoice(
    supplierId: string,
    invoiceDate: string,
    ingredientId: string,
    quantity: string,
    unitPrice: string,
    branchId: string,
  ) {
    const res = await request(http)
      .post("/purchases/invoices")
      .set("Authorization", `Bearer ${ownerA}`)
      .send({
        supplierId,
        branchId,
        supplierInvoiceNumber: `INV-${key()}`,
        invoiceDate,
        items: [
          {
            description: "test line",
            itemType: "stock",
            quantity,
            unitPrice,
            ingredientId,
            locationId: defaultLocationId,
          },
        ],
      })
      .expect(201);
    return res.body.id as string;
  }

  async function confirmInvoice(id: string) {
    await request(http).post(`/purchases/invoices/${id}/confirm`).set("Authorization", `Bearer ${ownerA}`).expect(201);
  }

  beforeAll(async () => {
    admin = createAdminClient();
    await truncateAll(admin);
    await syncPermissionCatalog(admin);

    const tenant = await provisionTestTenant(admin, {
      name: "مطعم تنبيهات المخزون",
      slug: "reorder-alerts",
      ownerEmail: "owner@reorder-alerts.test",
    });
    tenantAId = tenant.tenantId;
    branchA = tenant.branchId!;

    const branchBRow = await admin.branch.create({
      data: { tenantId: tenantAId, name: "الفرع الثاني", nameEn: "Second Branch", slug: "second-branch" },
    });
    branchB = branchBRow.id;

    const { hashPassword } = await import("../../src/modules/identity/password");
    const cashier = await admin.user.create({
      data: {
        email: "cashier@reorder-alerts.test",
        name: "Cashier",
        passwordHash: await hashPassword("Test-12345"),
        emailVerifiedAt: new Date(),
      },
    });
    await admin.userRole.create({
      data: { tenantId: tenantAId, userId: cashier.id, roleId: tenant.roleIdsByKey.cashier, branchId: branchA },
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    http = app.getHttpServer();

    ownerA = await login("owner@reorder-alerts.test");
    cashierA = await login("cashier@reorder-alerts.test");

    async function makeIngredient(name: string, nameEn: string, reorderLevel: string | undefined) {
      const res = await request(http)
        .post("/inventory/ingredients")
        .set("Authorization", `Bearer ${ownerA}`)
        .send({ name, nameEn, unitType: "mass", ...(reorderLevel ? { reorderLevel } : {}) })
        .expect(201);
      return res.body.id as string;
    }

    flourId = await makeIngredient("دقيق", "Flour", "1000");
    riceId = await makeIngredient("أرز", "Rice", "500");
    sugarId = await makeIngredient("سكر", "Sugar", "200");
    saltId = await makeIngredient("ملح", "Salt", undefined);

    // Force the default stock location into existence.
    await request(http)
      .post("/inventory/stock/purchase")
      .set("Authorization", `Bearer ${ownerA}`)
      .send({ branchId: branchA, ingredientId: flourId, quantity: "1", unitCost: "0.01" })
      .expect(201);
    const location = await admin.stockLocation.findFirstOrThrow({ where: { tenantId: tenantAId, isDefault: true } });
    defaultLocationId = location.id;

    const supplierX = await createSupplier("المورّد الأول");
    supplierYId = await createSupplier("المورّد الثاني");
    const supplierZ = await createSupplier("المورّد الثالث (مسودة فقط)");
    const supplierW = await createSupplier("المورّد الرابع (ملغى)");

    // Flour: X (older, confirmed) -> Y (newer, confirmed, must win) -> Z (draft, ignored) -> W (cancelled, ignored).
    // Confirming DOES post real stock (same as the manual form) — the exact
    // resulting balance doesn't matter here, since every ingredient's final
    // on-hand quantity is set explicitly below via a physical-count adjustment.
    await confirmInvoice(await createInvoice(supplierX, "2026-01-01", flourId, "500", "0.10", branchA));
    await confirmInvoice(await createInvoice(supplierYId, "2026-06-01", flourId, "300", "0.12", branchA));
    await createInvoice(supplierZ, "2026-07-01", flourId, "200", "0.20", branchA); // left as draft
    const cancelled = await createInvoice(supplierW, "2026-08-01", flourId, "999", "0.99", branchA);
    await request(http)
      .post(`/purchases/invoices/${cancelled}/cancel`)
      .set("Authorization", `Bearer ${ownerA}`)
      .send({ reason: "test" })
      .expect(201);

    // Rice: only Supplier X.
    await confirmInvoice(await createInvoice(supplierX, "2026-03-01", riceId, "100", "0.20", branchA));

    // Now fix every ingredient's on-hand balance at branch A to its exact
    // target for the alert scenario, via a physical-count adjustment (sets
    // the absolute quantity, unlike the additive purchase/confirm calls above).
    for (const [ingredientId, countedQuantity] of [
      [flourId, "300"],
      [riceId, "490"],
      [sugarId, "250"],
      [saltId, "10"],
    ] as const) {
      await request(http)
        .post("/inventory/stock/adjustment")
        .set("Authorization", `Bearer ${ownerA}`)
        .send({ branchId: branchA, ingredientId, countedQuantity, reason: "test setup" })
        .expect(201);
    }

    // Branch B: Flour also below its own threshold there, to prove branch filtering.
    await request(http)
      .post("/inventory/stock/purchase")
      .set("Authorization", `Bearer ${ownerA}`)
      .send({ branchId: branchB, ingredientId: flourId, quantity: "50", unitCost: "0.01" })
      .expect(201);
  });

  afterAll(async () => {
    await app.close();
    await admin.$disconnect();
  });

  it("denies inventory.view to a role without it", async () => {
    await request(http).get("/inventory/reorder-alerts").set("Authorization", `Bearer ${cashierA}`).expect(403);
  });

  it("includes only ingredients at/below their reorderLevel, sorted most-critical (lowest ratio) first", async () => {
    const res = await request(http)
      .get(`/inventory/reorder-alerts?branchId=${branchA}`)
      .set("Authorization", `Bearer ${ownerA}`)
      .expect(200);

    const rows = res.body as Array<Record<string, unknown>>;
    const ids = rows.map((r) => r.ingredientId);
    expect(ids).toContain(flourId);
    expect(ids).toContain(riceId);
    expect(ids).not.toContain(sugarId); // above threshold
    expect(ids).not.toContain(saltId); // no reorderLevel set

    // Flour (ratio 0.30) must sort before Rice (ratio 0.98).
    expect(ids.indexOf(flourId)).toBeLessThan(ids.indexOf(riceId));

    const flour = rows.find((r) => r.ingredientId === flourId)!;
    expect(flour.currentQuantity).toBe("300");
    expect(flour.reorderLevel).toBe("1000");
    expect(flour.suggestedQuantity).toBe("700.000"); // 1000 - 300
    const flourSupplier = flour.lastSupplier as Record<string, unknown>;
    expect(flourSupplier.id).toBe(supplierYId); // newest CONFIRMED wins, draft/cancelled ignored
    expect(flourSupplier.lastUnitPrice).toBe("0.12");
    expect(flourSupplier.lastPurchasedAt).toBe("2026-06-01");

    const rice = rows.find((r) => r.ingredientId === riceId)!;
    expect(rice.currentQuantity).toBe("490");
    expect(rice.suggestedQuantity).toBe("10.000"); // 500 - 490
    expect((rice.lastSupplier as Record<string, unknown>).name).toBe("المورّد الأول");
  });

  it("filters by branch — branch B's own (lower) flour stock does not leak into branch A's row and vice versa", async () => {
    const resA = await request(http)
      .get(`/inventory/reorder-alerts?branchId=${branchA}`)
      .set("Authorization", `Bearer ${ownerA}`)
      .expect(200);
    const flourA = (resA.body as Array<Record<string, unknown>>).find((r) => r.ingredientId === flourId)!;
    expect(flourA.currentQuantity).toBe("300");
    expect(flourA.branchId).toBe(branchA);

    const resB = await request(http)
      .get(`/inventory/reorder-alerts?branchId=${branchB}`)
      .set("Authorization", `Bearer ${ownerA}`)
      .expect(200);
    const rowsB = resB.body as Array<Record<string, unknown>>;
    expect(rowsB).toHaveLength(1); // only flour was stocked in branch B
    expect(rowsB[0].currentQuantity).toBe("50");
    expect(rowsB[0].branchId).toBe(branchB);
  });

  it("composes with the existing purchase-invoice creation endpoint (no new business logic) to place a real draft order", async () => {
    const alerts = await request(http)
      .get(`/inventory/reorder-alerts?branchId=${branchA}`)
      .set("Authorization", `Bearer ${ownerA}`)
      .expect(200);
    const flour = (alerts.body as Array<Record<string, unknown>>).find((r) => r.ingredientId === flourId)!;
    const supplier = flour.lastSupplier as Record<string, unknown>;

    const draft = await request(http)
      .post("/purchases/invoices")
      .set("Authorization", `Bearer ${ownerA}`)
      .send({
        supplierId: supplier.id,
        branchId: branchA,
        supplierInvoiceNumber: `REORDER-${key()}`,
        invoiceDate: "2026-08-31",
        items: [
          {
            description: "إعادة طلب دقيق",
            itemType: "stock",
            quantity: flour.suggestedQuantity,
            unitPrice: supplier.lastUnitPrice,
            ingredientId: flourId,
          },
        ],
      })
      .expect(201);

    expect(draft.body.status).toBe("draft");
    expect(draft.body.items[0].quantity).toBe("700");
  });
});
