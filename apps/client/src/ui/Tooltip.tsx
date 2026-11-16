import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

interface Tip {
  text: string;
  x: number;
  y: number;
  above: boolean;
}

/**
 * One global tooltip for every element with `data-tip` (e.g. <Button tip="…">).
 * Rendered in a fixed layer so it is never clipped by scrolling tables.
 * Shows on hover (after 350 ms) and immediately on keyboard focus.
 */
export function TooltipLayer() {
  const [tip, setTip] = useState<Tip | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let current: Element | null = null;
    const place = (el: Element) => {
      const text = el.getAttribute("data-tip");
      if (!text) return;
      const r = el.getBoundingClientRect();
      const above = r.bottom + 60 > window.innerHeight;
      setTip({
        text,
        x: Math.min(Math.max(r.left + r.width / 2, 140), window.innerWidth - 140),
        y: above ? r.top - 6 : r.bottom + 6,
        above,
      });
    };
    const show = (el: Element, delay: number) => {
      if (timer) clearTimeout(timer);
      current = el;
      timer = setTimeout(() => current === el && place(el), delay);
    };
    const hide = () => {
      if (timer) clearTimeout(timer);
      current = null;
      setTip(null);
    };
    const over = (e: Event) => {
      const el = (e.target as Element | null)?.closest?.("[data-tip]");
      if (el && el !== current) show(el, 350);
      else if (!el && current) hide();
    };
    const focus = (e: Event) => {
      const el = (e.target as Element | null)?.closest?.("[data-tip]");
      if (el) show(el, 0);
    };
    document.addEventListener("mouseover", over);
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", hide);
    document.addEventListener("scroll", hide, true);
    document.addEventListener("pointerdown", hide);
    return () => {
      document.removeEventListener("mouseover", over);
      document.removeEventListener("focusin", focus);
      document.removeEventListener("focusout", hide);
      document.removeEventListener("scroll", hide, true);
      document.removeEventListener("pointerdown", hide);
    };
  }, []);
  if (!tip) return null;
  return createPortal(
    <div
      role="tooltip"
      className="tooltip"
      style={{ left: tip.x, top: tip.y, transform: `translate(-50%, ${tip.above ? "-100%" : "0"})` }}
    >
      {tip.text}
    </div>,
    document.body,
  );
}
