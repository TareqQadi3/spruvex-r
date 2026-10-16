// Namespace import — Rollup's static CJS-interop analysis (used by the app
// bundlers that consume this package) cannot resolve a named import of a
// const re-exported through packages/types/src/index.ts's barrel file, even
// though the compiled output itself is correct (see SubscriptionsPage.tsx's
// PLAN_CATALOG import for the same workaround).
import * as SpruvexTypes from "@spruvex-r/types";
import type { ThemeColorKey } from "@spruvex-r/types";

/**
 * Applies a tenant's chosen theme preset by overriding the CSS custom
 * properties styles.css defines on :root. Safe to call with an unknown/
 * missing key (falls back to the default green theme) — a tenant that never
 * visited the onboarding theme step, or an app that never calls this at all,
 * renders exactly as before this feature existed.
 */
export function applyThemeColor(themeColor: string | null | undefined): void {
  const { THEME_PRESETS, DEFAULT_THEME_COLOR } = SpruvexTypes;
  const preset = THEME_PRESETS[(themeColor as ThemeColorKey) ?? DEFAULT_THEME_COLOR] ?? THEME_PRESETS[DEFAULT_THEME_COLOR];
  const root = document.documentElement.style;
  root.setProperty("--primary", preset.primary);
  root.setProperty("--primary-foreground", preset.primaryForeground);
  root.setProperty("--accent", preset.accent);
  root.setProperty("--accent-foreground", preset.accentForeground);
  root.setProperty("--ring", preset.ring);
}
