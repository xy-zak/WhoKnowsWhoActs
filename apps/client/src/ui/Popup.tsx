import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "./components";
import { Icon } from "./Icon";
import type { IconName } from "./icons";

/* Global popup registry: at most one popup is open, and global shortcuts pause while it is. */
let openCount = 0;
export function isPopupOpen(): boolean {
  return openCount > 0;
}

function motionAllowed(): boolean {
  if (typeof window === "undefined") return false;
  return (
    document.documentElement.dataset.crt === "on" &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
/** Same selector list, scoped to the popup body (each alternative needs the prefix). */
const BODY_FOCUSABLE = FOCUSABLE.split(", ")
  .map((sel) => `.popup-body ${sel}`)
  .join(", ");

export interface PopupProps {
  title: string;
  icon?: IconName;
  /** e.g. { index: 2, total: 10 } → "STEP 03/10" */
  step?: { index: number; total: number };
  /** Wayfinding strip shown under the title bar. */
  stepper?: ReactNode;
  children: ReactNode;
  /** Footer content; by convention secondary actions left, primary action right. */
  footer?: ReactNode;
  onClose?: () => void;
  /** Called on Enter (not from textareas/buttons). Omit for destructive popups. */
  onPrimary?: () => void;
  width?: number;
  tone?: "default" | "danger";
  /** Allow closing with Esc / ✕ (default true). */
  closable?: boolean;
  /** Internal: marks the confirmation popup (it is never hidden). */
  isConfirm?: boolean;
  /** Change this (e.g. the wizard step) to move focus into the new content and replay the title animation. */
  focusKey?: string | number;
}

/** True while a confirmation popup is showing: other popups hide (one popup at a time). */
const ConfirmPendingContext = createContext(false);

/**
 * Modal popup: title bar (icon, UPPERCASE title, step counter, ✕), optional
 * stepper, scrollable body, footer. Focus is trapped inside; Esc closes;
 * Enter triggers the primary action. CRT power-on/off when enabled.
 */
export function Popup({
  title,
  icon,
  step,
  stepper,
  children,
  footer,
  onClose,
  onPrimary,
  width = 760,
  tone = "default",
  closable = true,
  isConfirm = false,
  focusKey,
}: PopupProps) {
  const hidden = useContext(ConfirmPendingContext) && !isConfirm;
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  const ref = useRef<HTMLDivElement>(null);
  const [closing, setClosing] = useState(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const primaryRef = useRef(onPrimary);
  primaryRef.current = onPrimary;

  const requestClose = useCallback(() => {
    if (!closeRef.current) return;
    if (motionAllowed()) {
      setClosing(true);
      setTimeout(() => closeRef.current?.(), 130);
    } else closeRef.current();
  }, []);

  useEffect(() => {
    openCount++;
    const prev = document.activeElement as HTMLElement | null;
    return () => {
      openCount--;
      prev?.focus?.();
    };
  }, []);

  // Focus the first field of the body; fall back to the primary (last) footer button — never the ✕.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when the content (focusKey) changes
  useEffect(() => {
    const t = setTimeout(() => {
      const field = ref.current?.querySelector<HTMLElement>(BODY_FOCUSABLE);
      const footer = [
        ...(ref.current?.querySelectorAll<HTMLElement>(`.popup-foot ${FOCUSABLE.split(", ")[0]}`) ?? []),
      ];
      (field ?? footer.at(-1) ?? ref.current)?.focus();
    }, 0);
    return () => clearTimeout(t);
  }, [focusKey]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (hiddenRef.current) return;
      if (e.key === "Escape" && closable) {
        e.preventDefault();
        requestClose();
      } else if (e.key === "Enter" && primaryRef.current) {
        const t = e.target as HTMLElement;
        if (t.tagName === "TEXTAREA" || t.tagName === "BUTTON" || t.tagName === "SELECT") return;
        e.preventDefault();
        primaryRef.current();
      } else if (e.key === "Tab" && ref.current) {
        const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
        if (items.length === 0) return;
        const first = items[0]!;
        const last = items[items.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closable, requestClose]);

  if (hidden) return null;
  return createPortal(
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && closable && requestClose()}>
      <div
        ref={ref}
        className={`popup tone-${tone}${closing ? " closing" : ""}`}
        style={{ "--popup-w": `${width}px` } as React.CSSProperties}
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-label={title}
      >
        <div className="popup-head">
          <span className="popup-title">
            {icon && <Icon name={icon} size={20} />}
            <span key={title} className="typed" style={{ "--chars": title.length } as React.CSSProperties}>
              {title}
            </span>
          </span>
          <span className="spacer" />
          {step && (
            <span className="popup-step">
              STEP {String(step.index + 1).padStart(2, "0")}/{String(step.total).padStart(2, "0")}
            </span>
          )}
          {closable && onClose && (
            <Button variant="ghost" iconOnly icon="close" title="Close (Esc)" onClick={requestClose} />
          )}
        </div>
        {stepper && <div className="popup-stepper">{stepper}</div>}
        <div className="popup-body">{children}</div>
        {footer && <div className="popup-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/* ─────────────────────────── Confirmation popups ─────────────────────────── */

export interface ConfirmOptions {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  /** Destructive: red styling, Enter does NOT confirm. */
  danger?: boolean;
  /** Irreversible actions: the user must type this text exactly (e.g. the participant code). */
  requireText?: string;
  icon?: IconName;
}

type Resolver = (ok: boolean) => void;
const ConfirmContext = createContext<((o: ConfirmOptions) => Promise<boolean>) | null>(null);

/** `const confirm = useConfirm(); if (await confirm({...})) …` */
export function useConfirm() {
  const fn = useContext(ConfirmContext);
  if (!fn) throw new Error("useConfirm needs <ConfirmProvider>");
  return fn;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<(ConfirmOptions & { resolve: Resolver }) | null>(null);
  const [typed, setTyped] = useState("");
  const confirm = useCallback(
    (o: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setTyped("");
        setReq({ ...o, resolve });
      }),
    [],
  );
  const finish = (ok: boolean) => {
    req?.resolve(ok);
    setReq(null);
  };
  const textOk = !req?.requireText || typed.trim().toUpperCase() === req.requireText.trim().toUpperCase();
  return (
    <ConfirmContext.Provider value={confirm}>
      <ConfirmPendingContext.Provider value={req !== null}>{children}</ConfirmPendingContext.Provider>
      {req && (
        <Popup
          isConfirm
          title={req.title}
          icon={req.icon ?? (req.danger ? "warning" : "info")}
          tone={req.danger ? "danger" : "default"}
          width={520}
          onClose={() => finish(false)}
          onPrimary={req.danger ? undefined : () => textOk && finish(true)}
          footer={
            <>
              <Button icon="close" kbd="Esc" onClick={() => finish(false)}>
                Cancel
              </Button>
              <span className="spacer" />
              <Button
                variant={req.danger ? "danger-solid" : "primary"}
                icon={req.danger ? "warning" : "ok"}
                kbd={req.danger ? undefined : "Enter"}
                disabled={!textOk}
                onClick={() => finish(true)}
              >
                {req.confirmLabel ?? "Confirm"}
              </Button>
            </>
          }
        >
          <div>{req.message}</div>
          {req.requireText && (
            <label className="field">
              <span className="label">
                Type <span className="mono strong">{req.requireText}</span> to confirm
              </span>
              <input
                type="text"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
              />
            </label>
          )}
        </Popup>
      )}
    </ConfirmContext.Provider>
  );
}
