/**
 * Public digital-menu (apps/ordering) appearance presets. Each preset only
 * touches colorway + shape + heading font — never markup — via CSS custom
 * properties the ordering app's components already read (see
 * apps/ordering/src/components/MenuThemeStyle.tsx). Colorways reuse the
 * same WCAG AA-checked hue pairs as the dashboard's THEME_PRESETS (see
 * theme.ts) rather than re-deriving new ones.
 *
 * "custom" is the escape hatch: instead of one of these presets, the tenant
 * supplies their own CSS (sanitized server-side — see
 * shared/security/menu-css-sanitizer.ts — before it's ever stored).
 */
export const MENU_TEMPLATE_KEYS = ["classic", "modern", "elegant", "vibrant", "custom"] as const;
export type MenuTemplateKey = (typeof MENU_TEMPLATE_KEYS)[number];

export type MenuPresetKey = Exclude<MenuTemplateKey, "custom">;
export const MENU_PRESET_KEYS = MENU_TEMPLATE_KEYS.filter(
  (key): key is MenuPresetKey => key !== "custom",
);

/**
 * The class every sanitized custom-CSS selector gets scoped under (see
 * apps/api/src/shared/security/menu-css-sanitizer.ts) — shared here so the
 * ordering app's wrapping element uses the exact same literal, rather than
 * two independently-maintained copies of the same string drifting apart.
 */
export const MENU_CSS_SCOPE_CLASS = "spx-menu-custom";

export interface MenuTemplatePreset {
  key: MenuPresetKey;
  nameAr: string;
  nameEn: string;
  descriptionAr: string;
  descriptionEn: string;
  /** HSL triplets as "H S% L%", same format as theme.ts. */
  primary: string;
  primaryForeground: string;
  accent: string;
  accentForeground: string;
  cardRadius: string;
  pillRadius: string;
  cardBorder: string;
  cardShadow: string;
  headingFont: string;
  headingWeight: string;
}

export const MENU_TEMPLATES: Record<MenuPresetKey, MenuTemplatePreset> = {
  classic: {
    key: "classic",
    nameAr: "كلاسيكي",
    nameEn: "Classic",
    descriptionAr: "التصميم الحالي — بطاقات مستديرة بحد بسيط",
    descriptionEn: "Today's look — rounded cards with a plain border",
    primary: "123 46% 34%",
    primaryForeground: "0 0% 100%",
    accent: "88 50% 53%",
    accentForeground: "125 55% 14%",
    cardRadius: "0.75rem",
    pillRadius: "9999px",
    cardBorder: "1px solid hsl(var(--border))",
    cardShadow: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
    headingFont: '"IBM Plex Sans Arabic", "Inter", system-ui, sans-serif',
    headingWeight: "600",
  },
  modern: {
    key: "modern",
    nameAr: "عصري",
    nameEn: "Modern",
    descriptionAr: "بطاقات أكبر استدارة بدون حدود وظل أوضح، بلون أزرق",
    descriptionEn: "Bigger rounded cards, no border, a bolder shadow, in blue",
    primary: "212 60% 38%",
    primaryForeground: "0 0% 100%",
    accent: "200 60% 55%",
    accentForeground: "210 55% 16%",
    cardRadius: "1.25rem",
    pillRadius: "9999px",
    cardBorder: "none",
    cardShadow: "0 4px 14px 0 rgb(0 0 0 / 0.10)",
    headingFont: '"Inter", "IBM Plex Sans Arabic", system-ui, sans-serif',
    headingWeight: "700",
  },
  elegant: {
    key: "elegant",
    nameAr: "أنيق",
    nameEn: "Elegant",
    descriptionAr: "زوايا شبه حادة وحد رفيع بدون ظل، بلون رمادي داكن هادئ",
    descriptionEn: "Near-sharp corners, a thin border, no shadow, in quiet slate",
    primary: "215 15% 32%",
    primaryForeground: "0 0% 100%",
    accent: "210 20% 60%",
    accentForeground: "215 25% 16%",
    cardRadius: "0.375rem",
    pillRadius: "0.375rem",
    cardBorder: "1px solid hsl(var(--border))",
    cardShadow: "none",
    headingFont: '"Inter", "IBM Plex Sans Arabic", system-ui, sans-serif',
    headingWeight: "700",
  },
  vibrant: {
    key: "vibrant",
    nameAr: "جريء",
    nameEn: "Vibrant",
    descriptionAr: "استدارة كبيرة وظل قوي، بلون برتقالي مفعم",
    descriptionEn: "Large pill-like curves and a strong shadow, in punchy orange",
    primary: "18 65% 38%",
    primaryForeground: "0 0% 100%",
    accent: "35 70% 55%",
    accentForeground: "20 60% 16%",
    cardRadius: "1.5rem",
    pillRadius: "9999px",
    cardBorder: "none",
    cardShadow: "0 6px 18px 0 rgb(0 0 0 / 0.12)",
    headingFont: '"IBM Plex Sans Arabic", "Inter", system-ui, sans-serif',
    headingWeight: "700",
  },
};

export const DEFAULT_MENU_TEMPLATE: MenuTemplateKey = "classic";
