import { api, post } from "./api";

/** Types mirroring the inventory & reports API responses (Decimals serialize as strings). */

export type UnitType = "mass" | "volume" | "count";

export interface UnitOfMeasure {
  id: string;
  code: string;
  name: string;
  nameEn: string;
  type: UnitType;
  toBaseFactor: string;
}

export interface Ingredient {
  id: string;
  name: string;
  nameEn: string | null;
  unitType: UnitType;
  averageCost: string;
  reorderLevel: string | null;
  isActive: boolean;
}

export interface StockLocation {
  id: string;
  branchId: string;
  name: string;
  nameEn: string | null;
  isDefault: boolean;
  isActive: boolean;
}

export interface StockLevel {
  id: string;
  branchId: string;
  locationId: string;
  ingredientId: string;
  quantity: string;
  updatedAt: string;
  ingredient: { id: string; name: string; nameEn: string | null; unitType: UnitType; reorderLevel: string | null };
  location: { id: string; name: string; nameEn: string | null };
}

export type StockMovementType = "purchase" | "sale_deduction" | "waste" | "adjustment" | "transfer_in" | "transfer_out";

export interface StockMovement {
  id: string;
  type: StockMovementType;
  quantity: string;
  unitCost: string | null;
  referenceType: string | null;
  reason: string | null;
  createdAt: string;
  ingredient: { id: string; name: string; nameEn: string | null };
  location: { id: string; name: string; nameEn: string | null };
}

export interface RecipeItemRow {
  id: string;
  ingredientId: string;
  unitId: string;
  quantity: string;
  notes: string | null;
  isCritical: boolean;
  criticalThreshold: string | null;
  ingredient: { id: string; name: string; nameEn: string | null; unitType: UnitType };
  unit: UnitOfMeasure;
}

export interface Recipe {
  product: { id: string; name: string; nameEn: string | null };
  items: RecipeItemRow[];
}

export interface ProductCost {
  productId: string;
  productName: string;
  sellingPrice: string;
  cost: string;
  grossMargin: string;
  grossMarginPercent: string;
  hasRecipe: boolean;
}

export const inventoryApi = {
  listUnits: () => api<UnitOfMeasure[]>("/inventory/units"),

  listIngredients: () => api<Ingredient[]>("/inventory/ingredients"),
  createIngredient: (body: unknown) => post<Ingredient>("/inventory/ingredients", body),
  updateIngredient: (id: string, body: unknown) =>
    api<Ingredient>(`/inventory/ingredients/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteIngredient: (id: string) => api(`/inventory/ingredients/${id}`, { method: "DELETE" }),

  listLocations: (branchId?: string) =>
    api<StockLocation[]>(`/inventory/locations${branchId ? `?branchId=${branchId}` : ""}`),
  createLocation: (body: unknown) => post<StockLocation>("/inventory/locations", body),
  updateLocation: (id: string, body: unknown) =>
    api<StockLocation>(`/inventory/locations/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteLocation: (id: string) => api(`/inventory/locations/${id}`, { method: "DELETE" }),

  listLevels: (branchId?: string) =>
    api<StockLevel[]>(`/inventory/stock-levels${branchId ? `?branchId=${branchId}` : ""}`),
  listMovements: (filter: { branchId?: string; ingredientId?: string; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (filter.branchId) params.set("branchId", filter.branchId);
    if (filter.ingredientId) params.set("ingredientId", filter.ingredientId);
    if (filter.limit) params.set("limit", String(filter.limit));
    const qs = params.toString();
    return api<StockMovement[]>(`/inventory/movements${qs ? `?${qs}` : ""}`);
  },
  recordPurchase: (body: unknown) => post<StockMovement>("/inventory/stock/purchase", body),
  recordWaste: (body: unknown) => post<StockMovement>("/inventory/stock/waste", body),
  recordAdjustment: (body: unknown) => post<StockMovement>("/inventory/stock/adjustment", body),

  getRecipe: (productId: string) => api<Recipe>(`/products/${productId}/recipe`),
  setRecipe: (
    productId: string,
    items: Array<{
      ingredientId: string;
      unitId: string;
      quantity: string;
      notes?: string;
      isCritical?: boolean;
      criticalThreshold?: string;
    }>,
  ) => api<Recipe>(`/products/${productId}/recipe`, { method: "PUT", body: JSON.stringify({ items }) }),
  getProductCost: (productId: string) => api<ProductCost>(`/products/${productId}/recipe/cost`),
};

export interface DailySales {
  date: string;
  orderCount: number;
  subtotal: string;
  discount: string;
  vatAmount: string;
  total: string;
  avgOrderValue: string;
}

export interface BestSeller {
  productId: string;
  name: string;
  nameEn: string | null;
  quantitySold: number;
  revenue: string;
}

export interface OperationsReport {
  orderCount: number;
  cancelledCount: number;
  avgOrderValue: string;
  avgPrepTimeMinutes: number | null;
}

export interface FinancialReport {
  orderCount: number;
  revenue: string;
  discounts: string;
  vatCollected: string;
  total: string;
  foodCost: string;
  foodCostPercent: string;
  grossMargin: string;
  grossMarginPercent: string;
}

export interface DashboardSummary {
  todaySales: { orderCount: number; total: string; avgOrderValue: string };
  bestSellers: BestSeller[];
  lowStockAlerts: Array<{ ingredientId: string; name: string; nameEn: string | null; quantity: string; reorderLevel: string }>;
  autoHiddenAlerts: Array<{
    productId: string;
    productName: string;
    productNameEn: string | null;
    branchName: string;
    branchNameEn: string | null;
    ingredientName: string;
    ingredientNameEn: string | null;
    hiddenAt: string;
  }>;
}

export interface RatingsBranchRow {
  branchId: string;
  name: string;
  nameEn: string | null;
  count: number;
  avgRating: number;
}

export interface LowRatingRow {
  id: string;
  orderId: string;
  orderNumber: number;
  customerName: string | null;
  rating: number;
  comment: string | null;
  ratedAt: string;
  branchName: string;
  branchNameEn: string | null;
  productName: string | null;
  productNameEn: string | null;
}

export interface RatingsSummary {
  avgRating: number | null;
  count: number;
  byBranch: RatingsBranchRow[];
  lowRatings: LowRatingRow[];
}

export interface VatReturnLineItem {
  type: "sale" | "credit_note" | "debit_note" | "purchase";
  branchName: string;
  branchNameEn: string | null;
  /** A ZATCA-style sequential number for sales-side lines; the supplier's own
   * (string) invoice number for a "purchase" line. */
  documentNumber: number | string;
  referenceReceiptNumber: number | null;
  orderNumber: number | null;
  supplierName?: string;
  supplierNameEn?: string | null;
  issuedAt: string;
  vatRatePercent: string;
  netAmount: string;
  vatAmount: string;
  total: string;
}

export interface VatReturnRateBucket {
  vatRatePercent: string;
  salesNet: string;
  salesVat: string;
  salesCount: number;
  creditNoteNet: string;
  creditNoteVat: string;
  creditNoteCount: number;
  debitNoteNet: string;
  debitNoteVat: string;
  debitNoteCount: number;
  netTaxableSales: string;
  netVat: string;
}

export interface VatReturnResult {
  tenant: { name: string; nameEn: string | null; legalName: string | null; vatNumber: string | null; crNumber: string | null };
  branch: { id: string; name: string; nameEn: string | null } | null;
  period: { from: string; to: string };
  byRate: VatReturnRateBucket[];
  totals: { netTaxableSales: string; outputVat: string };
  inputTax: { supported: boolean; note: string; netAmount: string; vatAmount: string; invoiceCount: number };
  netVatDue: string;
  lineItems: VatReturnLineItem[];
}

export interface BranchComparisonRow {
  branchId: string;
  branchName: string;
  branchNameEn: string | null;
  orderCount: number;
  totalSales: string;
  avgOrderValue: string;
  topProducts: Array<{ productId: string; name: string; nameEn: string | null; quantitySold: number }>;
  loyalty: { enabled: boolean; usagePercent: number | null; ordersWithLoyalty: number };
  ratings: { avgRating: number | null; count: number };
}

export interface BranchComparisonResult {
  period: { from: string; to: string };
  loyaltyAvailable: boolean;
  ratingsAvailable: boolean;
  rows: BranchComparisonRow[];
}

export const reportsApi = {
  dailySales: (branchId?: string, date?: string) => {
    const params = new URLSearchParams();
    if (branchId) params.set("branchId", branchId);
    if (date) params.set("date", date);
    const qs = params.toString();
    return api<DailySales>(`/reports/sales/daily${qs ? `?${qs}` : ""}`);
  },
  bestSellers: (branchId?: string, from?: string, to?: string, limit = 10) => {
    const params = new URLSearchParams();
    if (branchId) params.set("branchId", branchId);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    params.set("limit", String(limit));
    return api<BestSeller[]>(`/reports/sales/best-sellers?${params.toString()}`);
  },
  operations: (branchId?: string, from?: string, to?: string) => {
    const params = new URLSearchParams();
    if (branchId) params.set("branchId", branchId);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    const qs = params.toString();
    return api<OperationsReport>(`/reports/operations${qs ? `?${qs}` : ""}`);
  },
  financial: (branchId?: string, from?: string, to?: string) => {
    const params = new URLSearchParams();
    if (branchId) params.set("branchId", branchId);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    const qs = params.toString();
    return api<FinancialReport>(`/reports/financial${qs ? `?${qs}` : ""}`);
  },
  dashboardSummary: (branchId?: string) =>
    api<DashboardSummary>(`/reports/dashboard-summary${branchId ? `?branchId=${branchId}` : ""}`),
  ratings: (branchId?: string, from?: string, to?: string) => {
    const params = new URLSearchParams();
    if (branchId) params.set("branchId", branchId);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    const qs = params.toString();
    return api<RatingsSummary>(`/reports/ratings${qs ? `?${qs}` : ""}`);
  },
  vatReturn: (branchId?: string, from?: string, to?: string) => {
    const params = new URLSearchParams();
    if (branchId) params.set("branchId", branchId);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    const qs = params.toString();
    return api<VatReturnResult>(`/reports/vat-return${qs ? `?${qs}` : ""}`);
  },
  vatReturnDownloadPath: (format: "csv" | "pdf", branchId?: string, from?: string, to?: string) => {
    const params = new URLSearchParams();
    if (branchId) params.set("branchId", branchId);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    const qs = params.toString();
    return `/reports/vat-return.${format}${qs ? `?${qs}` : ""}`;
  },
  branchComparison: (from?: string, to?: string, branchIds?: string[]) => {
    const params = new URLSearchParams();
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    if (branchIds && branchIds.length > 0) params.set("branchIds", branchIds.join(","));
    const qs = params.toString();
    return api<BranchComparisonResult>(`/reports/branch-comparison${qs ? `?${qs}` : ""}`);
  },
};
