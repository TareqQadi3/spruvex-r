import { api, post } from "./api";

export interface Shift {
  id: string;
  branchId: string;
  openingCash: string;
  expectedCash: string | null;
  actualCash: string | null;
  difference: string | null;
  openedAt: string;
  closedAt: string | null;
}

export interface ActiveOrder {
  id: string;
  orderNumber: number;
  type: string;
  source: string;
  status: string;
  notes: string | null;
  subtotal: string;
  discount: string;
  vatRate: string;
  vatAmount: string;
  total: string;
  createdAt: string;
  table: { id: string; number: string } | null;
  items: Array<{
    id: string;
    quantity: number;
    notes: string | null;
    productSnapshot: { name: string; nameEn: string | null };
    lineTotal: string;
    modifiers: Array<{
      modifierSnapshot: { name: string; nameEn: string | null };
      priceAdjustment: string;
    }>;
  }>;
  payments: Array<{ id: string; method: string; amount: string }>;
}

export interface PaymentSummary {
  orderId: string;
  status: string;
  total: string;
  paid: string;
  remaining: string;
  payments: Array<{ id: string; method: string; amount: string; reference: string | null }>;
}

export interface ReceiptData {
  id: string;
  receiptNumber: number;
  vatRate: string;
  vatAmount: string;
  total: string;
  issuedAt: string;
  /** ZATCA Phase 1 simplified-invoice QR content (Base64 TLV) — null if the restaurant has no VAT number. */
  qrPayload: string | null;
  payload: {
    restaurant: {
      name: string;
      nameEn: string | null;
      vatNumber: string | null;
      currency: string;
    };
    branch: { name: string; address: string | null; phone: string | null };
    order: {
      orderNumber: number;
      type: string;
      table: string | null;
      createdAt: string;
      lines: Array<{
        name: string;
        nameEn: string | null;
        quantity: number;
        unitPrice: string;
        lineTotal: string;
        modifiers: Array<{ name: string; priceAdjustment: string }>;
      }>;
    };
    totals: {
      subtotal: string;
      discount: string;
      vatRate: string;
      vatAmount: string;
      total: string;
    };
    payments: Array<{ method: string; amount: string; reference: string | null }>;
  };
}

export const posApi = {
  currentShift: (branchId: string) => api<Shift | null>(`/shifts/current?branchId=${branchId}`),
  openShift: (branchId: string, openingCash: string) =>
    post<Shift>("/shifts/open", { branchId, openingCash }),
  closeShift: (id: string, actualCash: string) =>
    post<Shift>(`/shifts/${id}/close`, actualCash === "" ? {} : { actualCash }),

  activeOrders: (branchId: string) =>
    api<ActiveOrder[]>(
      `/orders?branchId=${branchId}&statuses=new,confirmed,preparing,ready,served`,
    ),
  transition: (orderId: string, status: string, reason?: string) =>
    post<ActiveOrder>(`/orders/${orderId}/status`, { status, ...(reason ? { reason } : {}) }),
  paymentSummary: (orderId: string) => api<PaymentSummary>(`/orders/${orderId}/payments`),
  recordPayment: (
    orderId: string,
    body: { method: "cash" | "card"; amount: string; reference?: string },
  ) =>
    post<PaymentSummary & { payment: { id: string } }>(`/orders/${orderId}/payments`, body, {
      "Idempotency-Key": crypto.randomUUID(),
    }),
  applyDiscount: (orderId: string, body: { type: "percentage" | "fixed"; value: string; reason: string }) =>
    post<ActiveOrder>(`/orders/${orderId}/discount`, body),
  receipt: (orderId: string) => api<ReceiptData>(`/orders/${orderId}/receipt`),
};
