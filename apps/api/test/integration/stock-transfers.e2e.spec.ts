import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaClient } from "@prisma/client";
import request from "supertest";

import { AppModule } from "../../src/app.module";
import { hashPassword } from "../../src/modules/identity/password";
import { syncPermissionCatalog } from "../../src/modules/tenancy/tenant-provisioning";
import { createAdminClient, truncateAll } from "../helpers/db";
import { provisionTestTenant } from "../helpers/provision";

/**
 * Inter-branch stock transfers — the full state machine (draft -> sent ->
 * received/rejected, or draft -> cancelled), the "in transit" invariant
 * (goods counted at NEITHER branch while sent), partial receipt with
 * mandatory discrepancy reason, and the creator/receiver permission split.
 */
describe("stock transfers (e2e)", () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let http: ReturnType<INestApplication["getHttpServer"]>;

  let tenantId = "";
  let branchA = ""; // source
  let branchB = ""; // destination
  let ownerToken = "";
  let senderToken = ""; // inventory.transfer.create only
  let receiverToken = ""; // inventory.transfer.receive only
  let riceId = "";

  async function login(email: string): Promise<string> {
    const res = await request(http).post("/auth/login").send({ email, password: "Test-12345" }).expect(200);
    return res.body.tokens.accessToken;
  }

  async function grantSingle(roleKey: string, permissionKey: string, email: string): Promise<string> {
    const permission = await admin.permission.findUniqueOrThrow({ where: { key: permissionKey } });
    const role = await admin.role.create({
      data: { tenantId, key: roleKey, nameAr: roleKey, nameEn: roleKey, isSystem: false, createdBy: null },
    });
    await admin.rolePermission.create({ data: { tenantId, roleId: role.id, permissionId: permission.id } });
    const user = await admin.user.create({
      data: { email, name: roleKey, passwordHash: await hashPassword("Test-12345"), emailVerifiedAt: new Date() },
    });
    await admin.userRole.create({ data: { tenantId, userId: user.id, roleId: role.id, branchId: null } });
    return login(email);
  }

  async function stockLevel(locationLikeBranchId: string, ingredientId: string): Promise<number> {
    const level = await admin.stockLevel.findFirst({
      where: { branchId: locationLikeBranchId, ingredientId },
    });
    return level ? Number(level.quantity) : 0;
  }

  beforeAll(async () => {
    admin = createAdminClient();
    await truncateAll(admin);
    await syncPermissionCatalog(admin);

    const tenant = await provisionTestTenant(admin, {
      name: "مطعم تحويل المخزون",
      slug: "stock-transfers",
      ownerEmail: "owner@stock-transfers.test",
    });
    tenantId = tenant.tenantId;
    branchA = tenant.branchId!;

    const branchBRow = await admin.branch.create({
      data: { tenantId, name: "الفرع الثاني", nameEn: "Second Branch", slug: "second-branch" },
    });
    branchB = branchBRow.id;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    http = app.getHttpServer();

    ownerToken = await login("owner@stock-transfers.test");
    senderToken = await grantSingle("sender-role", "inventory.transfer.create", "sender@stock-transfers.test");
    receiverToken = await grantSingle("receiver-role", "inventory.transfer.receive", "receiver@stock-transfers.test");

    const ingredient = await request(http)
      .post("/inventory/ingredients")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "أرز", nameEn: "Rice", unitType: "mass" })
      .expect(201);
    riceId = ingredient.body.id;

    // Stock branch A with 1000g @ 0.10 SAR/g so averageCost is well-defined.
    await request(http)
      .post("/inventory/stock/purchase")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ branchId: branchA, ingredientId: riceId, quantity: "1000", unitCost: "0.10" })
      .expect(201);
  });

  afterAll(async () => {
    await app.close();
    await admin.$disconnect();
  });

  it("rejects a transfer to the same branch", async () => {
    await request(http)
      .post("/inventory/transfers")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ fromBranchId: branchA, toBranchId: branchA, items: [{ ingredientId: riceId, quantity: "10" }] })
      .expect(400);
  });

  it("a receive-only user cannot create; a create-only user can", async () => {
    await request(http)
      .post("/inventory/transfers")
      .set("Authorization", `Bearer ${receiverToken}`)
      .send({ fromBranchId: branchA, toBranchId: branchB, items: [{ ingredientId: riceId, quantity: "10" }] })
      .expect(403);

    const res = await request(http)
      .post("/inventory/transfers")
      .set("Authorization", `Bearer ${senderToken}`)
      .send({ fromBranchId: branchA, toBranchId: branchB, items: [{ ingredientId: riceId, quantity: "10" }] })
      .expect(201);
    expect(res.body.status).toBe("draft");
    // Cancel it right away — this was only to prove the permission split.
    await request(http)
      .post(`/inventory/transfers/${res.body.id}/cancel`)
      .set("Authorization", `Bearer ${senderToken}`)
      .send({ reason: "permission check only" })
      .expect(201);
  });

  describe("full lifecycle: create -> send -> receive", () => {
    let transferId = "";
    let itemId = "";

    it("creates a draft with no stock effect at all", async () => {
      const before = await stockLevel(branchA, riceId);
      const res = await request(http)
        .post("/inventory/transfers")
        .set("Authorization", `Bearer ${senderToken}`)
        .send({
          fromBranchId: branchA,
          toBranchId: branchB,
          notes: "تحويل تجريبي",
          items: [{ ingredientId: riceId, quantity: "300" }],
        })
        .expect(201);
      transferId = res.body.id;
      itemId = res.body.items[0].id;
      expect(res.body.status).toBe("draft");
      expect(res.body.items[0].sentQuantity).toBe("300");
      expect(res.body.items[0].unitCostAtSend).toBeNull();

      const after = await stockLevel(branchA, riceId);
      expect(after).toBe(before); // untouched — draft posts nothing
      expect(await stockLevel(branchB, riceId)).toBe(0);
    });

    it("send() decrements the source branch and freezes unitCostAtSend — destination still sees nothing", async () => {
      const before = await stockLevel(branchA, riceId);
      const res = await request(http)
        .post(`/inventory/transfers/${transferId}/send`)
        .set("Authorization", `Bearer ${senderToken}`)
        .expect(201);
      expect(res.body.status).toBe("sent");
      expect(res.body.items[0].unitCostAtSend).toBe("0.1");

      expect(await stockLevel(branchA, riceId)).toBe(before - 300);
      // The core invariant: in transit, counted at NEITHER branch.
      expect(await stockLevel(branchB, riceId)).toBe(0);

      const movement = await admin.stockMovement.findFirst({
        where: { type: "transfer_out", referenceType: "stock_transfer_item_send", referenceId: itemId },
      });
      expect(movement).not.toBeNull();
      expect(movement!.quantity.toString()).toBe("-300");
    });

    it("a receive-only user's request 403s for send/cancel; a create-only user's request 403s for receive", async () => {
      // (transfer is already sent at this point in the describe block)
      await request(http)
        .post(`/inventory/transfers/${transferId}/receive`)
        .set("Authorization", `Bearer ${senderToken}`)
        .send({ items: [{ stockTransferItemId: itemId, receivedQuantity: "300" }] })
        .expect(403);
    });

    it("sending again 409s — already sent", async () => {
      await request(http)
        .post(`/inventory/transfers/${transferId}/send`)
        .set("Authorization", `Bearer ${senderToken}`)
        .expect(409);
    });

    it("rejects a receive that omits an item", async () => {
      await request(http)
        .post(`/inventory/transfers/${transferId}/receive`)
        .set("Authorization", `Bearer ${receiverToken}`)
        .send({ items: [] })
        .expect(400);
    });

    it("receive() with the full quantity credits the destination and blends average cost consistently", async () => {
      const res = await request(http)
        .post(`/inventory/transfers/${transferId}/receive`)
        .set("Authorization", `Bearer ${receiverToken}`)
        .send({ items: [{ stockTransferItemId: itemId, receivedQuantity: "300" }] })
        .expect(201);
      expect(res.body.status).toBe("received");
      expect(res.body.items[0].receivedQuantity).toBe("300");
      expect(res.body.items[0].discrepancyReason).toBeNull();

      expect(await stockLevel(branchB, riceId)).toBe(300);

      // Moving a known-cost ingredient between locations must not distort
      // the tenant-wide average cost — receiving at branch B's own average
      // (0 prior there) blends to exactly the frozen unitCostAtSend.
      const ingredient = await admin.ingredient.findUniqueOrThrow({ where: { id: riceId } });
      expect(ingredient.averageCost.toString()).toBe("0.1");

      const movement = await admin.stockMovement.findFirst({
        where: { type: "transfer_in", referenceType: "stock_transfer_item_receive", referenceId: itemId },
      });
      expect(movement).not.toBeNull();
      expect(movement!.quantity.toString()).toBe("300");
      expect(movement!.unitCost!.toString()).toBe("0.1");
    });

    it("receiving again 409s — already received", async () => {
      await request(http)
        .post(`/inventory/transfers/${transferId}/receive`)
        .set("Authorization", `Bearer ${receiverToken}`)
        .send({ items: [{ stockTransferItemId: itemId, receivedQuantity: "300" }] })
        .expect(409);
    });

    it("audits every transition with the right branch and action", async () => {
      const actions = await admin.auditLog.findMany({
        where: { tenantId, entityType: "stock_transfer", entityId: transferId },
        orderBy: { createdAt: "asc" },
      });
      expect(actions.map((a) => a.action)).toEqual([
        "stock_transfer.created",
        "stock_transfer.sent",
        "stock_transfer.received",
      ]);
      expect(actions[0].branchId).toBe(branchA);
      expect(actions[2].branchId).toBe(branchB);
    });
  });

  describe("insufficient stock at send", () => {
    it("refuses to send more than the source branch has, and posts nothing", async () => {
      const available = await stockLevel(branchA, riceId);
      const created = await request(http)
        .post("/inventory/transfers")
        .set("Authorization", `Bearer ${senderToken}`)
        .send({
          fromBranchId: branchA,
          toBranchId: branchB,
          items: [{ ingredientId: riceId, quantity: String(available + 1000) }],
        })
        .expect(201);

      const before = await stockLevel(branchA, riceId);
      await request(http)
        .post(`/inventory/transfers/${created.body.id}/send`)
        .set("Authorization", `Bearer ${senderToken}`)
        .expect(409);
      expect(await stockLevel(branchA, riceId)).toBe(before); // unchanged — refused outright, not partially posted

      const reloaded = await admin.stockTransfer.findUniqueOrThrow({ where: { id: created.body.id } });
      expect(reloaded.status).toBe("draft"); // never flipped to sent
    });
  });

  describe("partial receipt with mandatory discrepancy reason", () => {
    let transferId = "";
    let itemId = "";

    beforeAll(async () => {
      const created = await request(http)
        .post("/inventory/transfers")
        .set("Authorization", `Bearer ${senderToken}`)
        .send({ fromBranchId: branchA, toBranchId: branchB, items: [{ ingredientId: riceId, quantity: "200" }] })
        .expect(201);
      transferId = created.body.id;
      itemId = created.body.items[0].id;
      await request(http)
        .post(`/inventory/transfers/${transferId}/send`)
        .set("Authorization", `Bearer ${senderToken}`)
        .expect(201);
    });

    it("rejects a short receive with no reason", async () => {
      await request(http)
        .post(`/inventory/transfers/${transferId}/receive`)
        .set("Authorization", `Bearer ${receiverToken}`)
        .send({ items: [{ stockTransferItemId: itemId, receivedQuantity: "150" }] })
        .expect(400);
    });

    it("accepts a short receive once a reason is given, and the shortfall is never posted anywhere", async () => {
      const branchBBefore = await stockLevel(branchB, riceId);
      const res = await request(http)
        .post(`/inventory/transfers/${transferId}/receive`)
        .set("Authorization", `Bearer ${receiverToken}`)
        .send({
          items: [
            { stockTransferItemId: itemId, receivedQuantity: "150", discrepancyReason: "تلف أثناء النقل" },
          ],
        })
        .expect(201);
      expect(res.body.status).toBe("received");
      expect(res.body.items[0].receivedQuantity).toBe("150");
      expect(res.body.items[0].discrepancyReason).toBe("تلف أثناء النقل");

      // Only the actually-received 150 landed at branch B — the 50-unit
      // shortfall is a genuine loss, not fabricated into any movement.
      expect(await stockLevel(branchB, riceId)).toBe(branchBBefore + 150);
      const shortfallMovement = await admin.stockMovement.findFirst({
        where: { referenceType: "stock_transfer_item_receive", referenceId: itemId, quantity: "50.000" },
      });
      expect(shortfallMovement).toBeNull();
    });
  });

  describe("rejection returns stock to the source branch", () => {
    it("reject() restores exactly the pre-send stock and average cost at the origin", async () => {
      const before = await stockLevel(branchA, riceId);
      const created = await request(http)
        .post("/inventory/transfers")
        .set("Authorization", `Bearer ${senderToken}`)
        .send({ fromBranchId: branchA, toBranchId: branchB, items: [{ ingredientId: riceId, quantity: "100" }] })
        .expect(201);
      await request(http)
        .post(`/inventory/transfers/${created.body.id}/send`)
        .set("Authorization", `Bearer ${senderToken}`)
        .expect(201);
      expect(await stockLevel(branchA, riceId)).toBe(before - 100);

      await request(http)
        .post(`/inventory/transfers/${created.body.id}/reject`)
        .set("Authorization", `Bearer ${receiverToken}`)
        .send({ reason: "أصناف غير مطابقة" })
        .expect(201);

      expect(await stockLevel(branchA, riceId)).toBe(before); // fully restored
      const reloaded = await admin.stockTransfer.findUniqueOrThrow({ where: { id: created.body.id } });
      expect(reloaded.status).toBe("rejected");
      expect(reloaded.rejectReason).toBe("أصناف غير مطابقة");
    });

    it("requires a reason to reject", async () => {
      const created = await request(http)
        .post("/inventory/transfers")
        .set("Authorization", `Bearer ${senderToken}`)
        .send({ fromBranchId: branchA, toBranchId: branchB, items: [{ ingredientId: riceId, quantity: "10" }] })
        .expect(201);
      await request(http)
        .post(`/inventory/transfers/${created.body.id}/send`)
        .set("Authorization", `Bearer ${senderToken}`)
        .expect(201);
      await request(http)
        .post(`/inventory/transfers/${created.body.id}/reject`)
        .set("Authorization", `Bearer ${receiverToken}`)
        .send({})
        .expect(400);
      // Clean up: reject it properly so it doesn't leave stock stranded in transit.
      await request(http)
        .post(`/inventory/transfers/${created.body.id}/reject`)
        .set("Authorization", `Bearer ${receiverToken}`)
        .send({ reason: "cleanup" })
        .expect(201);
    });
  });

  describe("cancel only works on a draft", () => {
    it("cancels a draft cleanly, with no stock effect", async () => {
      const before = await stockLevel(branchA, riceId);
      const created = await request(http)
        .post("/inventory/transfers")
        .set("Authorization", `Bearer ${senderToken}`)
        .send({ fromBranchId: branchA, toBranchId: branchB, items: [{ ingredientId: riceId, quantity: "5" }] })
        .expect(201);
      const res = await request(http)
        .post(`/inventory/transfers/${created.body.id}/cancel`)
        .set("Authorization", `Bearer ${senderToken}`)
        .send({ reason: "غيّرنا رأينا" })
        .expect(201);
      expect(res.body.status).toBe("cancelled");
      expect(await stockLevel(branchA, riceId)).toBe(before);
    });

    it("refuses to cancel a sent transfer", async () => {
      const created = await request(http)
        .post("/inventory/transfers")
        .set("Authorization", `Bearer ${senderToken}`)
        .send({ fromBranchId: branchA, toBranchId: branchB, items: [{ ingredientId: riceId, quantity: "5" }] })
        .expect(201);
      await request(http)
        .post(`/inventory/transfers/${created.body.id}/send`)
        .set("Authorization", `Bearer ${senderToken}`)
        .expect(201);
      await request(http)
        .post(`/inventory/transfers/${created.body.id}/cancel`)
        .set("Authorization", `Bearer ${senderToken}`)
        .send({ reason: "لا يجوز" })
        .expect(409);
      // Clean up.
      await request(http)
        .post(`/inventory/transfers/${created.body.id}/reject`)
        .set("Authorization", `Bearer ${receiverToken}`)
        .send({ reason: "cleanup" })
        .expect(201);
    });
  });
});
