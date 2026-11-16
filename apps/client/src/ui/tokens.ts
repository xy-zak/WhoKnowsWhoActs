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

export type ThemeName = "latte" | "mocha";
export const THEME_NAMES: ThemeName[] = ["latte", "mocha"];

type CatName = keyof (typeof flavors)["latte"]["colors"];

function cat(theme: ThemeName, name: CatName): string {
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
};

function accent(theme: ThemeName, name: CatName): string {
  const hex = cat(theme, name);
  return theme === "latte" ? shade(hex, LATTE_DARKEN[name] ?? 0) : hex;
}

export interface TokenDoc {
  token: string;
  role: string;
  latte: string;
  mocha: string;
}

/** Semantic token → [description, Latte source, Mocha source]. Sources are Catppuccin names or rules. */
const DEFS: Array<{
  token: string;
  role: string;
  value: (t: ThemeName) => string;
  source: (t: ThemeName) => string;
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
    role: "LIVE indicator, success, connected — nothing else",
    value: (t) => accent(t, "green"),
    source: (t) => (t === "latte" ? "green −25%" : "green"),
  },
  {
    token: "warn",
    role: "Warnings, attention needed (paused, idle, waiting)",
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
    token: "on-accent",
    role: "Text on a filled accent (primary/live/danger buttons, LIVE badge)",
    value: (t) => cat(t, t === "latte" ? "base" : "crust"),
    source: (t) => (t === "latte" ? "base" : "crust"),
  },
  {
    token: "propose",
    role: "MAP ONLY: propose highlight (hatch + dashed outline)",
    value: (t) => cat(t, "yellow"),
    source: () => "yellow",
  },
  {
    token: "propose-text",
    role: "Text/icons that refer to proposing (tool button, legend)",
    value: (t) => accent(t, "yellow"),
    source: (t) => (t === "latte" ? "yellow −35%" : "yellow"),
  },
  {
    token: "decide",
    role: "MAP ONLY: decide highlight (fill + solid outline)",
    value: (t) => cat(t, "red"),
    source: () => "red",
  },
  {
    token: "decide-text",
    role: "Text/icons that refer to deciding (tool button, legend)",
    value: (t) => accent(t, "red"),
    source: (t) => (t === "latte" ? "red −5%" : "red"),
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
    token: "sea",
    role: "Map background (water)",
    value: (t) => mix(cat(t, "mantle"), cat(t, "sapphire"), t === "latte" ? 0.14 : 0.1),
    source: (t) => `mantle + ${t === "latte" ? 14 : 10}% sapphire`,
  },
  {
    token: "land",
    role: "Map region without data",
    value: (t) => cat(t, "surface0"),
    source: () => "surface0",
  },
  {
    token: "map-stroke",
    role: "Map region borders",
    value: (t) => cat(t, t === "latte" ? "overlay1" : "overlay0"),
    source: (t) => (t === "latte" ? "overlay1" : "overlay0"),
  },
];

export const THEMES: Record<ThemeName, Record<string, string>> = {
  latte: Object.fromEntries(DEFS.map((d) => [d.token, d.value("latte")])),
  mocha: Object.fromEntries(DEFS.map((d) => [d.token, d.value("mocha")])),
};

export const TOKEN_DOCS: TokenDoc[] = DEFS.map((d) => ({
  token: `--${d.token}`,
  role: d.role,
  latte: `${d.value("latte")} (${d.source("latte")})`,
  mocha: `${d.value("mocha")} (${d.source("mocha")})`,
}));

/** Non-colour per-theme values (CRT intensity). */
export const THEME_EFFECTS: Record<ThemeName, { scanAlpha: number; glow: boolean }> = {
  latte: { scanAlpha: 0.035, glow: false },
  mocha: { scanAlpha: 0.15, glow: true },
};

export function themeCss(): string {
  return THEME_NAMES.map((t) => {
    const vars = Object.entries(THEMES[t])
      .map(([k, v]) => `--${k}:${v};`)
      .join("");
    const fx = THEME_EFFECTS[t];
    return `:root[data-theme="${t}"]{${vars}--scan-alpha:${fx.scanAlpha};--glow:${fx.glow ? 1 : 0};color-scheme:${t === "latte" ? "light" : "dark"};}`;
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
  ["danger", "panel", 4.5],
  ["focus", "panel", 3],
  ["propose-text", "panel", 4.5],
  ["decide-text", "panel", 4.5],
  ["on-accent", "primary", 4.5],
  ["on-accent", "live", 4.5],
  ["on-accent", "danger", 4.5],
  ["control", "panel", 3],
  ["control", "sunken", 3],
  ["seat-1", "panel", 3],
  ["seat-2", "panel", 3],
  ["seat-3", "panel", 3],
  ["seat-4", "panel", 3],
];
