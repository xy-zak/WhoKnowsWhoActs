import { describe, expect, it } from "vitest";
import { CONTRAST_PAIRS, contrast, THEME_NAMES, THEMES, themeCss } from "../src/ui/tokens";

describe("design tokens", () => {
  for (const theme of THEME_NAMES) {
    describe(theme, () => {
      for (const [fg, bg, min] of CONTRAST_PAIRS) {
        it(`--${fg} on --${bg} ≥ ${min}:1`, () => {
          const t = THEMES[theme];
          expect(t[fg], `missing token ${fg}`).toBeDefined();
          expect(t[bg], `missing token ${bg}`).toBeDefined();
          expect(contrast(t[fg]!, t[bg]!)).toBeGreaterThanOrEqual(min);
        });
      }
    });
  }

  it("both themes define exactly the same tokens", () => {
    expect(Object.keys(THEMES.latte).sort()).toEqual(Object.keys(THEMES.mocha).sort());
  });

  it("emits CSS variables for both themes", () => {
    const css = themeCss();
    expect(css).toContain(':root[data-theme="latte"]');
    expect(css).toContain(':root[data-theme="mocha"]');
    expect(css).toContain("--primary:");
  });
});
