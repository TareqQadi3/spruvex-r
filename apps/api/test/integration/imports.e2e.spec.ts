import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaClient } from "@prisma/client";
import ExcelJS from "exceljs";
import request from "supertest";

import { AppModule } from "../../src/app.module";
import { syncPermissionCatalog } from "../../src/modules/tenancy/tenant-provisioning";
import { createAdminClient, truncateAll } from "../helpers/db";
import { provisionTestTenant } from "../helpers/provision";

async function xlsxBuffer(headers: string[], rows: (string | number)[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  sheet.addRow(headers);
  for (const row of rows) sheet.addRow(row);
  const buf = await workbook.xlsx.writeBuffer();
  return Buffer.from(buf);
}

describe("data imports (e2e)", () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let http: ReturnType<INestApplication["getHttpServer"]>;

  let ownerToken = "";
  let cashierToken = "";
  let branchId = "";

  async function login(email: string, password = "Test-12345"): Promise<string> {
    const res = await request(http).post("/auth/login").send({ email, password }).expect(200);
    return res.body.tokens.accessToken;
  }

  beforeAll(async () => {
    admin = createAdminClient();
    await truncateAll(admin);
    await syncPermissionCatalog(admin);

    const tenant = await provisionTestTenant(admin, {
      name: "مطعم اختبار الاستيراد",
      slug: "imports-test",
      ownerEmail: "owner@imports-test.test",
    });
    branchId = tenant.branchId!;

    const cashier = await admin.user.create({
      data: {
        email: "cashier@imports-test.test",
        name: "كاشير",
        passwordHash: (await admin.user.findUniqueOrThrow({ where: { email: tenant.ownerEmail } }))
          .passwordHash,
        emailVerifiedAt: new Date(),
      },
    });
    await admin.userRole.create({
      data: {
        tenantId: tenant.tenantId,
        userId: cashier.id,
        roleId: tenant.roleIdsByKey.cashier,
        branchId,
      },
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    http = app.getHttpServer();

    ownerToken = await login("owner@imports-test.test");
    cashierToken = await login("cashier@imports-test.test");
  });

  afterAll(async () => {
    await app.close();
    await admin.$disconnect();
  });

  describe("categories import", () => {
    it("runs the full upload -> mapping -> preview -> execute cycle with oddly-named columns", async () => {
      const file = await xlsxBuffer(
        ["Category Name", "English"],
        [
          ["المشويات", "Grills"],
          ["المشروبات", "Drinks"],
        ],
      );

      const upload = await request(http)
        .post("/imports/categories")
        .set("Authorization", `Bearer ${ownerToken}`)
        .attach("file", file, { filename: "categories.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })
        .expect(201);

      expect(upload.body.headers).toEqual(["Category Name", "English"]);
      expect(upload.body.rowCount).toBe(2);
      // "Category Name" is a listed alias for the required "name" field —
      // auto-suggested without the merchant lifting a finger. "English" has
      // no alias for nameEn and is correctly left unmapped for them to pick.
      expect(upload.body.mapping["Category Name"]).toBe("name");
      expect(upload.body.mapping.English).toBe(null);
      const jobId = upload.body.id;

      // Confirm the mapping by hand, exactly as a merchant would from the UI.
      const mapped = await request(http)
        .patch(`/imports/${jobId}/mapping`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ mapping: { "Category Name": "name", English: "nameEn" } })
        .expect(200);
      expect(mapped.body.status).toBe("mapped");

      const preview = await request(http)
        .get(`/imports/${jobId}/preview`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .expect(200);
      expect(preview.body.rows).toHaveLength(2);
      expect(preview.body.rows.every((r: { status: string }) => r.status === "would_create")).toBe(true);

      const executed = await request(http)
        .post(`/imports/${jobId}/execute`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .expect(200);
      expect(executed.body).toMatchObject({ status: "completed", successCount: 2, skippedCount: 0, failedCount: 0 });

      const categories = await request(http)
        .get("/catalog/categories")
        .set("Authorization", `Bearer ${ownerToken}`)
        .expect(200);
      expect(categories.body.map((c: { name: string }) => c.name).sort()).toEqual(["المشروبات", "المشويات"]);

      // Re-running execute on the same completed job is rejected, not silently repeated.
      await request(http)
        .post(`/imports/${jobId}/execute`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .expect(409);
    });

    it("skips a category that already exists by name instead of duplicating it, and reports it in the CSV", async () => {
      await request(http)
        .post("/catalog/categories")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ name: "الحلويات" })
        .expect(201);

      const file = await xlsxBuffer(["name"], [["الحلويات"], ["المقبلات"]]);
      const upload = await request(http)
        .post("/imports/categories")
        .set("Authorization", `Bearer ${ownerToken}`)
        .attach("file", file, { filename: "cats2.xlsx" })
        .expect(201);
      const jobId = upload.body.id;

      await request(http)
        .patch(`/imports/${jobId}/mapping`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ mapping: { name: "name" } })
        .expect(200);

      const executed = await request(http)
        .post(`/imports/${jobId}/execute`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .expect(200);
      expect(executed.body).toMatchObject({ successCount: 1, skippedCount: 1, failedCount: 0 });

      const csv = await request(http)
        .get(`/imports/${jobId}/failed-rows.csv`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .expect(200);
      expect(csv.text).toContain("الحلويات");
      expect(csv.text).toContain("تم تخطيه (مكرر)");
    });
  });

  describe("products import", () => {
    it("creates a product against an existing category resolved by name, and fails a row with an invalid price and a missing category", async () => {
      await request(http)
        .post("/catalog/categories")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ name: "البرجر" })
        .expect(201);

      const file = await xlsxBuffer(
        ["Item Name", "Price", "Category", "Description"],
        [
          ["برجر لحم", "25.00 SAR", "البرجر", "برجر مشوي"],
          ["برجر فاسد السعر", "abc", "البرجر", ""],
          ["برجر بدون قسم", "20", "قسم غير موجود", ""],
        ],
      );

      const upload = await request(http)
        .post("/imports/products")
        .set("Authorization", `Bearer ${ownerToken}`)
        .attach("file", file, { filename: "products.xlsx" })
        .expect(201);
      const jobId = upload.body.id;
      // "Item Name"/"Price"/"Category" are all exact aliases — should auto-suggest.
      expect(upload.body.mapping).toMatchObject({
        "Item Name": "name",
        Price: "basePrice",
        Category: "categoryName",
      });

      await request(http)
        .patch(`/imports/${jobId}/mapping`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({
          mapping: {
            "Item Name": "name",
            Price: "basePrice",
            Category: "categoryName",
            Description: "description",
          },
        })
        .expect(200);

      const executed = await request(http)
        .post(`/imports/${jobId}/execute`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .expect(200);
      expect(executed.body).toMatchObject({ successCount: 1, skippedCount: 0, failedCount: 2 });

      const csv = await request(http)
        .get(`/imports/${jobId}/failed-rows.csv`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .expect(200);
      expect(csv.text).toContain("سعر غير صالح");
      expect(csv.text).toContain("القسم غير موجود");
    });
  });

  describe("customers import", () => {
    it("creates loyalty customers by phone and skips a duplicate phone without overwriting the name", async () => {
      const file = await xlsxBuffer(
        ["Mobile", "Name"],
        [
          ["+966501112222", "عميل واحد"],
          ["+966501112222", "اسم مختلف لنفس الرقم"],
          ["0501113333", "عميل اثنين"],
        ],
      );

      const upload = await request(http)
        .post("/imports/customers")
        .set("Authorization", `Bearer ${ownerToken}`)
        .attach("file", file, { filename: "customers.xlsx" })
        .expect(201);
      const jobId = upload.body.id;
      expect(upload.body.mapping.Mobile).toBe("phone");
      expect(upload.body.mapping.Name).toBe("name");

      await request(http)
        .patch(`/imports/${jobId}/mapping`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ mapping: { Mobile: "phone", Name: "name" } })
        .expect(200);

      const executed = await request(http)
        .post(`/imports/${jobId}/execute`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .expect(200);
      // Row 2 (same phone as row 1, within the same file) is a duplicate too.
      expect(executed.body).toMatchObject({ successCount: 2, skippedCount: 1, failedCount: 0 });

      const balance = await request(http)
        .get("/loyalty/customers/%2B966501112222")
        .set("Authorization", `Bearer ${ownerToken}`)
        .expect(200);
      expect(balance.body.exists).toBe(true);
    });
  });

  describe("permissions", () => {
    it("denies a cashier (no menu.manage, no loyalty.manage) on every upload route", async () => {
      const file = await xlsxBuffer(["name"], [["x"]]);
      await request(http)
        .post("/imports/categories")
        .set("Authorization", `Bearer ${cashierToken}`)
        .attach("file", file, { filename: "x.xlsx" })
        .expect(403);
      await request(http)
        .post("/imports/products")
        .set("Authorization", `Bearer ${cashierToken}`)
        .attach("file", file, { filename: "x.xlsx" })
        .expect(403);
      await request(http)
        .post("/imports/customers")
        .set("Authorization", `Bearer ${cashierToken}`)
        .attach("file", file, { filename: "x.xlsx" })
        .expect(403);
    });

    it("denies reading a categories-type job's mapping/preview/execute to a cashier even by direct id", async () => {
      const file = await xlsxBuffer(["name"], [["قسم اختباري"]]);
      const upload = await request(http)
        .post("/imports/categories")
        .set("Authorization", `Bearer ${ownerToken}`)
        .attach("file", file, { filename: "x.xlsx" })
        .expect(201);
      const jobId = upload.body.id;

      await request(http).get(`/imports/${jobId}`).set("Authorization", `Bearer ${cashierToken}`).expect(403);
      await request(http)
        .patch(`/imports/${jobId}/mapping`)
        .set("Authorization", `Bearer ${cashierToken}`)
        .send({ mapping: { name: "name" } })
        .expect(403);
      await request(http)
        .get(`/imports/${jobId}/preview`)
        .set("Authorization", `Bearer ${cashierToken}`)
        .expect(403);
      await request(http)
        .post(`/imports/${jobId}/execute`)
        .set("Authorization", `Bearer ${cashierToken}`)
        .expect(403);
    });
  });
});
