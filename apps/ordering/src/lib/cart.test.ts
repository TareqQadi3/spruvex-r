import { describe, expect, it } from "vitest";

import { cartItemCount, cartTotal, lineTotal, lineUnitPrice, type CartLine } from "./cart";
import type { MenuModifier, MenuProduct } from "./types";

function product(price: string): MenuProduct {
  return {
    id: "p1",
    categoryId: "c1",
    name: "شيش طاووق",
    nameEn: "Shish Tawook",
    description: null,
    descriptionEn: null,
    imageUrl: null,
    price,
    badges: [],
    prepTimeMinutes: null,
    modifierGroups: [],
  };
}

function modifier(priceAdjustment: string): MenuModifier {
  return { id: "m1", name: "كبير", nameEn: "Large", priceAdjustment };
}

describe("cart calculations (display-only; server recomputes authoritatively)", () => {
  it("computes unit price including modifier adjustments", () => {
    const line: CartLine = {
      lineId: "l1",
      product: product("30.00"),
      quantity: 1,
      modifiers: [modifier("5.00")],
    };
    expect(lineUnitPrice(line)).toBe("35.00");
  });

  it("computes line total = unit price * quantity", () => {
    const line: CartLine = {
      lineId: "l1",
      product: product("30.00"),
      quantity: 2,
      modifiers: [modifier("5.00")],
    };
    expect(lineTotal(line)).toBe("70.00");
  });

  it("sums the cart across multiple lines", () => {
    const lines: CartLine[] = [
      { lineId: "l1", product: product("30.00"), quantity: 2, modifiers: [modifier("5.00")] },
      { lineId: "l2", product: product("12.00"), quantity: 1, modifiers: [] },
    ];
    expect(cartTotal(lines)).toBe("82.00");
    expect(cartItemCount(lines)).toBe(3);
  });

  it("handles an empty cart", () => {
    expect(cartTotal([])).toBe("0");
    expect(cartItemCount([])).toBe(0);
  });
});
