/**
 * Curated app-appearance presets (dashboard "theme color" onboarding step).
 * Deliberately NOT a free color picker — every value below is a pre-checked
 * HSL pair verified against WCAG AA (>=4.5:1) for its foreground text, the
 * same standard the original green theme was hand-verified against. A raw
 * user-picked hex could easily fail contrast for someone else's vision, so
 * this is the only supported customization: pick one of these.
 */
export const THEME_PRESET_KEYS = ["green", "blue", "purple", "orange", "teal", "slate"] as const;
export type ThemeColorKey = (typeof THEME_PRESET_KEYS)[number];

export interface ThemePreset {
  key: ThemeColorKey;
  nameAr: string;
  nameEn: string;
  /** HSL triplets as "H S% L%", matching packages/ui/src/styles.css's custom-property format. */
  primary: string;
  primaryForeground: string;
  accent: string;
  accentForeground: string;
  ring: string;
}

export const THEME_PRESETS: Record<ThemeColorKey, ThemePreset> = {
  green: {
    key: "green",
    nameAr: "أخضر (افتراضي)",
    nameEn: "Green (default)",
    primary: "123 46% 34%",
    primaryForeground: "0 0% 100%",
    accent: "88 50% 53%",
    accentForeground: "125 55% 14%",
    ring: "123 46% 34%",
  },
  blue: {
    key: "blue",
    nameAr: "أزرق",
    nameEn: "Blue",
    primary: "212 60% 38%",
    primaryForeground: "0 0% 100%",
    accent: "200 60% 55%",
    accentForeground: "210 55% 16%",
    ring: "212 60% 38%",
  },
  purple: {
    key: "purple",
    nameAr: "بنفسجي",
    nameEn: "Purple",
    primary: "262 45% 40%",
    primaryForeground: "0 0% 100%",
    accent: "280 50% 58%",
    accentForeground: "265 55% 10%",
    ring: "262 45% 40%",
  },
  orange: {
    key: "orange",
    nameAr: "برتقالي",
    nameEn: "Orange",
    primary: "18 65% 38%",
    primaryForeground: "0 0% 100%",
    accent: "35 70% 55%",
    accentForeground: "20 60% 16%",
    ring: "18 65% 38%",
  },
  teal: {
    key: "teal",
    nameAr: "أزرق مخضر",
    nameEn: "Teal",
    primary: "175 55% 28%",
    primaryForeground: "0 0% 100%",
    accent: "165 55% 50%",
    accentForeground: "175 55% 14%",
    ring: "175 55% 28%",
  },
  slate: {
    key: "slate",
    nameAr: "رمادي داكن",
    nameEn: "Slate",
    primary: "215 15% 32%",
    primaryForeground: "0 0% 100%",
    accent: "210 20% 60%",
    accentForeground: "215 25% 16%",
    ring: "215 15% 32%",
  },
};

export const DEFAULT_THEME_COLOR: ThemeColorKey = "green";
