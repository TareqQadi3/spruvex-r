import type { OrderStatus } from "@spruvex-r/types";

export interface OrderModifier {
  id: string;
  modifierSnapshot: { name: string; nameEn: string | null; groupName: string };
  priceAdjustment: string;
}

export interface OrderItem {
  id: string;
  productSnapshot: { name: string; nameEn: string | null; comboParentName?: string };
  quantity: number;
  notes: string | null;
  modifiers: OrderModifier[];
}

export interface KdsOrder {
  id: string;
  orderNumber: number;
  type: string;
  source: string;
  status: OrderStatus;
  notes: string | null;
  customerName: string | null;
  createdAt: string;
  table: { id: string; number: string } | null;
  items: OrderItem[];
}

/** Next KDS action per status. */
export const NEXT_ACTION: Partial<Record<OrderStatus, OrderStatus>> = {
  new: "confirmed",
  confirmed: "preparing",
  preparing: "ready",
  ready: "served",
};

/** Merge a created/updated order into the board list. */
export function mergeOrder(orders: KdsOrder[], incoming: KdsOrder): KdsOrder[] {
  const active = ["new", "confirmed", "preparing", "ready"].includes(incoming.status);
  const without = orders.filter((order) => order.id !== incoming.id);
  if (!active) return without;
  return [...without, incoming].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
}
