import { api } from "./api";

export type LoyaltyProgramType = "stamp_card" | "spend_threshold" | "points_per_riyal" | "tier";

export interface LoyaltyConfigRow {
  id: string;
  type: LoyaltyProgramType;
  branchId: string | null;
  isEnabled: boolean;
  config: Record<string, unknown>;
  isOverride?: boolean;
}

export interface LoyaltyBalance {
  phone: string;
  exists: boolean;
  stampCount: number;
  spendAccumulated: string;
  pointsBalance: number;
  lifetimeSpend: string;
  tierKey: string | null;
  tierName: string | null;
}

export const loyaltyApi = {
  listConfigs: (branchId?: string) =>
    api<LoyaltyConfigRow[]>(`/loyalty/configs${branchId ? `?branchId=${branchId}` : ""}`),
  upsertConfig: (type: LoyaltyProgramType, body: { branchId?: string; isEnabled: boolean; config: Record<string, unknown> }) =>
    api<LoyaltyConfigRow>(`/loyalty/configs/${type}`, { method: "PUT", body: JSON.stringify(body) }),
  removeOverride: (type: LoyaltyProgramType, branchId: string) =>
    api(`/loyalty/configs/${type}?branchId=${branchId}`, { method: "DELETE" }),

  getBalance: (phone: string) => api<LoyaltyBalance>(`/loyalty/customers/${encodeURIComponent(phone)}`),
  redeem: (orderId: string, type: LoyaltyProgramType) =>
    api(`/loyalty/orders/${orderId}/redeem`, { method: "POST", body: JSON.stringify({ type }) }),
};
