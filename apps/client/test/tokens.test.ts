import { describe, expect, it } from "vitest";
import { AAA_PAIRS, CONTRAST_PAIRS, contrast, THEME_NAMES, THEMES, themeCss } from "../src/ui/tokens";

/** Every pair below its minimum, as readable strings; empty when the theme passes. */
function failingPairs(
  theme: Record<string, string>,
  pairs: readonly (readonly [string, string, number])[],
): string[] {
  return pairs.flatMap(([fg, bg, min]) => {
    const a = theme[fg];
    const b = theme[bg];
    if (a === undefined || b === undefined) return [`--${fg} on --${bg}: missing token`];
    const ratio = contrast(a, b);
    return ratio >= min ? [] : [`--${fg} on --${bg}: ${ratio.toFixed(2)} < ${min}`];
  });
}

describe("design tokens", () => {
  it.each(THEME_NAMES)("%s: every contrast pair meets its minimum", (theme) => {
    expect(failingPairs(THEMES[theme], CONTRAST_PAIRS)).toEqual([]);
  });

  it("high contrast: every AAA pair is at least 7:1", () => {
    const aaa = AAA_PAIRS.map(([fg, bg]) => [fg, bg, 7] as const);
    expect(failingPairs(THEMES.contrast, aaa)).toEqual([]);
  });

  it("all themes define exactly the same tokens", () => {
    expect(Object.keys(THEMES.latte).sort()).toEqual(Object.keys(THEMES.mocha).sort());
    expect(Object.keys(THEMES.contrast).sort()).toEqual(Object.keys(THEMES.mocha).sort());
    expect(Object.values(THEMES.contrast)).not.toContain("#ff00ff"); // no missing high-contrast value
  });

  it("emits CSS variables for both themes", () => {
    const css = themeCss();
    expect(css).toContain(':root[data-theme="latte"]');
    expect(css).toContain(':root[data-theme="mocha"]');
    expect(css).toContain(':root[data-theme="contrast"]');
    expect(css).toContain("--primary:");
  });
});
