/**
 * Third-party integrations & add-ons catalog: delivery platforms, digital-menu
 * payment gateways, NFC card terminals, and WhatsApp message templates.
 * Every provider list below is designed to grow — a new delivery platform or
 * payment gateway is a new entry here plus one adapter class implementing
 * the matching interface in apps/api, never a change to how orders/payments
 * flow through the system.
 */

// --- Delivery platforms ------------------------------------------------- //

export const DELIVERY_PROVIDER_KEYS = ["hungerstation"] as const;
export type DeliveryProviderKey = (typeof DELIVERY_PROVIDER_KEYS)[number];

export interface DeliveryProviderMeta {
  key: DeliveryProviderKey;
  nameAr: string;
  nameEn: string;
  descriptionAr: string;
  descriptionEn: string;
}

export const DELIVERY_PROVIDERS: Record<DeliveryProviderKey, DeliveryProviderMeta> = {
  hungerstation: {
    key: "hungerstation",
    nameAr: "هنقرستيشن",
    nameEn: "HungerStation",
    descriptionAr: "الطلبات تصل مباشرة وتظهر بشاشة المطبخ ونقاط البيع تلقائيًا",
    descriptionEn: "Orders arrive automatically and appear on your KDS/POS in real time",
  },
};

// --- Digital-menu payment gateways --------------------------------------- //

export const PAYMENT_GATEWAY_PROVIDER_KEYS = ["moyasar", "tap", "hyperpay"] as const;
export type PaymentGatewayProviderKey = (typeof PAYMENT_GATEWAY_PROVIDER_KEYS)[number];

export interface PaymentGatewayProviderMeta {
  key: PaymentGatewayProviderKey;
  nameAr: string;
  nameEn: string;
  descriptionAr: string;
  descriptionEn: string;
}

export const PAYMENT_GATEWAY_PROVIDERS: Record<PaymentGatewayProviderKey, PaymentGatewayProviderMeta> = {
  moyasar: {
    key: "moyasar",
    nameAr: "ماي‌سار (Moyasar)",
    nameEn: "Moyasar",
    descriptionAr: "مدى، Apple Pay وبطاقات — الأبسط للربط والأشهر بين الشركات الناشئة السعودية",
    descriptionEn: "Mada, Apple Pay & cards — the simplest to integrate, popular with Saudi startups",
  },
  tap: {
    key: "tap",
    nameAr: "تاب (Tap Payments)",
    nameEn: "Tap Payments",
    descriptionAr: "مدى، Apple Pay وبطاقات — خيار قوي وموثّق جيدًا بالسوق السعودي",
    descriptionEn: "Mada, Apple Pay & cards — a solid, well-documented option in the Saudi market",
  },
  hyperpay: {
    key: "hyperpay",
    nameAr: "هايبر‌باي (HyperPay)",
    nameEn: "HyperPay",
    descriptionAr: "انتشار مؤسسي واسع، لكن تدفق الدفع (Copy&Pay) أعقد تقنيًا من الخيارين أعلاه",
    descriptionEn: "Wide enterprise adoption, but its Copy&Pay checkout flow is more involved than the two above",
  },
};

// --- NFC card terminals (structure only — see nfc module doc comment) --- //

export const NFC_PROVIDER_KEYS = ["geidea"] as const;
export type NfcProviderKey = (typeof NFC_PROVIDER_KEYS)[number];

export interface NfcProviderMeta {
  key: NfcProviderKey;
  nameAr: string;
  nameEn: string;
  descriptionAr: string;
  descriptionEn: string;
}

export const NFC_PROVIDERS: Record<NfcProviderKey, NfcProviderMeta> = {
  geidea: {
    key: "geidea",
    nameAr: "جيديا (Geidea)",
    nameEn: "Geidea",
    descriptionAr: "من أكثر مزودي أجهزة الدفع اعتمادًا لدى مدى بالسوق السعودي، ويقدّم SDK لأجهزة أندرويد",
    descriptionEn: "One of the most mada-certified payment providers in Saudi, with an Android tablet SDK",
  },
};

// --- WhatsApp message templates ----------------------------------------- //

export const WHATSAPP_TEMPLATE_KEYS = [
  "order_received",
  "order_preparing",
  "order_ready",
  "invoice_sent",
  "order_feedback_request",
] as const;
export type WhatsappTemplateKey = (typeof WHATSAPP_TEMPLATE_KEYS)[number];

export interface WhatsappTemplateVariable {
  key: string;
  nameAr: string;
  nameEn: string;
  example: string;
}

/**
 * A system-defined starting point for a WhatsApp Message Template. WhatsApp
 * requires templates to be pre-approved by Meta (Business Manager → WhatsApp
 * Manager → Message Templates) before they can be sent outside a
 * customer-initiated 24h window — bodyAr's {{1}}, {{2}}... placeholders
 * match Meta's own positional-variable format exactly, so this text can be
 * submitted for approval as-is. The tenant may edit the wording before
 * first submitting (variable positions/count must stay the same), but once
 * Meta approves a template its wording is fixed — a later edit needs a new
 * approval, not a live edit.
 */
export interface WhatsappMessageTemplate {
  key: WhatsappTemplateKey;
  nameAr: string;
  nameEn: string;
  descriptionAr: string;
  descriptionEn: string;
  /** Meta's template category — "UTILITY" fits transactional order/receipt updates. */
  category: "UTILITY";
  /** Suggested name to register in Meta Business Manager (lowercase_snake_case, Meta's own requirement). */
  suggestedMetaName: string;
  variables: WhatsappTemplateVariable[];
  bodyAr: string;
}

export const WHATSAPP_MESSAGE_TEMPLATES: Record<WhatsappTemplateKey, WhatsappMessageTemplate> = {
  order_received: {
    key: "order_received",
    nameAr: "تم استلام الطلب",
    nameEn: "Order received",
    descriptionAr: "يُرسل فور استلام الطلب من المنيو الإلكتروني",
    descriptionEn: "Sent as soon as an order comes in from the digital menu",
    category: "UTILITY",
    suggestedMetaName: "spruvex_order_received",
    variables: [
      { key: "customerName", nameAr: "اسم العميل", nameEn: "Customer name", example: "أحمد" },
      { key: "orderNumber", nameAr: "رقم الطلب", nameEn: "Order number", example: "128" },
      { key: "restaurantName", nameAr: "اسم المطعم", nameEn: "Restaurant name", example: "مطعم الأصالة" },
      { key: "total", nameAr: "الإجمالي", nameEn: "Total", example: "85.50" },
    ],
    bodyAr: "مرحبًا {{1}}، تم استلام طلبك رقم {{2}} من {{3}} بمبلغ {{4}} ريال. سنُعلمك فور جاهزيته.",
  },
  order_preparing: {
    key: "order_preparing",
    nameAr: "جاري تجهيز الطلب",
    nameEn: "Order preparing",
    descriptionAr: "يُرسل عند بدء تجهيز الطلب بالمطبخ",
    descriptionEn: "Sent when the kitchen starts preparing the order",
    category: "UTILITY",
    suggestedMetaName: "spruvex_order_preparing",
    variables: [
      { key: "orderNumber", nameAr: "رقم الطلب", nameEn: "Order number", example: "128" },
      { key: "restaurantName", nameAr: "اسم المطعم", nameEn: "Restaurant name", example: "مطعم الأصالة" },
    ],
    bodyAr: "طلبك رقم {{1}} من {{2}} قيد التجهيز الآن.",
  },
  order_ready: {
    key: "order_ready",
    nameAr: "الطلب جاهز",
    nameEn: "Order ready",
    descriptionAr: "يُرسل عند جاهزية الطلب للاستلام",
    descriptionEn: "Sent when the order is ready for pickup",
    category: "UTILITY",
    suggestedMetaName: "spruvex_order_ready",
    variables: [
      { key: "orderNumber", nameAr: "رقم الطلب", nameEn: "Order number", example: "128" },
      { key: "restaurantName", nameAr: "اسم المطعم", nameEn: "Restaurant name", example: "مطعم الأصالة" },
    ],
    bodyAr: "طلبك رقم {{1}} من {{2}} جاهز الآن للاستلام.",
  },
  invoice_sent: {
    key: "invoice_sent",
    nameAr: "إرسال الفاتورة",
    nameEn: "Invoice sent",
    descriptionAr: "يُرسل فور إصدار الفاتورة الرسمية — تفاصيل الفاتورة مكتوبة بالرسالة مع رابط لعرضها كاملة",
    descriptionEn: "Sent as soon as the official invoice is issued — key details written out, plus a link to view it in full",
    category: "UTILITY",
    suggestedMetaName: "spruvex_invoice_sent",
    variables: [
      { key: "restaurantName", nameAr: "اسم المطعم", nameEn: "Restaurant name", example: "مطعم الأصالة" },
      { key: "receiptNumber", nameAr: "رقم الفاتورة", nameEn: "Receipt number", example: "4021" },
      { key: "total", nameAr: "الإجمالي", nameEn: "Total", example: "85.50" },
      { key: "receiptLink", nameAr: "رابط الفاتورة", nameEn: "Receipt link", example: "https://order.spruvex.app/receipt/..." },
    ],
    bodyAr: "فاتورتك من {{1}} — رقم الفاتورة {{2}}، الإجمالي {{3}} ريال. لعرض التفاصيل الكاملة: {{4}}",
  },
  order_feedback_request: {
    key: "order_feedback_request",
    nameAr: "طلب تقييم بعد الطلب",
    nameEn: "Post-order feedback request",
    descriptionAr:
      "يُرسل بعد اكتمال الطلب بحوالي 30 دقيقة — يطلب تقييمًا من 1 إلى 5 نجوم عبر رابط صفحة قصيرة",
    descriptionEn:
      "Sent ~30 minutes after the order completes — asks for a 1-5 star rating via a short link",
    category: "UTILITY",
    suggestedMetaName: "spruvex_order_feedback_request",
    variables: [
      { key: "customerName", nameAr: "اسم العميل", nameEn: "Customer name", example: "أحمد" },
      { key: "orderNumber", nameAr: "رقم الطلب", nameEn: "Order number", example: "128" },
      { key: "restaurantName", nameAr: "اسم المطعم", nameEn: "Restaurant name", example: "مطعم الأصالة" },
      { key: "feedbackLink", nameAr: "رابط التقييم", nameEn: "Feedback link", example: "https://order.spruvex.app/feedback/..." },
    ],
    bodyAr: "مرحبًا {{1}}، كيف كانت تجربتك مع طلبك رقم {{2}} من {{3}}؟ قيّمنا من هنا: {{4}}",
  },
};
