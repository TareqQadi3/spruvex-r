import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import request from "supertest";

import { AppModule } from "../../src/app.module";
import { syncPermissionCatalog } from "../../src/modules/tenancy/tenant-provisioning";
import { createAdminClient, truncateAll } from "../helpers/db";
import { setupUnits } from "../helpers/inventory-fixtures";
import { provisionTestTenant } from "../helpers/provision";

/**
 * Menu profitability report — hand-computed against a scenario built to
 * exercise every requirement: a genuinely profitable item, a LOSS-making
 * item (negative margin, the exact case the report exists to surface), an
 * item with no recipe at all, a branch-specific price override, and one
 * cancelled order that must never count.
 *
 * Ingredient "دقيق" (flour) is fixed at 0.02 SAR/g (no purchases needed —
 * averageCost is set directly, same shortcut reports.e2e.spec.ts uses).
 *
 * Products (basePrice, recipe, cost):
 *   برجر  (Burger): 20.00 SAR, 300g flour  -> cost 6.00 SAR -> margin 14.00 (70.00%)
 *   خسارة (Loss):   5.00 SAR, 300g flour  -> cost 6.00 SAR -> margin -1.00 (-20.00%)
 *   عصير  (Juice, no recipe): 8.00 SAR -> cost 0.00 -> margin 8.00 (100.00%), hasRecipe=false
 *
 * Branch A (main): sells 3x Burger + 1x Loss (completed), 2x Juice
 *   (completed), and a SEPARATE order of 5x Burger that gets CANCELLED
 *   (must be excluded entirely).
 * Branch B: has a price override on Burger (18.00 SAR instead of 20.00,
 *   so its margin there is 18-6=12.00, 66.67%) and sells 1x Burger only.
 *
 * Combined (no branch filter) quantitySold: Burger 4, Loss 1, Juice 2.
 * Combined totalContributionMargin (basePrice-based, since no single branch
 * selected): Burger 14.00*4=56.00, Juice 8.00*2=16.00, Loss -1.00*1=-1.00.
 * Expected default sort: Burger, Juice, Loss (loss-making item sinks to the bottom).
 */
describe("menu profitability report (e2e)", () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let http: ReturnType<INestApplication["getHttpServer"]>;

  let ownerA = "";
  let cashierA = ""; // no reports.view / reports.export
  let tenantAId = "";
  let branchA = "";
  let branchB = "";
  let burgerId = "";
  let lossId = "";
  let juiceId = "";

  const key = () => randomUUID();

  async function login(email: string): Promise<string> {
    const res = await request(http).post("/auth/login").send({ email, password: "Test-12345" }).expect(200);
    return res.body.tokens.accessToken;
  }

  async function newOrder(branchId: string, items: Array<Record<string, unknown>>) {
    const res = await request(http)
      .post("/orders")
      .set("Authorization", `Bearer ${ownerA}`)
      .set("Idempotency-Key", key())
      .send({ type: "walkin", branchId, confirm: true, items })
      .expect(201);
    return res.body as { id: string; total: string };
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
    const units = await setupUnits(admin);

    const tenant = await provisionTestTenant(admin, {
      name: "مطعم ربحية القائمة",
      slug: "menu-profit",
      ownerEmail: "owner@menu-profit.test",
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
        email: "cashier@menu-profit.test",
        name: "Cashier",
        passwordHash: await hashPassword("Test-12345"),
        emailVerifiedAt: new Date(),
      },
    });
    await admin.userRole.create({
      data: { tenantId: tenantAId, userId: cashier.id, roleId: tenant.roleIdsByKey.cashier, branchId: branchA },
    });

    const category = await admin.category.create({ data: { tenantId: tenantAId, name: "الرئيسي", nameEn: "Main" } });
    const flour = await admin.ingredient.create({
      data: { tenantId: tenantAId, name: "دقيق", nameEn: "Flour", unitType: "mass", averageCost: "0.02" },
    });

    const burger = await admin.product.create({
      data: { tenantId: tenantAId, categoryId: category.id, name: "برجر", nameEn: "Burger", basePrice: "20.00" },
    });
    burgerId = burger.id;
    await admin.recipeItem.create({
      data: { tenantId: tenantAId, productId: burger.id, ingredientId: flour.id, unitId: units.gram.id, quantity: "300" },
    });

    const loss = await admin.product.create({
      data: { tenantId: tenantAId, categoryId: category.id, name: "خسارة", nameEn: "Loss Item", basePrice: "5.00" },
    });
    lossId = loss.id;
    await admin.recipeItem.create({
      data: { tenantId: tenantAId, productId: loss.id, ingredientId: flour.id, unitId: units.gram.id, quantity: "300" },
    });

    const juice = await admin.product.create({
      data: { tenantId: tenantAId, categoryId: category.id, name: "عصير", nameEn: "Juice", basePrice: "8.00" },
    });
    juiceId = juice.id;
    // Deliberately no recipe for juice — hasRecipe must come back false, cost "0.0000".

    // Branch B overrides the Burger's price to 18.00 SAR.
    await admin.productBranchSetting.create({
      data: { tenantId: tenantAId, productId: burger.id, branchId: branchB, priceOverride: "18.00" },
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    http = app.getHttpServer();

    ownerA = await login("owner@menu-profit.test");
    cashierA = await login("cashier@menu-profit.test");

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

    // Branch A: 3x Burger + 1x Loss (completed).
    const orderA1 = await newOrder(branchA, [
      { productId: burgerId, quantity: 3 },
      { productId: lossId, quantity: 1 },
    ]);
    await payInFull(orderA1.id, orderA1.total);

    // Branch A: 2x Juice (completed, separate order).
    const orderA2 = await newOrder(branchA, [{ productId: juiceId, quantity: 2 }]);
    await payInFull(orderA2.id, orderA2.total);

    // Branch A: 5x Burger, then CANCELLED — must never count.
    const cancelled = await newOrder(branchA, [{ productId: burgerId, quantity: 5 }]);
    await request(http)
      .post(`/orders/${cancelled.id}/status`)
      .set("Authorization", `Bearer ${ownerA}`)
      .send({ status: "cancelled", reason: "test" })
      .expect(200);

    // Branch B: 1x Burger at its overridden 18.00 SAR price (completed).
    const orderB1 = await newOrder(branchB, [{ productId: burgerId, quantity: 1 }]);
    await payInFull(orderB1.id, orderB1.total);
  });

  afterAll(async () => {
    await app.close();
    await admin.$disconnect();
  });

  it("denies reports.view/reports.export to a role without them", async () => {
    await request(http).get("/reports/menu-profitability").set("Authorization", `Bearer ${cashierA}`).expect(403);
    await request(http)
      .get("/reports/menu-profitability.csv")
      .set("Authorization", `Bearer ${cashierA}`)
      .expect(403);
  });

  it("combines all branches, excludes the cancelled order, and sorts loss-makers to the bottom", async () => {
    const res = await request(http)
      .get("/reports/menu-profitability")
      .set("Authorization", `Bearer ${ownerA}`)
      .expect(200);

    expect(res.body.branch).toBeNull();
    const rows = res.body.rows as Array<Record<string, unknown>>;
    const byId = new Map(rows.map((r) => [r.productId, r]));

    const burger = byId.get(burgerId)!;
    expect(burger.hasRecipe).toBe(true);
    expect(burger.cost).toBe("6.0000");
    expect(burger.sellingPrice).toBe("20"); // no single branch selected -> tenant basePrice (Decimal.toString() strips trailing zeros)
    expect(burger.grossMargin).toBe("14.00");
    expect(burger.grossMarginPercent).toBe("70.00");
    expect(burger.quantitySold).toBe(4); // 3 (branch A) + 1 (branch B) — the cancelled 5 never counted
    expect(burger.totalContributionMargin).toBe("56.00");

    const loss = byId.get(lossId)!;
    expect(loss.grossMargin).toBe("-1.00");
    expect(loss.grossMarginPercent).toBe("-20.00");
    expect(loss.quantitySold).toBe(1);
    expect(loss.totalContributionMargin).toBe("-1.00");

    const juice = byId.get(juiceId)!;
    expect(juice.hasRecipe).toBe(false);
    expect(juice.cost).toBe("0.0000");
    expect(juice.grossMargin).toBe("8.00");
    expect(juice.quantitySold).toBe(2);
    expect(juice.totalContributionMargin).toBe("16.00");

    // Default sort: highest total contribution margin first, the loss-maker last.
    const order = rows.map((r) => r.productId);
    expect(order.indexOf(burgerId)).toBeLessThan(order.indexOf(juiceId));
    expect(order.indexOf(juiceId)).toBeLessThan(order.indexOf(lossId));
  });

  it("filters by branch and applies that branch's price override", async () => {
    const resA = await request(http)
      .get(`/reports/menu-profitability?branchId=${branchA}`)
      .set("Authorization", `Bearer ${ownerA}`)
      .expect(200);
    const rowsA = new Map((resA.body.rows as Array<Record<string, unknown>>).map((r) => [r.productId, r]));
    expect(rowsA.get(burgerId)!.sellingPrice).toBe("20"); // no override in branch A
    expect(rowsA.get(burgerId)!.quantitySold).toBe(3);
    expect(rowsA.get(lossId)!.quantitySold).toBe(1);
    expect(rowsA.get(juiceId)!.quantitySold).toBe(2);

    const resB = await request(http)
      .get(`/reports/menu-profitability?branchId=${branchB}`)
      .set("Authorization", `Bearer ${ownerA}`)
      .expect(200);
    const rowsB = new Map((resB.body.rows as Array<Record<string, unknown>>).map((r) => [r.productId, r]));
    const burgerB = rowsB.get(burgerId)!;
    expect(burgerB.sellingPrice).toBe("18"); // branch B override
    expect(burgerB.grossMargin).toBe("12.00"); // 18.00 - 6.00
    expect(burgerB.grossMarginPercent).toBe("66.67");
    expect(burgerB.quantitySold).toBe(1);
    expect(burgerB.totalContributionMargin).toBe("12.00");
    expect(rowsB.get(lossId)!.quantitySold).toBe(0); // never sold in branch B
    expect(rowsB.get(lossId)!.totalContributionMargin).toBe("0.00");
  });

  it("exports the same figures as CSV", async () => {
    const res = await request(http)
      .get("/reports/menu-profitability.csv")
      .set("Authorization", `Bearer ${ownerA}`)
      .expect(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    const csv = res.text;
    expect(csv).toContain("برجر");
    expect(csv).toContain("14.00");
    expect(csv).toContain("56.00");
    expect(csv).toContain("خسارة");
    expect(csv).toContain("-1.00");
  });

  it("404s for an unknown branch", async () => {
    await request(http)
      .get(`/reports/menu-profitability?branchId=${randomUUID()}`)
      .set("Authorization", `Bearer ${ownerA}`)
      .expect(404);
  });
});
