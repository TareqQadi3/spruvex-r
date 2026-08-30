/**
 * Permission-aware navigation model. Items render only when the signed-in
 * user's permission set allows them; future business modules are declared
 * now (comingSoon) so the shell shows the product shape without dead links.
 */
export interface NavItem {
  /** i18n key under "nav." */
  labelKey: string;
  path: string;
  icon: string;
  /** Permission required to see the item. Undefined = visible to any member. */
  permission?: string;
  comingSoon?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { labelKey: "home", path: "/", icon: "home" },
  { labelKey: "branches", path: "/branches", icon: "store", permission: "branches.manage" },
  { labelKey: "team", path: "/team", icon: "users", permission: "users.manage" },
  { labelKey: "settings", path: "/settings", icon: "settings", permission: "tenant.settings.manage" },
  { labelKey: "integrations", path: "/integrations", icon: "puzzle", permission: "tenant.settings.manage" },
  { labelKey: "loyalty", path: "/loyalty", icon: "gift", permission: "loyalty.manage" },
  { labelKey: "billing", path: "/billing", icon: "credit-card", permission: "billing.view" },
  { labelKey: "menu", path: "/menu", icon: "book-open", permission: "menu.manage" },
  { labelKey: "tables", path: "/tables", icon: "layout-grid", permission: "tables.manage" },
  { labelKey: "inventory", path: "/inventory", icon: "package", permission: "inventory.view" },
  { labelKey: "reports", path: "/reports", icon: "bar-chart", permission: "reports.view" },
  // Business modules — later phases:
  { labelKey: "orders", path: "/orders", icon: "receipt", permission: "orders.view", comingSoon: true },
  { labelKey: "pos", path: "/pos", icon: "monitor", permission: "orders.create", comingSoon: true },
  { labelKey: "kds", path: "/kds", icon: "chef-hat", permission: "kitchen.view", comingSoon: true },
];

export function visibleNavItems(
  items: NavItem[],
  permissions: ReadonlySet<string> | string[],
): NavItem[] {
  const set = Array.isArray(permissions) ? new Set(permissions) : permissions;
  return items.filter((item) => !item.permission || set.has(item.permission));
}
