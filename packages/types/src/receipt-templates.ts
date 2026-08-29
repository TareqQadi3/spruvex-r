/** Printed-receipt layout choices — the POS renders one of these three. */
export const RECEIPT_TEMPLATE_KEYS = ["classic", "modern", "minimal"] as const;
export type ReceiptTemplateKey = (typeof RECEIPT_TEMPLATE_KEYS)[number];

export interface ReceiptTemplateMeta {
  key: ReceiptTemplateKey;
  nameAr: string;
  nameEn: string;
  descriptionAr: string;
  descriptionEn: string;
}

export const RECEIPT_TEMPLATES: Record<ReceiptTemplateKey, ReceiptTemplateMeta> = {
  classic: {
    key: "classic",
    nameAr: "كلاسيكي",
    nameEn: "Classic",
    descriptionAr: "التصميم المعتاد — عناوين وخطوط فاصلة بسيطة",
    descriptionEn: "The familiar layout — plain headings and divider lines",
  },
  modern: {
    key: "modern",
    nameAr: "عصري",
    nameEn: "Modern",
    descriptionAr: "عناوين أكبر وشريط لوني بلون التطبيق المختار",
    descriptionEn: "Bigger headings with an accent bar in your chosen app color",
  },
  minimal: {
    key: "minimal",
    nameAr: "مبسّط",
    nameEn: "Minimal",
    descriptionAr: "أقل تباعدًا وأصغر حجمًا — مناسب لورق الطباعة الحراري الضيق",
    descriptionEn: "Tighter spacing, smaller — good for narrow thermal paper",
  },
};

export const DEFAULT_RECEIPT_TEMPLATE: ReceiptTemplateKey = "classic";

export const RECEIPT_LOGO_POSITIONS = ["top-center", "top-start", "none"] as const;
export type ReceiptLogoPosition = (typeof RECEIPT_LOGO_POSITIONS)[number];
export const DEFAULT_RECEIPT_LOGO_POSITION: ReceiptLogoPosition = "top-center";

export const RECEIPT_LOGO_SIZES = ["small", "medium", "large"] as const;
export type ReceiptLogoSize = (typeof RECEIPT_LOGO_SIZES)[number];
export const DEFAULT_RECEIPT_LOGO_SIZE: ReceiptLogoSize = "medium";
