/**
 * Domain event names. Modules communicate through these events
 * (NestJS EventEmitter) instead of calling each other directly.
 * The realtime layer, KDS, notifications and analytics all consume them.
 */
export const DOMAIN_EVENTS = {
  ORDER_CREATED: "order.created",
  ORDER_STATUS_CHANGED: "order.status_changed",
  ORDER_CANCELLED: "order.cancelled",
  INVOICE_ISSUED: "invoice.issued",
  SHIFT_OPENED: "shift.opened",
  SHIFT_CLOSED: "shift.closed",
  TENANT_CREATED: "tenant.created",
  /** A branch's on-hand quantity of an ingredient just crossed AT/BELOW its reorderLevel for the first time (not yet cleared). */
  INGREDIENT_REORDER_ALERT: "ingredient.reorder_alert",
} as const;

export type DomainEventName = (typeof DOMAIN_EVENTS)[keyof typeof DOMAIN_EVENTS];
