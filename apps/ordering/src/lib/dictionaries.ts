export type Locale = "ar" | "en";

/** Nested string dictionary — values are widened to `string` so the ar/en
 * shapes (which differ only in literal text) are structurally interchangeable. */
type Dict = { [key: string]: string | Dict };

const rawDictionaries: Record<Locale, Dict> = {
  ar: {
    common: { language: "English", loading: "جارٍ التحميل...", error: "حدث خطأ", back: "رجوع" },
    menu: {
      categories: "الأقسام",
      empty: "لا توجد منتجات متاحة حالياً",
      addToCart: "إضافة للسلة",
      viewCart: "عرض السلة",
      required: "إلزامي",
      chooseMin: "اختر {{count}} على الأقل",
      chooseMax: "بحد أقصى {{count}}",
      table: "طاولة {{number}}",
      closed: "المطعم مغلق حالياً",
      unavailableQr: "رمز QR هذا لم يعد صالحاً",
    },
    cart: {
      title: "سلتك",
      empty: "السلة فارغة",
      quantity: "الكمية",
      notes: "ملاحظات (اختياري)",
      yourName: "اسمك (اختياري)",
      phone: "رقم الجوال",
      phoneRequired: "رقم الجوال مطلوب",
      total: "الإجمالي",
      submit: "إرسال الطلب",
      submitting: "جارٍ الإرسال...",
      pickupNotice: "طلب استلام من الفرع — الدفع عند الاستلام",
      dineInNotice: "سينضم طلبك لفاتورة الطاولة المشتركة ويصل للمطبخ فوراً",
      sent: "تم إرسال طلبك بنجاح",
      trackOrder: "تتبع الطلب",
      backToMenu: "رجوع للمنيو",
      remove: "حذف",
    },
    track: {
      title: "طلب رقم #{{number}}",
      tableNotice: "هذه فاتورة الطاولة المشتركة — يظهر فيها طلب الجميع",
      yourItems: "أصنافك",
      otherItems: "أصناف أخرى بالطاولة",
      orderMore: "أضف المزيد",
      status: {
        new: "تم استلام طلبك",
        confirmed: "تم تأكيد طلبك",
        preparing: "جاري تحضير طلبك",
        ready: "طلبك جاهز",
        served: "تم تقديم طلبك",
        completed: "اكتمل الطلب",
        cancelled: "تم إلغاء الطلب"
      },
      steps: { new: "استُلم", confirmed: "تأكيد", preparing: "تحضير", ready: "جاهز", served: "تقديم" },
      liveUpdates: "تحديثات لحظية",
      notFound: "الطلب غير موجود",
      newOrder: "طلب جديد"
    },
    restaurant: {
      pickupTitle: "استلام من الفرع",
      chooseBranch: "اختر الفرع",
      viewMenu: "عرض المنيو"
    },
    feedback: {
      title: "قيّم تجربتك",
      order: "طلب رقم #{{number}}",
      question: "كيف كانت تجربتك؟",
      commentLabel: "ملاحظة (اختياري)",
      commentPlaceholder: "أخبرنا بالمزيد...",
      submit: "إرسال التقييم",
      submitting: "جارٍ الإرسال...",
      thankYou: "شكرًا لتقييمك!",
      alreadyRated: "تم إرسال تقييمك مسبقًا لهذا الطلب — شكرًا لك",
      notFound: "رابط التقييم غير صالح"
    }
  },
  en: {
    common: { language: "العربية", loading: "Loading...", error: "Something went wrong", back: "Back" },
    menu: {
      categories: "Categories",
      empty: "No products available right now",
      addToCart: "Add to cart",
      viewCart: "View cart",
      required: "Required",
      chooseMin: "Choose at least {{count}}",
      chooseMax: "Up to {{count}}",
      table: "Table {{number}}",
      closed: "The restaurant is currently closed",
      unavailableQr: "This QR code is no longer valid",
    },
    cart: {
      title: "Your cart",
      empty: "Your cart is empty",
      quantity: "Quantity",
      notes: "Notes (optional)",
      yourName: "Your name (optional)",
      phone: "Phone number",
      phoneRequired: "Phone number is required",
      total: "Total",
      submit: "Place order",
      submitting: "Sending...",
      pickupNotice: "Pickup order — pay at the counter",
      dineInNotice: "Your order joins the table's shared bill and goes straight to the kitchen",
      sent: "Your order was sent successfully",
      trackOrder: "Track order",
      backToMenu: "Back to menu",
      remove: "Remove",
    },
    track: {
      title: "Order #{{number}}",
      tableNotice: "This is the table's shared bill — everyone's order shows up here",
      yourItems: "Your items",
      otherItems: "Others at the table",
      orderMore: "Order more",
      status: {
        new: "Order received",
        confirmed: "Order confirmed",
        preparing: "Preparing your order",
        ready: "Your order is ready",
        served: "Order served",
        completed: "Order completed",
        cancelled: "Order cancelled"
      },
      steps: { new: "Received", confirmed: "Confirmed", preparing: "Preparing", ready: "Ready", served: "Served" },
      liveUpdates: "Live updates",
      notFound: "Order not found",
      newOrder: "New order"
    },
    restaurant: {
      pickupTitle: "Pickup from branch",
      chooseBranch: "Choose a branch",
      viewMenu: "View menu"
    },
    feedback: {
      title: "Rate your experience",
      order: "Order #{{number}}",
      question: "How was your experience?",
      commentLabel: "Note (optional)",
      commentPlaceholder: "Tell us more...",
      submit: "Submit rating",
      submitting: "Sending...",
      thankYou: "Thanks for your feedback!",
      alreadyRated: "You've already rated this order — thank you",
      notFound: "This feedback link is not valid"
    }
  },
};

export const dictionaries = rawDictionaries;

export function getDictionary(locale: Locale) {
  return dictionaries[locale];
}

export function interpolate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => String(vars[key] ?? ""));
}
