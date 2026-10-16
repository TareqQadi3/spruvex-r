import { api, uploadFile } from "./api";

export interface Supplier {
  id: string;
  name: string;
  nameEn: string | null;
  vatNumber: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  address: string | null;
  notes: string | null;
  isActive: boolean;
}

export interface CreateSupplierInput {
  name: string;
  nameEn?: string;
  vatNumber?: string;
  contactPhone?: string;
  contactEmail?: string;
  address?: string;
  notes?: string;
}
export type UpdateSupplierInput = Partial<CreateSupplierInput & { isActive: boolean }>;

export type PurchaseItemType = "stock" | "expense";
export type PurchaseInvoiceStatus = "draft" | "confirmed" | "cancelled";

export interface PurchaseInvoiceItem {
  id: string;
  description: string;
  itemType: PurchaseItemType;
  quantity: string;
  unitPrice: string;
  vatRatePercent: string;
  lineSubtotal: string;
  lineVat: string;
  lineTotal: string;
  ingredientId: string | null;
  locationId: string | null;
  expenseCategory: string | null;
}

export interface PurchaseInvoiceItemInput {
  description: string;
  itemType: PurchaseItemType;
  quantity: string;
  unitPrice: string;
  vatRatePercent?: string;
  ingredientId?: string;
  locationId?: string;
  expenseCategory?: string;
}

export interface PurchaseInvoiceSummary {
  id: string;
  branchId: string;
  supplierId: string;
  supplier: { id: string; name: string; nameEn: string | null };
  supplierInvoiceNumber: string;
  invoiceDate: string;
  status: PurchaseInvoiceStatus;
  subtotal: string;
  vatAmount: string;
  total: string;
  attachmentFilename: string | null;
  createdAt: string;
}

export interface PurchaseInvoiceReversalItem {
  id: string;
  purchaseInvoiceItemId: string;
  quantity: string;
  stockMovement: { id: string; quantity: string; unitCost: string | null } | null;
  expense: { id: string; amount: string; vatAmount: string; total: string } | null;
}

export interface PurchaseInvoiceReversal {
  id: string;
  reversalType: "cancellation" | "supplier_credit_note";
  reason: string;
  createdAt: string;
  items: PurchaseInvoiceReversalItem[];
}

export interface PurchaseInvoiceDetail extends PurchaseInvoiceSummary {
  supplier: { id: string; name: string; nameEn: string | null; vatNumber: string | null };
  notes: string | null;
  items: PurchaseInvoiceItem[];
  confirmedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  /** Present once the invoice has been cancelled after confirmation — the
   * real stock/expense reversal posted, for full traceability. */
  reversals: PurchaseInvoiceReversal[];
}

export interface ListPurchaseInvoicesQuery {
  branchId?: string;
  supplierId?: string;
  status?: PurchaseInvoiceStatus;
  from?: string;
  to?: string;
}

function toQueryString(params: ListPurchaseInvoicesQuery): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v) qs.set(k, v);
  }
  const s = qs.toString();
  return s ? `?${s}` : "";
}

export const purchasesApi = {
  listSuppliers: (includeInactive = false) =>
    api<Supplier[]>(`/purchases/suppliers${includeInactive ? "?includeInactive=true" : ""}`),
  getSupplier: (id: string) => api<Supplier>(`/purchases/suppliers/${id}`),
  createSupplier: (body: CreateSupplierInput) =>
    api<Supplier>("/purchases/suppliers", { method: "POST", body: JSON.stringify(body) }),
  updateSupplier: (id: string, body: UpdateSupplierInput) =>
    api<Supplier>(`/purchases/suppliers/${id}`, { method: "PATCH", body: JSON.stringify(body) }),

  getSettings: () => api<{ defaultPurchaseVatRate: string }>("/purchases/settings"),
  updateSettings: (defaultPurchaseVatRate: string) =>
    api<{ defaultPurchaseVatRate: string }>("/purchases/settings", {
      method: "PATCH",
      body: JSON.stringify({ defaultPurchaseVatRate }),
    }),

  listInvoices: (query: ListPurchaseInvoicesQuery = {}) =>
    api<PurchaseInvoiceSummary[]>(`/purchases/invoices${toQueryString(query)}`),
  getInvoice: (id: string) => api<PurchaseInvoiceDetail>(`/purchases/invoices/${id}`),
  createInvoice: (body: {
    supplierId: string;
    branchId: string;
    supplierInvoiceNumber: string;
    invoiceDate: string;
    notes?: string;
    confirm?: boolean;
    items: PurchaseInvoiceItemInput[];
  }) => api<PurchaseInvoiceDetail>("/purchases/invoices", { method: "POST", body: JSON.stringify(body) }),
  confirmInvoice: (id: string) =>
    api<PurchaseInvoiceDetail>(`/purchases/invoices/${id}/confirm`, { method: "POST" }),
  cancelInvoice: (id: string, reason: string) =>
    api<PurchaseInvoiceDetail>(`/purchases/invoices/${id}/cancel`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),

  attachmentDownloadPath: (id: string) => `/purchases/invoices/${id}/attachment`,
  uploadAttachment: (id: string, file: File) => uploadFile(`/purchases/invoices/${id}/attachment`, file),
};
