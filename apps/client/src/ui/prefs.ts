import { useEffect } from "react";
import { Store, useStore } from "../net/store";
import type { ThemeName } from "./tokens";

/** Apply a theme and the animations setting to <html> (both apps). */
export function applyAppearance(theme: ThemeName, animations: boolean) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.crt = animations ? "on" : "off"; // CRT-style animations
}

/* ─── Facilitator preferences: per browser, not research data ─── */

const KEY = "wkwa.facilitator.prefs";

export interface Prefs {
  theme: ThemeName;
  animations: boolean;
}

function load(): Prefs {
  const osDark = typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  const fallback: Prefs = { theme: osDark ? "mocha" : "latte", animations: true };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fallback;
    const p = JSON.parse(raw) as Partial<Prefs> & { crt?: boolean };
    return {
      theme: p.theme === "latte" || p.theme === "mocha" || p.theme === "contrast" ? p.theme : fallback.theme,
      animations:
        typeof p.animations === "boolean" ? p.animations : typeof p.crt === "boolean" ? p.crt : true,
    };
  } catch {
    return fallback;
  }
}

export const prefsStore = new Store<Prefs>(
  typeof window === "undefined" ? { theme: "mocha", animations: true } : load(),
);

export function setPrefs(patch: Partial<Prefs>) {
  prefsStore.set((p) => ({ ...p, ...patch }));
  try {
    localStorage.setItem(KEY, JSON.stringify(prefsStore.get()));
  } catch {}
}

/** Facilitator: keep <html> in sync with the stored preferences. */
export function usePrefs(): Prefs {
  const p = useStore(prefsStore);
  useEffect(() => applyAppearance(p.theme, p.animations), [p.theme, p.animations]);
  return p;
}
