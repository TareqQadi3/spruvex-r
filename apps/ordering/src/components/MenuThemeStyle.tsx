// Namespace import — see packages/ui/src/apply-theme.ts for why a named
// import of a const re-exported through @spruvex-r/types' barrel file can
// break a bundler's static CJS-interop analysis; used here defensively even
// though Next.js's webpack build hasn't been observed to hit it.
import * as SpruvexTypes from "@spruvex-r/types";

const { MENU_TEMPLATES, MENU_PRESET_KEYS } = SpruvexTypes;
type MenuPresetKey = (typeof MENU_PRESET_KEYS)[number];

/**
 * Renders the digital menu's chosen appearance: either one of the curated
 * presets (as CSS custom properties MenuHeader/CategoryNav/ProductCard
 * already read) or, for "custom", the tenant's own CSS — already sanitized
 * and scoped server-side (see shared/security/menu-css-sanitizer.ts) before
 * it was ever stored, so it's safe to inject as-is here.
 */
export function MenuThemeStyle({
  template,
  customCss,
}: {
  template: string;
  customCss: string | null;
}) {
  const isKnownPreset = (key: string): key is MenuPresetKey =>
    (MENU_PRESET_KEYS as readonly string[]).includes(key);
  const preset = isKnownPreset(template) ? MENU_TEMPLATES[template] : MENU_TEMPLATES.classic;

  const vars = `:root{
    --menu-primary:${preset.primary};
    --menu-primary-foreground:${preset.primaryForeground};
    --menu-accent:${preset.accent};
    --menu-accent-foreground:${preset.accentForeground};
    --menu-card-radius:${preset.cardRadius};
    --menu-pill-radius:${preset.pillRadius};
    --menu-card-border:${preset.cardBorder};
    --menu-card-shadow:${preset.cardShadow};
    --menu-heading-font:${preset.headingFont};
    --menu-heading-weight:${preset.headingWeight};
  }`;

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: vars }} />
      {template === "custom" && customCss && (
        <style dangerouslySetInnerHTML={{ __html: customCss }} />
      )}
    </>
  );
}
