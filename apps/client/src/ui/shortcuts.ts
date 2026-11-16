import { useEffect, useRef } from "react";
import { isPopupOpen } from "./Popup";

export interface Shortcut {
  key: string;
  label: string;
  run: () => void;
  /** Return false to disable the shortcut in the current state. */
  enabled?: () => boolean;
}

function typingIn(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}

/**
 * Global single-key shortcuts (TUI style). Ignored while typing in a field,
 * while a popup is open (popups own Enter/Esc), and with modifier keys held.
 */
export function useShortcuts(shortcuts: Shortcut[]) {
  const ref = useRef(shortcuts);
  ref.current = shortcuts;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || typingIn(e.target) || isPopupOpen()) return;
      const s = ref.current.find((x) => x.key.toLowerCase() === e.key.toLowerCase());
      if (s && (s.enabled?.() ?? true)) {
        e.preventDefault();
        s.run();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
