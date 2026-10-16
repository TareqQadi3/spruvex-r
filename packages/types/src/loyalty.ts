/**
 * Loyalty program catalog — 4 modes a tenant can enable independently, one or
 * more at a time, tenant-wide or overridden per branch (branchId = null vs a
 * specific branch, same nullable pattern as IntegrationConnection). Every
 * earn/redeem is a REAL order mutation (a real discount or a real $0 line via
 * OrderingService) — this catalog only shapes each program's own settings
 * JSON, never a parallel price.
 */

export const LOYALTY_PROGRAM_TYPES = [
  "stamp_card",
  "spend_threshold",
  "points_per_riyal",
  "tier",
] as const;
export type LoyaltyProgramType = (typeof LOYALTY_PROGRAM_TYPES)[number];

export interface LoyaltyProgramMeta {
  type: LoyaltyProgramType;
  nameAr: string;
  nameEn: string;
  descriptionAr: string;
  descriptionEn: string;
}

export const LOYALTY_PROGRAMS: Record<LoyaltyProgramType, LoyaltyProgramMeta> = {
  stamp_card: {
    type: "stamp_card",
    nameAr: "بطاقة الدمغات",
    nameEn: "Stamp card",
    descriptionAr: "دمغة لكل عملية بيع لصنف/فئة محددة — بعد عدد معيّن يحصل العميل على صنف مجاني",
    descriptionEn: "One stamp per sale of a chosen product/category — a free item after a set count",
  },
  spend_threshold: {
    type: "spend_threshold",
    nameAr: "خصم عند حد الإنفاق",
    nameEn: "Spend-threshold discount",
    descriptionAr: "خصم نسبته يحددها التاجر عند وصول إنفاق العميل التراكمي لحد معيّن",
    descriptionEn: "A merchant-set discount percent once a customer's cumulative spend hits a threshold",
  },
  points_per_riyal: {
    type: "points_per_riyal",
    nameAr: "نقاط لكل ريال",
    nameEn: "Points per riyal",
    descriptionAr: "نقاط تُكتسب من كل ريال، وتُستبدل بخصم نقدي حسب جدول تحويل يضبطه التاجر",
    descriptionEn: "Points earned per riyal spent, redeemable for a cash discount at a merchant-set rate",
  },
  tier: {
    type: "tier",
    nameAr: "مستويات العضوية",
    nameEn: "Membership tiers",
    descriptionAr: "ترقية دائمة حسب إجمالي الإنفاق طويل المدى، بخصم ثابت أعلى لكل مستوى",
    descriptionEn: "A permanent upgrade based on long-term lifetime spend, each tier granting a higher standing discount",
  },
};

export interface StampCardConfig {
  /** Stamps needed before a free item is granted. */
  stampsRequired: number;
  /** Only sales of this exact product earn a stamp (mutually exclusive with earnCategoryId). */
  earnProductId?: string;
  /** Any product in this category earns a stamp (mutually exclusive with earnProductId). */
  earnCategoryId?: string;
  /** The product given for free once stampsRequired is reached. */
  rewardProductId: string;
}

export interface SpendThresholdConfig {
  /** SAR — cumulative spend that triggers the discount. */
  thresholdAmount: string;
  /** 0-100 — the reward discount percent applied to the next order. */
  discountPercent: string;
  resetPeriod: "monthly" | "yearly" | "none";
  /** true = keep accumulating past the threshold (carry the remainder forward); false = reset to 0 on redemption. */
  carryOver: boolean;
}

export interface PointsPerRiyalConfig {
  /** Points earned per 1 SAR spent (e.g. 1 = 1pt/SAR, 0.5 = 1pt per 2 SAR). */
  pointsPerRiyal: number;
  /** Points needed per redemption unit (e.g. 100). */
  redemptionPointsUnit: number;
  /** SAR value of one redemption unit (e.g. "10.00" — 100 points = 10 SAR off). */
  redemptionSarValue: string;
}

export interface TierDefinition {
  /** Stable key stored on LoyaltyCustomer.tierKey. */
  key: string;
  nameAr: string;
  nameEn: string;
  /** SAR — lifetime spend required to reach this tier. */
  minSpend: string;
  /** 0-100 — standing discount percent applied to every order for members of this tier. */
  discountPercent: string;
}

export interface TierConfig {
  /** Sorted ascending by minSpend at save time. */
  tiers: TierDefinition[];
}

export type LoyaltyConfigShape =
  | StampCardConfig
  | SpendThresholdConfig
  | PointsPerRiyalConfig
  | TierConfig;
