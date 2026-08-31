import { api, patch } from "./api";

export type TenantStatus = "active" | "suspended";
export type SubscriptionStatus = "trialing" | "active" | "past_due" | "suspended" | "cancelled";

export interface TenantListItem {
  id: string;
  name: string;
  nameEn: string | null;
  slug: string;
  status: TenantStatus;
  country: string;
  createdAt: string;
  onboardingCompletedAt: string | null;
  branchCount: number;
  subscription: {
    status: SubscriptionStatus;
    trialEndsAt: string | null;
    plan: { key: string; name: string; nameEn: string | null };
  } | null;
}

export interface TenantDetail extends Omit<TenantListItem, "branchCount" | "subscription"> {
  userCount: number;
  branches: Array<{ id: string; name: string; nameEn: string | null; isActive: boolean }>;
  subscription: {
    id: string;
    status: SubscriptionStatus;
    trialEndsAt: string | null;
    currentPeriodEnd: string | null;
    plan: { key: string; name: string; nameEn: string | null; maxBranches: number; maxUsers: number };
  } | null;
}

export interface SubscriptionListItem {
  id: string;
  status: SubscriptionStatus;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  tenant: { id: string; name: string; nameEn: string | null; slug: string; status: TenantStatus };
  plan: { key: string; name: string; nameEn: string | null };
}

export interface SystemStatus {
  database: "ok" | "down";
  tenants: { total: number; active: number; suspended: number };
  subscriptions: Record<string, number>;
}

export interface PlatformSettings {
  otpTtlMinutes: number;
  otpMaxVerifyAttempts: number;
  maxFailedLogins: number;
  lockoutMinutes: number;
  maxUploadBytes: number;
}

export interface PlatformSettingsAuditEntry {
  id: string;
  action: string;
  createdAt: string;
  meta: { changes?: Record<string, { from: unknown; to: unknown }>; platformAdminEmail?: string };
  platformAdmin: { name: string; email: string };
}

export const platformApi = {
  listTenants: (params: { search?: string; status?: TenantStatus } = {}) => {
    const qs = new URLSearchParams();
    if (params.search) qs.set("search", params.search);
    if (params.status) qs.set("status", params.status);
    const suffix = qs.toString();
    return api<TenantListItem[]>(`/platform/tenants${suffix ? `?${suffix}` : ""}`);
  },
  getTenant: (id: string) => api<TenantDetail>(`/platform/tenants/${id}`),
  setTenantStatus: (id: string, status: TenantStatus) =>
    patch(`/platform/tenants/${id}/status`, { status }),

  listSubscriptions: () => api<SubscriptionListItem[]>("/platform/subscriptions"),
  setSubscriptionStatus: (id: string, status: SubscriptionStatus) =>
    patch(`/platform/subscriptions/${id}/status`, { status }),
  changeSubscriptionPlan: (id: string, planKey: string) =>
    patch(`/platform/subscriptions/${id}/plan`, { planKey }),

  systemStatus: () => api<SystemStatus>("/platform/system-status"),

  getSettings: () => api<PlatformSettings>("/platform/settings"),
  updateSettings: (body: Partial<PlatformSettings>) => patch<PlatformSettings>("/platform/settings", body),
  settingsAuditLog: () => api<PlatformSettingsAuditEntry[]>("/platform/settings/audit-log"),
};
