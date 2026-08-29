/** Shared domain enums/types used across API and frontend apps. */

export const ORDER_STATUSES = [
  "new",
  "confirmed",
  "preparing",
  "ready",
  "served",
  "completed",
  "cancelled",
  "refunded",
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/**
 * The order status state machine — the single definition of allowed
 * transitions (plan §10: central status machine).
 * new -> confirmed -> preparing -> ready -> served -> completed;
 * cancellation only from new/confirmed/preparing.
 *
 * Checkout (Phase 5): `completed` is also reachable from confirmed/ready
 * (counter orders paid before/without table service). Every transition to
 * `completed` is guarded by FULL PAYMENT at the service level, and
 * cancellation is blocked once payments exist.
 *
 * Refunds: `completed` -> `refunded` only when a credit note refunds the
 * FULL receipt total (payments.refund permission, see refunds.service.ts);
 * a partial refund keeps the order `completed`.
 */
export const ORDER_STATUS_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  new: ["confirmed", "cancelled"],
  confirmed: ["preparing", "completed", "cancelled"],
  preparing: ["ready", "cancelled"],
  ready: ["served", "completed"],
  served: ["completed"],
  completed: ["refunded"],
  cancelled: [],
  refunded: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return (ORDER_STATUS_TRANSITIONS[from] ?? []).includes(to);
}

/** Statuses that appear on the KDS / active-orders boards. */
export const ACTIVE_ORDER_STATUSES = ["new", "confirmed", "preparing", "ready"] as const;

export const ORDER_TYPES = ["dine_in", "takeaway", "walkin", "delivery"] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

export const ORDER_SOURCES = ["pos", "qr", "external_link", "delivery"] as const;
export type OrderSource = (typeof ORDER_SOURCES)[number];

export const TENANT_STATUSES = ["active", "suspended"] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

export const SUBSCRIPTION_STATUSES = ["trial", "active", "past_due", "suspended"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export type Locale = "ar" | "en";

/** Bilingual text value — Arabic first. */
export interface LocalizedText {
  ar: string;
  en: string;
}
