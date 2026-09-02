import { api, post } from "./api";

/** Types mirroring the catalog API responses (Decimals serialize as strings). */

export interface Category {
  id: string;
  name: string;
  nameEn: string | null;
  description: string | null;
  descriptionEn: string | null;
  imageUrl: string | null;
  sortOrder: number;
  isActive: boolean;
  _count?: { products: number };
}

export interface ModifierOption {
  id: string;
  name: string;
  nameEn: string | null;
  priceAdjustment: string;
  sortOrder: number;
  isActive: boolean;
}

export interface ModifierGroup {
  id: string;
  name: string;
  nameEn: string | null;
  isRequired: boolean;
  minSelect: number;
  maxSelect: number | null;
  sortOrder: number;
  isActive: boolean;
  modifiers: ModifierOption[];
  _count?: { products: number };
}

export interface BranchSetting {
  branchId: string;
  priceOverride: string | null;
  isAvailable: boolean;
  unavailableReason?: "manual" | "sold_out_today" | "stock" | null;
  soldOutDate?: string | null;
  branch: { name: string; nameEn: string | null };
}

export interface ChannelOverride {
  branchId: string;
  channel: "dine_in" | "takeaway" | "delivery";
  isVisible: boolean;
  priceOverride: string | null;
  branch: { name: string; nameEn: string | null };
}

export interface Product {
  id: string;
  name: string;
  nameEn: string | null;
  description: string | null;
  descriptionEn: string | null;
  imageUrl: string | null;
  sku: string | null;
  basePrice: string;
  taxRate: string | null;
  sortOrder: number;
  isActive: boolean;
  categoryId: string;
  category: { id: string; name: string; nameEn: string | null };
  badges: string[];
  prepTimeMinutes: number | null;
  branchSettings: BranchSetting[];
  modifierGroups: Array<{
    modifierGroupId: string;
    sortOrder: number;
    group: Pick<ModifierGroup, "id" | "name" | "nameEn" | "isRequired" | "minSelect" | "maxSelect" | "modifiers">;
  }>;
}

export const catalogApi = {
  listCategories: () => api<Category[]>("/catalog/categories"),
  createCategory: (body: unknown) => post<Category>("/catalog/categories", body),
  updateCategory: (id: string, body: unknown) =>
    api<Category>(`/catalog/categories/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteCategory: (id: string) => api(`/catalog/categories/${id}`, { method: "DELETE" }),

  listProducts: (categoryId?: string) =>
    api<Product[]>(`/catalog/products${categoryId ? `?categoryId=${categoryId}` : ""}`),
  getProduct: (id: string) => api<Product>(`/catalog/products/${id}`),
  createProduct: (body: unknown) => post<Product>("/catalog/products", body),
  updateProduct: (id: string, body: unknown) =>
    api<Product>(`/catalog/products/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteProduct: (id: string) => api(`/catalog/products/${id}`, { method: "DELETE" }),
  setProductModifierGroups: (id: string, groups: Array<{ modifierGroupId: string; sortOrder?: number }>) =>
    api<Product>(`/catalog/products/${id}/modifier-groups`, {
      method: "PUT",
      body: JSON.stringify({ groups }),
    }),
  setBranchSetting: (
    id: string,
    branchId: string,
    body: { isAvailable: boolean; priceOverride?: string | null },
  ) =>
    api<BranchSetting>(`/catalog/products/${id}/branch-settings/${branchId}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  markSoldOutToday: (id: string, branchId: string) =>
    post<BranchSetting>(`/catalog/products/${id}/branch-settings/${branchId}/sold-out-today`, {}),
  markUnavailable: (id: string, branchId: string) =>
    post<BranchSetting>(`/catalog/products/${id}/branch-settings/${branchId}/unavailable`, {}),
  markAvailable: (id: string, branchId: string) =>
    post<BranchSetting>(`/catalog/products/${id}/branch-settings/${branchId}/available`, {}),
  listChannelOverrides: (id: string) => api<ChannelOverride[]>(`/catalog/products/${id}/channel-overrides`),
  setChannelOverride: (
    id: string,
    branchId: string,
    body: { channel: "dine_in" | "takeaway" | "delivery"; isVisible: boolean; priceOverride?: string | null },
  ) =>
    api<ChannelOverride>(`/catalog/products/${id}/branch-settings/${branchId}/channel`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),

  listModifierGroups: () => api<ModifierGroup[]>("/catalog/modifier-groups"),
  createModifierGroup: (body: unknown) => post<ModifierGroup>("/catalog/modifier-groups", body),
  updateModifierGroup: (id: string, body: unknown) =>
    api<ModifierGroup>(`/catalog/modifier-groups/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  deleteModifierGroup: (id: string) => api(`/catalog/modifier-groups/${id}`, { method: "DELETE" }),
  createModifier: (groupId: string, body: unknown) =>
    post<ModifierOption>(`/catalog/modifier-groups/${groupId}/modifiers`, body),
  updateModifier: (id: string, body: unknown) =>
    api<ModifierOption>(`/catalog/modifiers/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteModifier: (id: string) => api(`/catalog/modifiers/${id}`, { method: "DELETE" }),
};

/** Display helper: bilingual name by current language. */
export function localizedName(
  item: { name: string; nameEn?: string | null },
  language: string,
): string {
  return language === "en" && item.nameEn ? item.nameEn : item.name;
}
