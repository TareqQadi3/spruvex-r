// Namespace import — see packages/ui/src/apply-theme.ts for why a named
// import of a const re-exported through @spruvex-r/types' barrel file can
// break a bundler's static CJS-interop analysis.
import * as SpruvexTypes from "@spruvex-r/types";

const { MENU_CSS_SCOPE_CLASS } = SpruvexTypes;

/** className for the page wrapper — only meaningful (and only applied) when the tenant chose the "custom" menu template. */
export function menuScopeClassName(template: string): string | undefined {
  return template === "custom" ? MENU_CSS_SCOPE_CLASS : undefined;
}
