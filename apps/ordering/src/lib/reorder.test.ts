import { describe, expect, it } from "vitest";

import { matchAgainstCurrentMenu, type LastOrderRecord } from "./reorder";
import type { Menu, MenuModifier, MenuProduct } from "./types";

function product(overrides: Partial<MenuProduct> = {}): MenuProduct {
  return {
    id: "p1",
    categoryId: "c1",
    name: "شيش طاووق",
    nameEn: "Shish Tawook",
    description: null,
    descriptionEn: null,
    imageUrl: null,
    price: "30.00",
    badges: [],
    prepTimeMinutes: null,
    modifierGroups: [],
    ...overrides,
  };
}

function modifier(id: string): MenuModifier {
  return { id, name: "كبير", nameEn: "Large", priceAdjustment: "5.00" };
}

describe("matchAgainstCurrentMenu (repeat last order)", () => {
  it("rebuilds a repeatable line for a product still on the menu", () => {
    const menu: Menu = { categories: [], products: [product()] };
    const record: LastOrderRecord = {
      placedAt: new Date().toISOString(),
      items: [{ productId: "p1", quantity: 2 }],
    };
    const lines = matchAgainstCurrentMenu(record, menu);
    expect(lines).toEqual([{ product: menu.products[0], modifiers: [], quantity: 2, notes: undefined }]);
  });

  it("drops a line whose product no longer exists on the current menu", () => {
    const menu: Menu = { categories: [], products: [] };
    const record: LastOrderRecord = {
      placedAt: new Date().toISOString(),
      items: [{ productId: "gone", quantity: 1 }],
    };
    expect(matchAgainstCurrentMenu(record, menu)).toEqual([]);
  });

  it("drops a modifier that no longer belongs to the product, keeping the line", () => {
    const withGroup = product({
      modifierGroups: [
        { id: "g1", name: "الحجم", nameEn: "Size", isRequired: false, minSelect: 0, maxSelect: 1, modifiers: [modifier("m1")] },
      ],
    });
    const menu: Menu = { categories: [], products: [withGroup] };
    const record: LastOrderRecord = {
      placedAt: new Date().toISOString(),
      items: [{ productId: "p1", quantity: 1, modifierIds: ["m1", "removed-modifier"] }],
    };
    const lines = matchAgainstCurrentMenu(record, menu);
    expect(lines).toHaveLength(1);
    expect(lines[0].modifiers.map((m) => m.id)).toEqual(["m1"]);
  });

  it("drops the whole line when a required group's selection is no longer satisfied", () => {
    const withRequiredGroup = product({
      modifierGroups: [
        { id: "g1", name: "الحجم", nameEn: "Size", isRequired: true, minSelect: 1, maxSelect: 1, modifiers: [modifier("m1")] },
      ],
    });
    const menu: Menu = { categories: [], products: [withRequiredGroup] };
    const record: LastOrderRecord = {
      placedAt: new Date().toISOString(),
      // The required size modifier no longer exists — the line can't be repeated as-is.
      items: [{ productId: "p1", quantity: 1, modifierIds: ["removed-size"] }],
    };
    expect(matchAgainstCurrentMenu(record, menu)).toEqual([]);
  });
});
