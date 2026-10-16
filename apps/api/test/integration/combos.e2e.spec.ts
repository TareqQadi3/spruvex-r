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
 * Combo/bundle offers: a combo is a real Product marked isCombo with a
 * fixed set of real-product components. Ordering it expands into one
 * OrderItem per component (nothing downstream needs to know combos
 * exist), with the combo's own fixed price split across components
 * proportionally to their standalone prices — verified here against the
 * real API, not just the pricing math in isolation.
 */
describe("combos (e2e)", () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let http: ReturnType<INestApplication["getHttpServer"]>;

  let ownerToken = "";
  let branchId = "";
  let categoryId = "";
  let burgerId = "";
  let friesId = "";
  let drinkId = "";

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
      name: "مطعم الكومبو",
      slug: "combos-a",
      ownerEmail: "owner@combos-a.test",
    });
    branchId = tenant.branchId!;

    const category = await admin.category.create({
      data: { tenantId: tenant.tenantId, name: "الوجبات", nameEn: "Meals" },
    });
    categoryId = category.id;
    const burger = await admin.product.create({
      data: { tenantId: tenant.tenantId, categoryId, name: "برجر", nameEn: "Burger", basePrice: "20.00" },
    });
    const fries = await admin.product.create({
      data: { tenantId: tenant.tenantId, categoryId, name: "بطاطس", nameEn: "Fries", basePrice: "8.00" },
    });
    const drink = await admin.product.create({
      data: { tenantId: tenant.tenantId, categoryId, name: "مشروب", nameEn: "Drink", basePrice: "6.00" },
    });
    burgerId = burger.id;
    friesId = fries.id;
    drinkId = drink.id;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    http = app.getHttpServer();

    ownerToken = await login("owner@combos-a.test");
  });

  afterAll(async () => {
    await app.close();
  });

  it("rejects setting components before the product is marked isCombo", async () => {
    const combo = await request(http)
      .post("/catalog/products")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "وجبة قبل الكومبو", categoryId, basePrice: "25.00" })
      .expect(201);

    await request(http)
      .put(`/catalog/products/${combo.body.id}/combo-components`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ components: [{ componentProductId: burgerId }] })
      .expect(409);
  });

  it("rejects a combo including itself, and a combo including another combo", async () => {
    const combo = await request(http)
      .post("/catalog/products")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "وجبة ذاتية", categoryId, basePrice: "25.00", isCombo: true })
      .expect(201);

    await request(http)
      .put(`/catalog/products/${combo.body.id}/combo-components`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ components: [{ componentProductId: combo.body.id }] })
      .expect(400);

    const otherCombo = await request(http)
      .post("/catalog/products")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "وجبة أخرى", categoryId, basePrice: "15.00", isCombo: true })
      .expect(201);

    await request(http)
      .put(`/catalog/products/${combo.body.id}/combo-components`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ components: [{ componentProductId: otherCombo.body.id }] })
      .expect(400);
  });

  it("rejects marking a product as a combo once it's already used as someone else's component", async () => {
    const combo = await request(http)
      .post("/catalog/products")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "وجبة تحتوي برجر", categoryId, basePrice: "25.00", isCombo: true })
      .expect(201);
    await request(http)
      .put(`/catalog/products/${combo.body.id}/combo-components`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ components: [{ componentProductId: burgerId }] })
      .expect(200);

    await request(http)
      .patch(`/catalog/products/${burgerId}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ isCombo: true })
      .expect(409);
  });

  describe("ordering a combo", () => {
    let comboId = "";

    beforeAll(async () => {
      const combo = await request(http)
        .post("/catalog/products")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ name: "وجبة الغداء", categoryId, basePrice: "25.00", isCombo: true })
        .expect(201);
      comboId = combo.body.id;
      // Standalone prices sum to 34 (20 + 8 + 6); combo price is 25 — a real discount to split proportionally.
      await request(http)
        .put(`/catalog/products/${comboId}/combo-components`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          components: [
            { componentProductId: burgerId, quantity: 1 },
            { componentProductId: friesId, quantity: 1 },
            { componentProductId: drinkId, quantity: 1 },
          ],
        })
        .expect(200);
    });

    it("rejects ordering a combo with no components configured", async () => {
      const bare = await request(http)
        .post("/catalog/products")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ name: "وجبة فارغة", categoryId, basePrice: "10.00", isCombo: true })
        .expect(201);

      await request(http)
        .post("/orders")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", key())
        .send({ type: "walkin", branchId, items: [{ productId: bare.body.id, quantity: 1 }] })
        .expect(409);
    });

    it("rejects modifier selection on a combo line", async () => {
      await request(http)
        .post("/orders")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", key())
        .send({
          type: "walkin",
          branchId,
          items: [{ productId: comboId, quantity: 1, modifierIds: [randomUUID()] }],
        })
        .expect(400);
    });

    it("expands one combo line into one real OrderItem per component, price-split summing exactly to the combo price", async () => {
      const res = await request(http)
        .post("/orders")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", key())
        .send({ type: "walkin", branchId, items: [{ productId: comboId, quantity: 2 }] })
        .expect(201);

      expect(Number(res.body.subtotal)).toBeCloseTo(50, 2); // 25 * 2

      const order = await admin.order.findUniqueOrThrow({
        where: { id: res.body.id },
        include: { items: true },
      });
      expect(order.items).toHaveLength(3);
      const byProduct = new Map(order.items.map((i) => [i.productId, i]));

      expect(byProduct.get(burgerId)?.quantity).toBe(2);
      expect(byProduct.get(friesId)?.quantity).toBe(2);
      expect(byProduct.get(drinkId)?.quantity).toBe(2);

      const lineTotalSum = order.items.reduce((sum, i) => sum + Number(i.lineTotal), 0);
      expect(lineTotalSum).toBeCloseTo(50, 2);

      // Every component's snapshot names the combo it came from (POS/KDS/receipt grouping hint).
      for (const item of order.items) {
        const snapshot = item.productSnapshot as { comboParentName?: string };
        expect(snapshot.comboParentName).toBe("وجبة الغداء");
      }

      // Burger (20/34 of the standalone total) should get the largest share of the 50 SAR combo total.
      const burgerLine = byProduct.get(burgerId)!;
      const friesLine = byProduct.get(friesId)!;
      expect(Number(burgerLine.lineTotal)).toBeGreaterThan(Number(friesLine.lineTotal));
    });

    it("blocks the whole combo when one component is unavailable at this branch", async () => {
      await request(http)
        .put(`/catalog/products/${friesId}/branch-settings/${branchId}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ isAvailable: false })
        .expect(200);

      await request(http)
        .post("/orders")
        .set("Authorization", `Bearer ${ownerToken}`)
        .set("Idempotency-Key", key())
        .send({ type: "walkin", branchId, items: [{ productId: comboId, quantity: 1 }] })
        .expect(409);

      await request(http)
        .put(`/catalog/products/${friesId}/branch-settings/${branchId}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ isAvailable: true })
        .expect(200);
    });
  });
});
