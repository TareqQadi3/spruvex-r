import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaClient } from "@prisma/client";
import request from "supertest";

import { AppModule } from "../../src/app.module";
import { syncPermissionCatalog } from "../../src/modules/tenancy/tenant-provisioning";
import { createAdminClient, truncateAll } from "../helpers/db";
import { provisionTestTenant } from "../helpers/provision";

/**
 * Proactive reorder-alert notifications — the crossing-detection state
 * machine (IngredientReorderAlert) and its settings, NOT the actual Meta
 * WhatsApp HTTP call: there is no real WhatsApp connection in tests (same
 * as every other WhatsApp-triggering feature already in this codebase —
 * order_received, invoice_sent, etc. — none of them mock the Cloud API
 * call either), so WhatsappService.sendTemplate silently no-ops past the
 * "no active connection" check. What IS verified end-to-end here, against
 * the real database: the reorderLevel crossing fires exactly once per
 * dip (never repeats while still low), clears and can re-fire after a
 * genuine restock, the settings toggle defaults OFF and persists once
 * flipped, and the recipient number is read from Tenant.contactPhone
 * unchanged.
 */
describe("reorder-alert notifications: crossing detection & settings (e2e)", () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let http: ReturnType<INestApplication["getHttpServer"]>;

  let ownerA = "";
  let cashierA = ""; // no tenant.settings.manage
  let tenantAId = "";
  let branchA = "";
  let flourId = "";

  async function login(email: string): Promise<string> {
    const res = await request(http).post("/auth/login").send({ email, password: "Test-12345" }).expect(200);
    return res.body.tokens.accessToken;
  }

  function auditActions() {
    return admin.auditLog
      .findMany({
        where: { tenantId: tenantAId, entityType: "ingredient", entityId: flourId },
        orderBy: { createdAt: "asc" },
      })
      .then((rows) => rows.map((r) => r.action));
  }

  beforeAll(async () => {
    admin = createAdminClient();
    await truncateAll(admin);
    await syncPermissionCatalog(admin);

    const tenant = await provisionTestTenant(admin, {
      name: "مطعم تنبيهات الواتساب",
      slug: "reorder-whatsapp",
      ownerEmail: "owner@reorder-whatsapp.test",
    });
    tenantAId = tenant.tenantId;
    branchA = tenant.branchId!;

    const { hashPassword } = await import("../../src/modules/identity/password");
    const cashier = await admin.user.create({
      data: {
        email: "cashier@reorder-whatsapp.test",
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

    ownerA = await login("owner@reorder-whatsapp.test");
    cashierA = await login("cashier@reorder-whatsapp.test");

    const ingredient = await request(http)
      .post("/inventory/ingredients")
      .set("Authorization", `Bearer ${ownerA}`)
      .send({ name: "دقيق", nameEn: "Flour", unitType: "mass", reorderLevel: "1000" })
      .expect(201);
    flourId = ingredient.body.id;
  });

  afterAll(async () => {
    await app.close();
    await admin.$disconnect();
  });

  it("settings default to disabled, and the recipient number is the tenant's own registered contact phone", async () => {
    const res = await request(http)
      .get("/inventory/reorder-alerts/settings")
      .set("Authorization", `Bearer ${ownerA}`)
      .expect(200);
    expect(res.body.whatsappEnabled).toBe(false);
    expect(res.body.recipientPhone).toBeNull(); // provisionTestTenant never sets contactPhone

    await admin.tenant.update({ where: { id: tenantAId }, data: { contactPhone: "+966500000001" } });
    const after = await request(http)
      .get("/inventory/reorder-alerts/settings")
      .set("Authorization", `Bearer ${ownerA}`)
      .expect(200);
    expect(after.body.recipientPhone).toBe("+966500000001");
  });

  it("denies tenant.settings.manage to a role without it", async () => {
    await request(http).get("/inventory/reorder-alerts/settings").set("Authorization", `Bearer ${cashierA}`).expect(403);
    await request(http)
      .patch("/inventory/reorder-alerts/settings")
      .set("Authorization", `Bearer ${cashierA}`)
      .send({ whatsappEnabled: true })
      .expect(403);
  });

  it("enabling the toggle persists", async () => {
    const res = await request(http)
      .patch("/inventory/reorder-alerts/settings")
      .set("Authorization", `Bearer ${ownerA}`)
      .send({ whatsappEnabled: true })
      .expect(200);
    expect(res.body.whatsappEnabled).toBe(true);

    const reread = await request(http)
      .get("/inventory/reorder-alerts/settings")
      .set("Authorization", `Bearer ${ownerA}`)
      .expect(200);
    expect(reread.body.whatsappEnabled).toBe(true);
  });

  it("fires exactly once when stock first crosses at/below reorderLevel, never again while still low", async () => {
    // Stock the ingredient well above its 1000g threshold first.
    await request(http)
      .post("/inventory/stock/purchase")
      .set("Authorization", `Bearer ${ownerA}`)
      .send({ branchId: branchA, ingredientId: flourId, quantity: "2000", unitCost: "0.02" })
      .expect(201);
    let alert = await admin.ingredientReorderAlert.findUnique({
      where: { branchId_ingredientId: { branchId: branchA, ingredientId: flourId } },
    });
    expect(alert).toBeNull(); // still above threshold — no alert

    // Waste it down to 500g — crosses at/below 1000g for the first time.
    await request(http)
      .post("/inventory/stock/waste")
      .set("Authorization", `Bearer ${ownerA}`)
      .send({ branchId: branchA, ingredientId: flourId, quantity: "1500", reason: "test" })
      .expect(201);
    alert = await admin.ingredientReorderAlert.findUnique({
      where: { branchId_ingredientId: { branchId: branchA, ingredientId: flourId } },
    });
    expect(alert).not.toBeNull();
    const firstAlertedAt = alert!.alertedAt;

    // Waste MORE, still below threshold — must NOT re-create/re-trigger.
    await request(http)
      .post("/inventory/stock/waste")
      .set("Authorization", `Bearer ${ownerA}`)
      .send({ branchId: branchA, ingredientId: flourId, quantity: "100", reason: "test" })
      .expect(201);
    const stillSameAlert = await admin.ingredientReorderAlert.findUnique({
      where: { branchId_ingredientId: { branchId: branchA, ingredientId: flourId } },
    });
    expect(stillSameAlert!.alertedAt.getTime()).toBe(firstAlertedAt.getTime()); // same row, not recreated

    const actions = await auditActions();
    expect(actions.filter((a) => a === "ingredient.reorder_alert_triggered")).toHaveLength(1); // exactly once
  });

  it("clears when stock rises back above the threshold, and can re-fire on a later dip", async () => {
    // Restock well above 1000g — must clear the alert.
    await request(http)
      .post("/inventory/stock/purchase")
      .set("Authorization", `Bearer ${ownerA}`)
      .send({ branchId: branchA, ingredientId: flourId, quantity: "3000", unitCost: "0.02" })
      .expect(201);
    const cleared = await admin.ingredientReorderAlert.findUnique({
      where: { branchId_ingredientId: { branchId: branchA, ingredientId: flourId } },
    });
    expect(cleared).toBeNull();

    // Dip below the threshold again — must fire a SECOND, fresh alert.
    await request(http)
      .post("/inventory/stock/waste")
      .set("Authorization", `Bearer ${ownerA}`)
      .send({ branchId: branchA, ingredientId: flourId, quantity: "2600", reason: "test" })
      .expect(201);
    const refired = await admin.ingredientReorderAlert.findUnique({
      where: { branchId_ingredientId: { branchId: branchA, ingredientId: flourId } },
    });
    expect(refired).not.toBeNull();

    const actions = await auditActions();
    expect(actions.filter((a) => a === "ingredient.reorder_alert_triggered")).toHaveLength(2);
    expect(actions.filter((a) => a === "ingredient.reorder_alert_cleared")).toHaveLength(1);
  });
});
