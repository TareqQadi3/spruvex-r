import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaClient } from "@prisma/client";
import { createHmac } from "node:crypto";
import request from "supertest";

import { syncPermissionCatalog } from "../../src/modules/tenancy/tenant-provisioning";
import { AppModule } from "../../src/app.module";
import { createOrderingFixtures } from "../helpers/catalog-fixtures";
import { createAdminClient, truncateAll } from "../helpers/db";
import { provisionTestTenant } from "../helpers/provision";

type Fixtures = Awaited<ReturnType<typeof createOrderingFixtures>>;

describe("integrations (e2e)", () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let http: ReturnType<INestApplication["getHttpServer"]>;

  let ownerToken = "";
  let tenantId = "";
  let branchId = "";
  let fx: Fixtures;

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

    const tenant = await provisionTestTenant(admin, {
      name: "مطعم التكامل",
      slug: "integrations-test",
      ownerEmail: "owner@integrations-test.test",
    });
    tenantId = tenant.tenantId;
    branchId = tenant.branchId!;
    fx = await createOrderingFixtures(admin, tenantId, branchId);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
    http = app.getHttpServer();

    ownerToken = await login("owner@integrations-test.test");
  });

  afterAll(async () => {
    await app.close();
    await admin.$disconnect();
  });

  describe("connection CRUD", () => {
    it("creates a delivery connection, redacts the secret, and computes a webhook URL", async () => {
      const res = await request(http)
        .post("/integrations/connections/delivery_platform")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          provider: "hungerstation",
          branchId,
          isEnabled: true,
          config: { externalStoreId: "store-1" },
          secret: "api-key-123",
          webhookSecret: "whsec-abc",
        });
      expect([200, 201]).toContain(res.status);
      expect(res.body.hasSecret).toBe(true);
      expect(res.body.hasWebhookSecret).toBe(true);
      expect(res.body).not.toHaveProperty("secretEnc");
      expect(res.body).not.toHaveProperty("secret");
      expect(res.body).not.toHaveProperty("webhookSecretEnc");
      expect(res.body.webhookUrl).toContain(
        `/integrations/delivery/webhook/hungerstation/${res.body.id}`,
      );
    });

    it("rejects a provider that doesn't belong to the category", async () => {
      await request(http)
        .post("/integrations/connections/delivery_platform")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ provider: "moyasar", isEnabled: true })
        .expect(400);
    });

    it("rejects an unknown category", async () => {
      await request(http)
        .post("/integrations/connections/not_a_real_category")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ provider: "hungerstation" })
        .expect(400);
    });
  });

  describe("delivery-platform webhook (HungerStation)", () => {
    const webhookSecret = "test-webhook-secret";
    let connectionId = "";

    function sign(body: string): string {
      return createHmac("sha256", webhookSecret).update(body, "utf8").digest("hex");
    }

    beforeAll(async () => {
      const res = await request(http)
        .post("/integrations/connections/delivery_platform")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          provider: "hungerstation",
          branchId,
          isEnabled: true,
          config: { externalStoreId: "store-1" },
          secret: "api-key-123",
          webhookSecret,
        });
      connectionId = res.body.id;

      await request(http)
        .post("/integrations/delivery/mappings")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ connectionId, productId: fx.simple.id, externalItemId: "ext-juice" })
        .expect(201);
    });

    it("rejects a webhook with a bad signature", async () => {
      const body = JSON.stringify({ order_id: "hs-bad-sig", items: [{ item_id: "ext-juice", quantity: 1 }] });
      await request(http)
        .post(`/integrations/delivery/webhook/hungerstation/${connectionId}`)
        .set("Content-Type", "application/json")
        .set("x-hungerstation-signature", "0".repeat(64))
        .send(body)
        .expect(403);
    });

    it("creates a real order through the normal order pipeline, records an online payment, and completes it", async () => {
      const body = JSON.stringify({
        order_id: "hs-1001",
        items: [{ item_id: "ext-juice", quantity: 2 }],
        customer_name: "زبون هنقرستيشن",
        customer_phone: "+966500000001",
      });
      const res = await request(http)
        .post(`/integrations/delivery/webhook/hungerstation/${connectionId}`)
        .set("Content-Type", "application/json")
        .set("x-hungerstation-signature", sign(body))
        .send(body)
        .expect(200);
      expect(res.body).toEqual({ status: "accepted", order_id: "hs-1001" });

      const order = await admin.order.findFirst({ where: { externalOrderId: "hs-1001" } });
      expect(order).not.toBeNull();
      expect(order?.type).toBe("delivery");
      expect(order?.source).toBe("delivery");
      expect(order?.deliveryProvider).toBe("hungerstation");
      expect(order?.status).toBe("completed");
      expect(order?.customerPhone).toBe("+966500000001");

      const payment = await admin.payment.findFirst({ where: { orderId: order!.id } });
      expect(payment?.method).toBe("online");
      expect(payment?.reference).toBe("hungerstation:hs-1001");
      expect(payment?.amount.toString()).toBe(order!.total.toString());
    });

    it("is idempotent — a retried webhook with the same order_id never double-creates the order", async () => {
      const body = JSON.stringify({
        order_id: "hs-1001",
        items: [{ item_id: "ext-juice", quantity: 2 }],
      });
      await request(http)
        .post(`/integrations/delivery/webhook/hungerstation/${connectionId}`)
        .set("Content-Type", "application/json")
        .set("x-hungerstation-signature", sign(body))
        .send(body)
        .expect(200);

      const count = await admin.order.count({ where: { externalOrderId: "hs-1001" } });
      expect(count).toBe(1);
    });

    it("rejects a line item with no product mapping", async () => {
      const body = JSON.stringify({
        order_id: "hs-unmapped",
        items: [{ item_id: "no-such-mapping", quantity: 1 }],
      });
      await request(http)
        .post(`/integrations/delivery/webhook/hungerstation/${connectionId}`)
        .set("Content-Type", "application/json")
        .set("x-hungerstation-signature", sign(body))
        .send(body)
        .expect(409);

      expect(await admin.order.findFirst({ where: { externalOrderId: "hs-unmapped" } })).toBeNull();
    });

    it("rejects a malformed webhook body", async () => {
      const body = JSON.stringify({ order_id: "hs-malformed" }); // missing items[]
      await request(http)
        .post(`/integrations/delivery/webhook/hungerstation/${connectionId}`)
        .set("Content-Type", "application/json")
        .set("x-hungerstation-signature", sign(body))
        .send(body)
        .expect(400);
    });
  });
});
