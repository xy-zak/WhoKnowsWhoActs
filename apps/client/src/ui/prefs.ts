import { useEffect } from "react";
import { Store, useStore } from "../net/store";
import type { ThemeName } from "./tokens";

/** Apply a theme and CRT setting to <html> (both apps). */
export function applyAppearance(theme: ThemeName, crt: boolean) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.crt = crt ? "on" : "off";
}

/* ─── Facilitator preferences: per browser, not research data ─── */

const KEY = "wkwa.facilitator.prefs";

export interface Prefs {
  theme: ThemeName;
  crt: boolean;
}

function load(): Prefs {
  const osDark = typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  const fallback: Prefs = { theme: osDark ? "mocha" : "latte", crt: true };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fallback;
    const p = JSON.parse(raw) as Partial<Prefs>;
    return {
      theme: p.theme === "latte" || p.theme === "mocha" ? p.theme : fallback.theme,
      crt: typeof p.crt === "boolean" ? p.crt : true,
    };
  } catch {
    return fallback;
  }
}

export const prefsStore = new Store<Prefs>(
  typeof window === "undefined" ? { theme: "mocha", crt: true } : load(),
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
  useEffect(() => applyAppearance(p.theme, p.crt), [p.theme, p.crt]);
  return p;
}
