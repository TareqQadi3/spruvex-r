import { ALL_PERMISSION_KEYS, type PermissionKey } from "./permissions";

/**
 * Built-in roles created for every new tenant. Tenants can adjust the
 * permission sets afterwards (roles are rows, not enums).
 */
export const SYSTEM_ROLES = ["owner", "manager", "cashier", "waiter", "kitchen"] as const;

export type SystemRole = (typeof SYSTEM_ROLES)[number];

export const DEFAULT_ROLE_PERMISSIONS: Record<SystemRole, readonly PermissionKey[]> = {
  owner: ALL_PERMISSION_KEYS,
  manager: ALL_PERMISSION_KEYS.filter((p) => p !== "roles.manage"),
  cashier: [
    "menu.view",
    "tables.view",
    "orders.create",
    "orders.view",
    "orders.update_status",
    "payments.record",
    "invoices.view",
    "shifts.open",
    "shifts.close",
    "shifts.cash_movement",
    "shifts.view",
    "loyalty.redeem",
  ],
  waiter: [
    "menu.view",
    "tables.view",
    "orders.create",
    "orders.view",
    "orders.update_status",
  ],
  kitchen: ["kitchen.view", "kitchen.update_status", "orders.view", "orders.update_status"],
};

export const ROLE_LABELS: Record<SystemRole, { ar: string; en: string }> = {
  owner: { ar: "المالك", en: "Owner" },
  manager: { ar: "مدير الفرع", en: "Branch Manager" },
  cashier: { ar: "كاشير", en: "Cashier" },
  waiter: { ar: "ويتر", en: "Waiter" },
  kitchen: { ar: "مطبخ", en: "Kitchen" },
};
