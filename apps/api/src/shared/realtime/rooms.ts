/**
 * Realtime room names. Rooms are always derived server-side from the
 * authenticated socket's tenant — clients can never name another tenant's room.
 */
export const rtRooms = {
  /** Restaurant-level order updates (POS, dashboard). */
  tenantOrders: (tenantId: string) => `tenant:${tenantId}:orders`,
  /** Branch-level kitchen updates (KDS). */
  branchKitchen: (branchId: string) => `branch:${branchId}:kitchen`,
  /** Branch-level catalog/channel-status updates (POS, dashboard). */
  branchCatalog: (branchId: string) => `branch:${branchId}:catalog`,
  /** Table-level customer updates (reserved). */
  table: (tableId: string) => `table:${tableId}`,
  /**
   * Per-order guest room. The order UUID acts as an unguessable capability:
   * whoever placed the order knows its id and can follow its status.
   */
  order: (orderId: string) => `order:${orderId}`,
};

/** Events emitted to clients. */
export const RT_EVENTS = {
  ORDER_CREATED: "order.created",
  ORDER_UPDATED: "order.updated",
  /** Trimmed guest-facing status event (no staff/actor details). */
  GUEST_ORDER_STATUS: "order.status",
  /** A product's or modifier's effective availability at this branch changed. */
  AVAILABILITY_CHANGED: "catalog.availability_changed",
  /** A branch's channel (dine_in/takeaway/delivery) open/paused state changed. */
  CHANNEL_STATUS_CHANGED: "branch.channel_status_changed",
} as const;
