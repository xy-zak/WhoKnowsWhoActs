import { useEffect, useRef, useState } from "react";
import { useStore } from "../net/store";
import { Button, DisplaySettings, FONT_LABEL, playerPrefs, SCALE_LABEL, THEME_LABEL } from "../ui";

/**
 * The participant's own display settings (accessibility): colours, font,
 * text size, animations. A small non-modal panel in the bottom-right corner,
 * reachable on every screen. Kept in this browser only and deliberately NOT
 * logged or sent to the server (a choice could hint at a visual impairment or
 * dyslexia).
 */
export function DisplayMenu() {
  const prefs = useStore(playerPrefs.store);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation(); // Esc closes this panel first (not the game's draft)
      setOpen(false);
      btn.current?.focus();
    };
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onDown, true);
    wrap.current?.querySelector<HTMLInputElement>(".display-panel input:checked")?.focus();
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [open]);

  const summary = `${THEME_LABEL[prefs.theme]} · ${FONT_LABEL[prefs.font]} · ${SCALE_LABEL[prefs.scale]} text`;
  return (
    <div ref={wrap} className="display-menu">
      {open && (
        <section className="panel display-panel" role="dialog" aria-label="Display settings">
          <span className="panel-title">Display</span>
          <DisplaySettings prefs={prefs} onChange={playerPrefs.set} />
          <p className="hint" style={{ margin: 0 }}>
            Only on this screen. Not recorded. <kbd>Esc</kbd> closes.
          </p>
        </section>
      )}
      <Button
        ref={btn}
        size="sm"
        icon="display"
        aria-expanded={open}
        aria-label={`Display settings (${summary})`}
        tip={open ? undefined : `Colours, font, text size, animations. Only on this screen, not recorded.`}
        onClick={() => setOpen((o) => !o)}
      >
        Display
      </Button>
    </div>
  );
}
