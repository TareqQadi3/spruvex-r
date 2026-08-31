import { describe, expect, it } from "vitest";

import { NAV_ITEMS, visibleNavItems } from "./nav";

describe("permission-aware navigation", () => {
  it("shows everything to an owner (all permissions)", () => {
    const all = NAV_ITEMS.map((i) => i.permission).filter(Boolean) as string[];
    expect(visibleNavItems(NAV_ITEMS, all)).toHaveLength(NAV_ITEMS.length);
  });

  it("hides admin items from a cashier", () => {
    const cashier = ["orders.create", "orders.view", "menu.view", "shifts.open"];
    const visible = visibleNavItems(NAV_ITEMS, cashier);
    const keys = visible.map((i) => i.labelKey);

    expect(keys).toContain("home"); // no permission required
    expect(keys).toContain("pos");
    expect(keys).toContain("orders");
    expect(keys).not.toContain("branches");
    expect(keys).not.toContain("team");
    expect(keys).not.toContain("settings");
    expect(keys).not.toContain("reports");
  });

  it("kitchen staff only see home and the KDS", () => {
    const keys = visibleNavItems(NAV_ITEMS, ["kitchen.view", "kitchen.update_status"]).map(
      (i) => i.labelKey,
    );
    expect(keys).toEqual(["home", "kds"]);
  });

  it("accepts a ReadonlySet as well as an array", () => {
    const keys = visibleNavItems(NAV_ITEMS, new Set(["branches.manage"])).map((i) => i.labelKey);
    expect(keys).toEqual(["home", "branches"]);
  });

  it("shows a string[]-gated item (import) to a user holding just one of the listed permissions", () => {
    const menuOnly = visibleNavItems(NAV_ITEMS, ["menu.manage"]).map((i) => i.labelKey);
    expect(menuOnly).toContain("import");

    const loyaltyOnly = visibleNavItems(NAV_ITEMS, ["loyalty.manage"]).map((i) => i.labelKey);
    expect(loyaltyOnly).toContain("import");

    const neither = visibleNavItems(NAV_ITEMS, ["orders.view"]).map((i) => i.labelKey);
    expect(neither).not.toContain("import");
  });
});
