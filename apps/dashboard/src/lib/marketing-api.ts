import { api } from "./api";

export type CouponDiscountType = "percentage" | "fixed";
export type CouponChannel = "dine_in" | "takeaway" | "delivery";

export interface Coupon {
  id: string;
  code: string;
  discountType: CouponDiscountType;
  discountValue: string;
  maxDiscountAmount: string | null;
  minOrderAmount: string;
  channels: CouponChannel[];
  startAt: string | null;
  endAt: string | null;
  maxRedemptions: number | null;
  maxRedemptionsPerCustomer: number | null;
  isActive: boolean;
  createdAt: string;
}

export interface CreateCouponInput {
  code: string;
  discountType: CouponDiscountType;
  discountValue: string;
  maxDiscountAmount?: string;
  minOrderAmount?: string;
  channels?: CouponChannel[];
  startAt?: string;
  endAt?: string;
  maxRedemptions?: number;
  maxRedemptionsPerCustomer?: number;
}

export type UpdateCouponInput = Partial<CreateCouponInput & { isActive: boolean }>;

export const marketingApi = {
  listCoupons: () => api<Coupon[]>("/marketing/coupons"),
  createCoupon: (body: CreateCouponInput) =>
    api<Coupon>("/marketing/coupons", { method: "POST", body: JSON.stringify(body) }),
  updateCoupon: (id: string, body: UpdateCouponInput) =>
    api<Coupon>(`/marketing/coupons/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteCoupon: (id: string) => api<void>(`/marketing/coupons/${id}`, { method: "DELETE" }),
};
