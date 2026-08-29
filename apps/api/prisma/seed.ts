import { PrismaClient } from "@prisma/client";

import { syncPlanCatalog } from "../src/modules/billing/plan-catalog";
import { hashPassword, hashPin } from "../src/modules/identity/password";
import { syncUnitCatalog } from "../src/modules/inventory/unit-catalog";
import {
  provisionTenant,
  syncPermissionCatalog,
} from "../src/modules/tenancy/tenant-provisioning";

/**
 * Development seed — permission catalog + one demo restaurant.
 * Runs on the admin (BYPASSRLS) connection. Idempotent.
 *
 * Demo credentials (development only):
 *   owner:   owner@demo.spruvex.local   / SpruVex-Demo1
 *   cashier: cashier@demo.spruvex.local / SpruVex-Demo1  (POS PIN: 1234)
 *   kitchen: kitchen@demo.spruvex.local / SpruVex-Demo1
 *
 * The onboarding wizard only creates an owner + a cashier account, so a
 * dedicated `kitchen`-role account is seeded here too — without it, a
 * restaurant that staffs its KDS screen with the cashier account gets a
 * silently degraded (REST-only, no realtime push) kitchen display, since
 * `cashier` lacks `kitchen.view` (see the Launch Readiness Report's known
 * issues).
 */
async function main() {
  const adminUrl = process.env.ADMIN_DATABASE_URL;
  if (!adminUrl) {
    throw new Error("ADMIN_DATABASE_URL is required to run the seed");
  }
  const db = new PrismaClient({ datasourceUrl: adminUrl });

  try {
    await syncPermissionCatalog(db);
    console.log("Permission catalog synced.");
    await syncUnitCatalog(db);
    console.log("Unit-of-measure catalog synced.");
    await syncPlanCatalog(db);
    console.log("Plan catalog synced.");

    const platformAdminEmail = process.env.PLATFORM_ADMIN_EMAIL;
    const platformAdminPassword = process.env.PLATFORM_ADMIN_PASSWORD;
    if (platformAdminEmail && platformAdminPassword) {
      const existingAdmin = await db.platformAdmin.findUnique({ where: { email: platformAdminEmail } });
      if (!existingAdmin) {
        await db.platformAdmin.create({
          data: {
            email: platformAdminEmail,
            name: "SpruVex Admin",
            passwordHash: await hashPassword(platformAdminPassword),
          },
        });
        console.log(`Platform admin bootstrapped: ${platformAdminEmail}`);
      }
    }

    const existing = await db.tenant.findUnique({ where: { slug: "demo" } });
    if (existing) {
      console.log("Demo tenant already exists — skipping.");
      return;
    }

    const owner = await db.user.create({
      data: {
        email: "owner@demo.spruvex.local",
        name: "صاحب المطعم",
        passwordHash: await hashPassword("SpruVex-Demo1"),
        emailVerifiedAt: new Date(),
      },
    });

    const provisioned = await provisionTenant(db, {
      name: "مطعم التجربة",
      nameEn: "Demo Restaurant",
      slug: "demo",
      type: "restaurant",
      vatNumber: "300000000000003",
      branch: { name: "الفرع الرئيسي", nameEn: "Main Branch", slug: "main" },
      ownerUserId: owner.id,
    });

    await db.tenant.update({
      where: { id: provisioned.tenantId },
      data: { onboardingCompletedAt: new Date() },
    });

    // Keep the demo tenant permanently usable: provisionTenant starts a
    // 14-day trial, which expires and then the billing gate blocks all
    // writes (402 Payment Required) whenever the demo is tried weeks later.
    // A demo account should never expire — mark it active with a far-future
    // period. Real signups still get the normal trial from provisionTenant.
    await db.subscription.updateMany({
      where: { tenantId: provisioned.tenantId },
      data: {
        status: "active",
        trialEndsAt: new Date(Date.now() + 3650 * 24 * 60 * 60 * 1000),
        currentPeriodEnd: new Date(Date.now() + 3650 * 24 * 60 * 60 * 1000),
      },
    });

    // A cashier with a POS PIN so later phases are demoable out of the box.
    const cashier = await db.user.create({
      data: {
        email: "cashier@demo.spruvex.local",
        name: "كاشير التجربة",
        passwordHash: await hashPassword("SpruVex-Demo1"),
        emailVerifiedAt: new Date(),
      },
    });
    await db.userRole.create({
      data: {
        tenantId: provisioned.tenantId,
        userId: cashier.id,
        roleId: provisioned.roleIdsByKey.cashier,
        branchId: provisioned.branchId,
      },
    });
    await db.posPin.create({
      data: {
        tenantId: provisioned.tenantId,
        branchId: provisioned.branchId!,
        userId: cashier.id,
        pinHash: await hashPin("1234"),
      },
    });

    // A kitchen-role account so the KDS app has realtime permissions out of
    // the box (the onboarding wizard itself only creates owner + cashier).
    const kitchen = await db.user.create({
      data: {
        email: "kitchen@demo.spruvex.local",
        name: "شاشة المطبخ",
        passwordHash: await hashPassword("SpruVex-Demo1"),
        emailVerifiedAt: new Date(),
      },
    });
    await db.userRole.create({
      data: {
        tenantId: provisioned.tenantId,
        userId: kitchen.id,
        roleId: provisioned.roleIdsByKey.kitchen,
        branchId: provisioned.branchId,
      },
    });

    // Small demo menu: categories, products, a size modifier group.
    const tenantId = provisioned.tenantId;
    const grills = await db.category.create({
      data: { tenantId, name: "المشويات", nameEn: "Grills", sortOrder: 0, createdBy: owner.id },
    });
    const drinks = await db.category.create({
      data: { tenantId, name: "المشروبات", nameEn: "Drinks", sortOrder: 1, createdBy: owner.id },
    });

    const sizeGroup = await db.modifierGroup.create({
      data: {
        tenantId,
        name: "الحجم",
        nameEn: "Size",
        isRequired: true,
        minSelect: 1,
        maxSelect: 1,
        createdBy: owner.id,
      },
    });
    await db.modifier.createMany({
      data: [
        { tenantId, modifierGroupId: sizeGroup.id, name: "عادي", nameEn: "Regular", priceAdjustment: "0", sortOrder: 0 },
        { tenantId, modifierGroupId: sizeGroup.id, name: "كبير", nameEn: "Large", priceAdjustment: "5.00", sortOrder: 1 },
      ],
    });

    const tawook = await db.product.create({
      data: {
        tenantId,
        categoryId: grills.id,
        name: "شيش طاووق",
        nameEn: "Shish Tawook",
        sku: "GRL-001",
        basePrice: "32.00",
        sortOrder: 0,
        createdBy: owner.id,
      },
    });
    await db.product.createMany({
      data: [
        {
          tenantId,
          categoryId: grills.id,
          name: "كباب لحم",
          nameEn: "Beef Kebab",
          sku: "GRL-002",
          basePrice: "38.00",
          sortOrder: 1,
          createdBy: owner.id,
        },
        {
          tenantId,
          categoryId: drinks.id,
          name: "عصير برتقال طازج",
          nameEn: "Fresh Orange Juice",
          sku: "DRK-001",
          basePrice: "12.00",
          sortOrder: 0,
          createdBy: owner.id,
        },
      ],
    });
    await db.productModifierGroup.create({
      data: { tenantId, productId: tawook.id, modifierGroupId: sizeGroup.id, sortOrder: 0 },
    });

    // Demo floor + tables with QR tokens.
    const { randomBytes } = await import("node:crypto");
    const mainHall = await db.floor.create({
      data: {
        tenantId,
        branchId: provisioned.branchId!,
        name: "الصالة الرئيسية",
        nameEn: "Main Hall",
        createdBy: owner.id,
      },
    });
    await db.table.createMany({
      data: ["1", "2", "3", "4"].map((number) => ({
        tenantId,
        branchId: provisioned.branchId!,
        floorId: mainHall.id,
        number,
        capacity: 4,
        qrToken: randomBytes(12).toString("base64url"),
        createdBy: owner.id,
      })),
    });

    // Demo ingredients + recipe + stock (Phase 7).
    const gram = await db.unitOfMeasure.findUniqueOrThrow({ where: { code: "g" } });
    const piece = await db.unitOfMeasure.findUniqueOrThrow({ where: { code: "pc" } });

    const chicken = await db.ingredient.create({
      data: {
        tenantId,
        name: "صدر دجاج",
        nameEn: "Chicken Breast",
        unitType: "mass",
        averageCost: "0.0450", // 45 halalas/kg
        reorderLevel: "2000", // 2kg
        createdBy: owner.id,
      },
    });
    const skewer = await db.ingredient.create({
      data: {
        tenantId,
        name: "سيخ خشبي",
        nameEn: "Wooden Skewer",
        unitType: "count",
        averageCost: "0.1000",
        reorderLevel: "50",
        createdBy: owner.id,
      },
    });
    await db.recipeItem.createMany({
      data: [
        { tenantId, productId: tawook.id, ingredientId: chicken.id, unitId: gram.id, quantity: "200", createdBy: owner.id },
        { tenantId, productId: tawook.id, ingredientId: skewer.id, unitId: piece.id, quantity: "2", createdBy: owner.id },
      ],
    });

    const mainStore = await db.stockLocation.create({
      data: {
        tenantId,
        branchId: provisioned.branchId!,
        name: "المخزن الرئيسي",
        nameEn: "Main Store",
        isDefault: true,
        createdBy: owner.id,
      },
    });
    for (const [ingredientId, qty] of [
      [chicken.id, "10000"], // 10kg
      [skewer.id, "200"],
    ] as const) {
      await db.stockMovement.create({
        data: {
          tenantId,
          branchId: provisioned.branchId!,
          locationId: mainStore.id,
          ingredientId,
          type: "purchase",
          quantity: qty,
          unitCost: ingredientId === chicken.id ? "0.0450" : "0.1000",
          reason: "الرصيد الافتتاحي",
          performedBy: owner.id,
        },
      });
      await db.stockLevel.create({
        data: {
          tenantId,
          branchId: provisioned.branchId!,
          locationId: mainStore.id,
          ingredientId,
          quantity: qty,
        },
      });
    }

    console.log(`Demo tenant created with demo menu, tables & inventory: ${provisioned.tenantId}`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
