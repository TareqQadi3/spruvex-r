/**
 * Central permission catalog for SpruVex R.
 *
 * Permissions are stored in the database (`permissions` table) and seeded from
 * this catalog, so backend guards and frontend UI share a single source of truth.
 * Every API endpoint must declare one of these keys via `@RequirePermission()`.
 */
export const PERMISSIONS = {
  // Tenancy & settings
  "tenant.settings.manage": "Manage restaurant settings (tax, branding, ordering options)",
  "branches.manage": "Create and manage branches",

  // Identity
  "users.manage": "Invite, edit and deactivate users",
  "roles.manage": "Manage roles and their permissions",

  // Catalog (menu)
  "menu.view": "View menu categories, products and modifiers",
  "menu.manage": "Create and edit categories, products, modifiers and availability",

  // Tables & floors
  "tables.view": "View floors, tables and their statuses",
  "tables.manage": "Create and edit floors and tables, generate QR codes",
  "tables.transfer": "Merge or transfer orders between tables",

  // Ordering
  "orders.create": "Create orders on the POS",
  "orders.view": "View orders",
  "orders.update_status": "Advance order status (confirm, prepare, ready, complete)",
  "orders.discount": "Apply discounts to orders",
  "orders.void": "Void or cancel orders",

  // Kitchen
  "kitchen.view": "View the kitchen display (KDS)",
  "kitchen.update_status": "Update preparation status from the KDS",

  // Payments & invoicing
  "payments.record": "Record payments (cash / card / split)",
  "payments.refund": "Issue refunds / credit notes",
  "invoices.view": "View issued invoices",

  // Shifts & cash
  "shifts.open": "Open a shift",
  "shifts.close": "Close a shift and reconcile cash",
  "shifts.cash_movement": "Record cash in / cash out movements",
  "shifts.view": "View shift reports",

  // Reports
  "reports.view": "View sales, tax and product reports",
  "reports.export": "Export reports",

  // Inventory & recipes
  "inventory.view": "View ingredients, stock levels and movement history",
  "inventory.manage": "Record purchases, waste and stock adjustments; manage ingredients and locations",
  "recipes.manage": "Define and edit product recipes (ingredients and quantities)",

  // Audit
  "audit.view": "View the audit log",

  // Billing (SaaS subscription)
  "billing.view": "View the subscription plan, trial status and usage",
  "billing.manage": "Change plan and manage the subscription",

  // Loyalty program
  "loyalty.manage": "Configure loyalty programs (stamps, spend threshold, points, tiers)",
  "loyalty.redeem": "View a customer's loyalty balance and apply redemptions at checkout",

  // Purchasing (suppliers & purchase invoices)
  "purchases.create": "Create suppliers, enter and confirm purchase invoices",
  "purchases.view": "View suppliers and purchase invoices",
  "purchases.void": "Cancel a purchase invoice",

  // Inter-branch stock transfers
  "inventory.transfer.create": "Create, send and cancel stock transfers from a branch",
  "inventory.transfer.receive": "Receive or reject an incoming stock transfer",
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;

export const ALL_PERMISSION_KEYS = Object.keys(PERMISSIONS) as PermissionKey[];
