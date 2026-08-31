import { api } from "./api";

export type StockTransferStatus = "draft" | "sent" | "received" | "rejected" | "cancelled";

export interface StockTransferItem {
  id: string;
  ingredientId: string;
  sentQuantity: string;
  fromLocationId: string;
  unitCostAtSend: string | null;
  toLocationId: string | null;
  receivedQuantity: string | null;
  discrepancyReason: string | null;
}

export interface StockTransfer {
  id: string;
  fromBranchId: string;
  toBranchId: string;
  status: StockTransferStatus;
  notes: string | null;
  sentAt: string | null;
  receivedAt: string | null;
  rejectedAt: string | null;
  rejectReason: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
  items: StockTransferItem[];
}

export interface CreateStockTransferItemInput {
  ingredientId: string;
  fromLocationId?: string;
  quantity: string;
}

export interface CreateStockTransferInput {
  fromBranchId: string;
  toBranchId: string;
  items: CreateStockTransferItemInput[];
  notes?: string;
}

export interface ReceiveStockTransferItemInput {
  stockTransferItemId: string;
  toLocationId?: string;
  receivedQuantity: string;
  discrepancyReason?: string;
}

export interface ListStockTransfersQuery {
  branchId?: string;
  status?: StockTransferStatus;
}

function toQueryString(params: ListStockTransfersQuery): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v) qs.set(k, v);
  }
  const s = qs.toString();
  return s ? `?${s}` : "";
}

export const stockTransfersApi = {
  list: (query: ListStockTransfersQuery = {}) =>
    api<StockTransfer[]>(`/inventory/transfers${toQueryString(query)}`),
  get: (id: string) => api<StockTransfer>(`/inventory/transfers/${id}`),
  create: (body: CreateStockTransferInput) =>
    api<StockTransfer>("/inventory/transfers", { method: "POST", body: JSON.stringify(body) }),
  send: (id: string) => api<StockTransfer>(`/inventory/transfers/${id}/send`, { method: "POST" }),
  receive: (id: string, items: ReceiveStockTransferItemInput[]) =>
    api<StockTransfer>(`/inventory/transfers/${id}/receive`, {
      method: "POST",
      body: JSON.stringify({ items }),
    }),
  reject: (id: string, reason: string) =>
    api<StockTransfer>(`/inventory/transfers/${id}/reject`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
  cancel: (id: string, reason: string) =>
    api<StockTransfer>(`/inventory/transfers/${id}/cancel`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
};
