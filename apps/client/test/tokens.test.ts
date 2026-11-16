import { describe, expect, it } from "vitest";
import { AAA_PAIRS, CONTRAST_PAIRS, contrast, THEME_NAMES, THEMES, themeCss } from "../src/ui/tokens";

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

  it("all themes define exactly the same tokens", () => {
    expect(Object.keys(THEMES.latte).sort()).toEqual(Object.keys(THEMES.mocha).sort());
    expect(Object.keys(THEMES.contrast).sort()).toEqual(Object.keys(THEMES.mocha).sort());
    expect(Object.values(THEMES.contrast)).not.toContain("#ff00ff"); // no missing high-contrast value
  });

  for (const [fg, bg] of AAA_PAIRS) {
    it(`high contrast: --${fg} on --${bg} ≥ 7:1 (AAA)`, () => {
      expect(contrast(THEMES.contrast[fg]!, THEMES.contrast[bg]!)).toBeGreaterThanOrEqual(7);
    });
  }

  it("emits CSS variables for both themes", () => {
    const css = themeCss();
    expect(css).toContain(':root[data-theme="latte"]');
    expect(css).toContain(':root[data-theme="mocha"]');
    expect(css).toContain(':root[data-theme="contrast"]');
    expect(css).toContain("--primary:");
  });
});
