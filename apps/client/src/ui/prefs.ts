import { useEffect } from "react";
import { Store, useStore } from "../net/store";
import type { ThemeName } from "./tokens";

/*
 * Display settings (accessibility): colour theme, font, text size, animations.
 * Every screen — each player PC and the facilitator — chooses its own. They are
 * kept in that browser only and are deliberately NOT sent to the server or
 * logged: a choice like "high contrast" or "OpenDyslexic" could hint at a
 * visual impairment or dyslexia (health data).
 */

export const FONT_NAMES = ["jetbrains", "dyslexic", "system"] as const;
export type FontName = (typeof FONT_NAMES)[number];
export const FONT_LABEL: Record<FontName, string> = {
  jetbrains: "JetBrains Mono",
  dyslexic: "OpenDyslexic",
  system: "System font",
};

export const SCALE_NAMES = ["small", "large"] as const;
export type ScaleName = (typeof SCALE_NAMES)[number];
export const SCALE_LABEL: Record<ScaleName, string> = { small: "Small", large: "Large" };

export interface DisplayPrefs {
  theme: ThemeName;
  font: FontName;
  scale: ScaleName;
  animations: boolean;
}

/** Apply display settings to <html> (both apps). */
export function applyAppearance(p: DisplayPrefs) {
  const root = document.documentElement;
  root.dataset.theme = p.theme;
  root.dataset.font = p.font;
  root.dataset.scale = p.scale;
  root.dataset.crt = p.animations ? "on" : "off"; // CRT-style animations
}

/** Theme the OS asks for: high contrast if "more contrast" is requested, else dark/light. */
export function osTheme(): ThemeName {
  if (typeof window === "undefined" || !window.matchMedia) return "mocha";
  if (
    window.matchMedia("(prefers-contrast: more)").matches ||
    window.matchMedia("(forced-colors: active)").matches
  )
    return "contrast";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "mocha" : "latte";
}

const isTheme = (t: unknown): t is ThemeName => t === "latte" || t === "mocha" || t === "contrast";
const isFont = (f: unknown): f is FontName => FONT_NAMES.includes(f as FontName);
const isScale = (s: unknown): s is ScaleName => SCALE_NAMES.includes(s as ScaleName);

const cycle = <T>(list: readonly T[], cur: T): T => list[(list.indexOf(cur) + 1) % list.length]!;
/** Next theme in the cycle Latte → Mocha → High contrast. */
export const nextTheme = (t: ThemeName): ThemeName => cycle(["latte", "mocha", "contrast"], t);
export const nextFont = (f: FontName): FontName => cycle(FONT_NAMES, f);
export const nextScale = (s: ScaleName): ScaleName => cycle(SCALE_NAMES, s);

export function defaultPrefs(): DisplayPrefs {
  return { theme: osTheme(), font: "jetbrains", scale: "small", animations: true };
}

/** Parse stored settings; unknown or missing values fall back to the defaults. */
export function parsePrefs(raw: unknown, fallback: DisplayPrefs = defaultPrefs()): DisplayPrefs {
  const p = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    theme: isTheme(p.theme) ? p.theme : fallback.theme,
    font: isFont(p.font) ? p.font : fallback.font,
    scale: isScale(p.scale) ? p.scale : fallback.scale,
    animations:
      typeof p.animations === "boolean"
        ? p.animations
        : typeof p.crt === "boolean" // legacy facilitator key
          ? p.crt
          : fallback.animations,
  };
}

function load(key: string, legacyThemeKey?: string): DisplayPrefs {
  const fallback = defaultPrefs();
  try {
    const raw = localStorage.getItem(key);
    if (raw) return parsePrefs(JSON.parse(raw), fallback);
    const legacy = legacyThemeKey ? localStorage.getItem(legacyThemeKey) : null;
    if (isTheme(legacy)) return { ...fallback, theme: legacy };
  } catch {}
  return fallback;
}

export interface PrefsHandle {
  store: Store<DisplayPrefs>;
  set: (patch: Partial<DisplayPrefs>) => void;
}

function makePrefs(key: string, legacyThemeKey?: string): PrefsHandle {
  const store = new Store<DisplayPrefs>(
    typeof window === "undefined"
      ? { theme: "mocha", font: "jetbrains", scale: "small", animations: true }
      : load(key, legacyThemeKey),
  );
  return {
    store,
    set(patch) {
      store.set((p) => ({ ...p, ...patch }));
      try {
        localStorage.setItem(key, JSON.stringify(store.get()));
      } catch {}
    },
  };
}

/** The participant's own settings on a player PC (not logged). */
export const playerPrefs = makePrefs("wkwa.player.display", "wkwa.player.theme");
/** The facilitator's own settings (not research data). */
export const facilitatorPrefs = makePrefs("wkwa.facilitator.prefs");

/** Keep <html> in sync with a settings store; returns the current settings. */
export function useDisplayPrefs(h: PrefsHandle): DisplayPrefs {
  const p = useStore(h.store);
  useEffect(() => applyAppearance(p), [p]);
  return p;
}
