import { flavors } from "@catppuccin/palette";

/* ═══════════════════════════════════════════════════════════════════════════
 * DESIGN TOKENS — the single source of truth for colour.
 *
 * Components use ONLY the semantic tokens below (as CSS variables, e.g.
 * `var(--primary)`), never raw Catppuccin colours. The token table in
 * docs/AESTHETIC-RULES.md is generated from TOKEN_DOCS, and
 * apps/client/test/tokens.test.ts checks WCAG contrast for every pair that
 * carries text or UI meaning.
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Catppuccin flavours + a hand-made high-contrast theme (black, white, saturated accents; WCAG AAA text). */
export type ThemeName = "latte" | "mocha" | "contrast";
export const THEME_NAMES: ThemeName[] = ["latte", "mocha", "contrast"];
type CatTheme = "latte" | "mocha";

type CatName = keyof (typeof flavors)["latte"]["colors"];

function cat(theme: CatTheme, name: CatName): string {
  return flavors[theme].colors[name].hex;
}

/** Mix a colour with black (t = 0…1). Used for Latte's text-safe accent variants. */
export function shade(hex: string, t: number): string {
  return `#${[1, 3, 5]
    .map((i) =>
      Math.round(Number.parseInt(hex.slice(i, i + 2), 16) * (1 - t))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** Mix two colours (t = share of b). */
export function mix(a: string, b: string, t: number): string {
  return `#${[1, 3, 5]
    .map((i) =>
      Math.round(
        Number.parseInt(a.slice(i, i + 2), 16) * (1 - t) + Number.parseInt(b.slice(i, i + 2), 16) * t,
      )
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/**
 * Latte's pastel-on-light accents are below WCAG AA as text. Each accent is
 * darkened by the smallest step (of 0.05) that reaches ≥ 4.5:1 on both base
 * and mantle; Mocha uses Catppuccin's accents unchanged.
 */
const LATTE_DARKEN: Partial<Record<CatName, number>> = {
  blue: 0.1,
  green: 0.25,
  peach: 0.3,
  yellow: 0.35,
  red: 0.05,
  mauve: 0.05,
  sapphire: 0.3,
  lavender: 0.3,
};

function accent(theme: CatTheme, name: CatName): string {
  const hex = cat(theme, name);
  return theme === "latte" ? shade(hex, LATTE_DARKEN[name] ?? 0) : hex;
}

/**
 * KNOWLEDGE-TYPE COLOURS (Ka–Kd; power types Pa–Pd share the colour of the
 * same letter). A categorical palette, not Catppuccin's own pastels (they are
 * too light and too grey to tell four categories apart). Validated per theme
 * on the panel surface with the dataviz palette checks: all four pairs (they
 * all touch inside a square) stay apart under protanopia and deuteranopia
 * (ΔE ≥ 7 OKLab ×100; position and labels are the secondary encoding) and
 * under normal vision (ΔE ≥ 15), and every colour reaches ≥ 3:1 on the panel.
 * `--k-x-on` is the score text on a filled (decided) sub-square: whichever
 * ink reads better on that fill (≥ 4.5:1, checked in tokens.test.ts).
 */
export const KNOWLEDGE_COLOURS: Record<
  "a" | "b" | "c" | "d",
  { hue: string; latte: string; mocha: string; contrast: string }
> = {
  a: { hue: "blue", latte: "#1d61e9", mocha: "#5b86f0", contrast: "#4d8dff" },
  b: { hue: "amber", latte: "#be7919", mocha: "#c2871f", contrast: "#ffb000" },
  c: { hue: "red", latte: "#c43b47", mocha: "#e05a6c", contrast: "#ff5c7a" },
  d: { hue: "teal", latte: "#008f8a", mocha: "#13a3a6", contrast: "#00d6c8" },
};
export const KNOWLEDGE_LETTERS = ["a", "b", "c", "d"] as const;

/** The darker or lighter ink, whichever contrasts more with `fill`. */
function inkOn(fill: string, dark: string, light: string): string {
  return contrast(dark, fill) >= contrast(light, fill) ? dark : light;
}

export interface TokenDoc {
  token: string;
  role: string;
  latte: string;
  mocha: string;
  contrast: string;
}

/** Semantic token → [description, Latte source, Mocha source]. Sources are Catppuccin names or rules. */
const DEFS: Array<{
  token: string;
  role: string;
  value: (t: CatTheme) => string;
  source: (t: CatTheme) => string;
}> = [
  {
    token: "bg",
    role: "Page background (behind panels)",
    value: (t) => cat(t, "crust"),
    source: () => "crust",
  },
  { token: "panel", role: "Panel / popup surface", value: (t) => cat(t, "base"), source: () => "base" },
  {
    token: "sunken",
    role: "Inputs, table headers, status bar",
    value: (t) => cat(t, "mantle"),
    source: () => "mantle",
  },
  {
    token: "hover",
    role: "Hover / selected row",
    value: (t) => cat(t, "surface0"),
    source: () => "surface0",
  },
  {
    token: "frame",
    role: "Decorative panel frames, dividers",
    value: (t) => cat(t, "surface2"),
    source: () => "surface2",
  },
  {
    token: "control",
    role: "Borders of inputs and buttons (≥ 3:1)",
    value: (t) => cat(t, t === "latte" ? "overlay2" : "overlay0"),
    source: (t) => (t === "latte" ? "overlay2" : "overlay0"),
  },
  { token: "text", role: "Body text", value: (t) => cat(t, "text"), source: () => "text" },
  {
    token: "muted",
    role: "Secondary text, labels, metadata",
    value: (t) => cat(t, t === "latte" ? "subtext1" : "subtext0"),
    source: (t) => (t === "latte" ? "subtext1" : "subtext0"),
  },
  {
    token: "faint",
    role: "Placeholders, disabled text, brackets",
    value: (t) => cat(t, t === "latte" ? "overlay2" : "overlay1"),
    source: (t) => (t === "latte" ? "overlay2" : "overlay1"),
  },
  {
    token: "primary",
    role: "The primary action of a view; links; current step",
    value: (t) => accent(t, "blue"),
    source: (t) => (t === "latte" ? "blue −10%" : "blue"),
  },
  {
    token: "live",
    role: "LIVE indicator, success, connected, microphone recording — nothing else",
    value: (t) => accent(t, "green"),
    source: (t) => (t === "latte" ? "green −25%" : "green"),
  },
  {
    token: "warn",
    role: "Warnings, attention needed (paused, idle, waiting, no mic signal)",
    value: (t) => accent(t, "peach"),
    source: (t) => (t === "latte" ? "peach −30%" : "peach"),
  },
  {
    token: "danger",
    role: "Destructive actions and errors (always with an icon)",
    value: (t) => accent(t, "red"),
    source: (t) => (t === "latte" ? "red −5%" : "red"),
  },
  {
    token: "focus",
    role: "Keyboard focus ring, selection outline",
    value: (t) => accent(t, "mauve"),
    source: (t) => (t === "latte" ? "mauve −5%" : "mauve"),
  },
  {
    token: "review",
    role: "The two setup commit points: 06 review & create, 10 start onboarding — nothing else",
    value: (t) => accent(t, "lavender"),
    source: (t) => (t === "latte" ? "lavender −30%" : "lavender"),
  },
  {
    token: "review-bg",
    role: "Tinted background of the commit steps (06, 10)",
    value: (t) => mix(cat(t, "base"), cat(t, "lavender"), t === "latte" ? 0.1 : 0.08),
    source: (t) => `base + ${t === "latte" ? 10 : 8}% lavender`,
  },
  {
    token: "on-accent",
    role: "Text on a filled accent (primary/live/danger buttons, LIVE badge)",
    value: (t) => cat(t, t === "latte" ? "base" : "crust"),
    source: (t) => (t === "latte" ? "base" : "crust"),
  },
  {
    token: "seat-1",
    role: "Seat 1 identity colour",
    value: (t) => accent(t, "peach"),
    source: (t) => (t === "latte" ? "peach −30%" : "peach"),
  },
  {
    token: "seat-2",
    role: "Seat 2 identity colour",
    value: (t) => accent(t, "sapphire"),
    source: (t) => (t === "latte" ? "sapphire −30%" : "sapphire"),
  },
  {
    token: "seat-3",
    role: "Seat 3 identity colour",
    value: (t) => accent(t, "green"),
    source: (t) => (t === "latte" ? "green −25%" : "green"),
  },
  {
    token: "seat-4",
    role: "Seat 4 identity colour",
    value: (t) => accent(t, "mauve"),
    source: (t) => (t === "latte" ? "mauve −5%" : "mauve"),
  },
  {
    token: "map-stroke",
    role: "Map: outline of each square of the grid",
    value: (t) => cat(t, t === "latte" ? "overlay1" : "overlay0"),
    source: (t) => (t === "latte" ? "overlay1" : "overlay0"),
  },
  ...KNOWLEDGE_DEFS(),
];

function KNOWLEDGE_DEFS(): typeof DEFS {
  const dark = cat("mocha", "crust");
  const light = cat("latte", "base");
  return KNOWLEDGE_LETTERS.flatMap((l) => {
    const c = KNOWLEDGE_COLOURS[l];
    return [
      {
        token: `k-${l}`,
        role: `Knowledge type K${l} (and power type P${l}): sub-square outline, hatch (proposed) and fill (decided) on the map, timeline marks, label swatches`,
        value: (t: CatTheme) => c[t],
        source: () => `${c.hue}, validated categorical`,
      },
      {
        token: `k-${l}-on`,
        role: `Score text on a decided (filled) K${l} sub-square`,
        value: (t: CatTheme) => inkOn(c[t], dark, light),
        source: (t: CatTheme) => (inkOn(c[t], dark, light) === dark ? "crust (mocha)" : "base (latte)"),
      },
    ];
  });
}

/**
 * High-contrast theme: not a Catppuccin flavour. Pure black/white chrome and
 * saturated accents; body text, muted text and accents reach ≥ 7:1 (WCAG AAA)
 * on the panel, controls and focus are bold white/magenta.
 */
const HIGH_CONTRAST: Record<string, string> = {
  bg: "#000000",
  panel: "#000000",
  sunken: "#141414",
  hover: "#2a2a2a",
  frame: "#bfbfbf",
  control: "#ffffff",
  text: "#ffffff",
  muted: "#e6e6e6",
  faint: "#b3b3b3",
  primary: "#5cc8ff",
  live: "#4cf08a",
  warn: "#ffb84d",
  danger: "#ff7070",
  focus: "#ff5cff",
  review: "#d2b4ff",
  "review-bg": "#1a1028",
  "on-accent": "#000000",
  "seat-1": "#ffa64d",
  "seat-2": "#5cc8ff",
  "seat-3": "#4cf08a",
  "seat-4": "#e09cff",
  "map-stroke": "#ffffff",
  ...Object.fromEntries(
    KNOWLEDGE_LETTERS.flatMap((l) => [
      [`k-${l}`, KNOWLEDGE_COLOURS[l].contrast],
      [`k-${l}-on`, inkOn(KNOWLEDGE_COLOURS[l].contrast, "#000000", "#ffffff")],
    ]),
  ),
};

export const THEMES: Record<ThemeName, Record<string, string>> = {
  latte: Object.fromEntries(DEFS.map((d) => [d.token, d.value("latte")])),
  mocha: Object.fromEntries(DEFS.map((d) => [d.token, d.value("mocha")])),
  contrast: Object.fromEntries(DEFS.map((d) => [d.token, HIGH_CONTRAST[d.token] ?? "#ff00ff"])),
};

export const THEME_LABEL: Record<ThemeName, string> = {
  latte: "Latte (light)",
  mocha: "Mocha (dark)",
  contrast: "High contrast",
};

/** Text pairs that must reach WCAG AAA (7:1) in the high-contrast theme. */
export const AAA_PAIRS: Array<[string, string]> = [
  ["text", "panel"],
  ["muted", "panel"],
  ["primary", "panel"],
  ["live", "panel"],
  ["warn", "panel"],
  ["danger", "panel"],
  ["review", "review-bg"],
];

export const TOKEN_DOCS: TokenDoc[] = DEFS.map((d) => ({
  token: `--${d.token}`,
  role: d.role,
  latte: `${d.value("latte")} (${d.source("latte")})`,
  mocha: `${d.value("mocha")} (${d.source("mocha")})`,
  contrast: THEMES.contrast[d.token]!,
}));

export function themeCss(): string {
  return THEME_NAMES.map((t) => {
    const vars = Object.entries(THEMES[t])
      .map(([k, v]) => `--${k}:${v};`)
      .join("");
    // also on any element, so a block can preview the other theme (setup step 03)
    return `:root[data-theme="${t}"],[data-theme="${t}"]{${vars}color-scheme:${t === "latte" ? "light" : "dark"};}`;
  }).join("\n");
}

/** Inject the token stylesheet once (called by each app's main.tsx). */
export function installThemeStyles() {
  if (typeof document === "undefined" || document.getElementById("wkwa-tokens")) return;
  const el = document.createElement("style");
  el.id = "wkwa-tokens";
  el.textContent = themeCss();
  document.head.prepend(el);
}

/* ─────────────────────────── contrast helpers (tests + docs) ─────────────────────────── */

export function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
}

export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

/** Pairs that must meet WCAG AA: [foreground, background, minimum ratio]. */
export const CONTRAST_PAIRS: Array<[string, string, number]> = [
  ["text", "panel", 4.5],
  ["text", "bg", 4.5],
  ["text", "sunken", 4.5],
  ["muted", "panel", 4.5],
  ["muted", "bg", 4.5],
  ["muted", "sunken", 4.5],
  ["primary", "panel", 4.5],
  ["live", "panel", 4.5],
  ["warn", "panel", 4.5],
  // status bar (sunken): "mics 3/4" and RECORDING PAUSED in warn
  ["warn", "sunken", 4.5],
  ["danger", "panel", 4.5],
  // empty level-meter / progress cells: a graphic that shows the scale (≥ 3:1)
  ["faint", "panel", 3],
  ["faint", "sunken", 3],
  ["focus", "panel", 3],
  ["review", "panel", 4.5],
  ["review", "review-bg", 4.5],
  ["text", "review-bg", 4.5],
  ["muted", "review-bg", 4.5],
  ["on-accent", "review", 4.5],
  ["on-accent", "primary", 4.5],
  ["on-accent", "live", 4.5],
  ["on-accent", "danger", 4.5],
  ["control", "panel", 3],
  ["control", "sunken", 3],
  ["seat-1", "panel", 3],
  ["seat-2", "panel", 3],
  ["seat-3", "panel", 3],
  ["seat-4", "panel", 3],
  ...KNOWLEDGE_LETTERS.flatMap(
    (l): Array<[string, string, number]> => [
      [`k-${l}`, "panel", 3],
      [`k-${l}-on`, `k-${l}`, 4.5],
    ],
  ),
];
