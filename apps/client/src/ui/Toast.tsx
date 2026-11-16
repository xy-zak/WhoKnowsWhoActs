export interface ToastMsg {
  text: string;
  kind: "ok" | "warn" | "error" | "info";
}

const LEVEL: Record<ToastMsg["kind"], string> = {
  ok: "[ OK ]",
  warn: "[WARN]",
  error: "[FAIL]",
  info: "[INFO]",
};

/** Bottom-right TUI notification. One at a time; auto-dismissed by the owner (3 s, errors 6 s). */
export function ToastView({ toast }: { toast: ToastMsg | null }) {
  if (!toast) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      <div className={`toast ${toast.kind}`}>
        <span className="lvl">{LEVEL[toast.kind]}</span>
        {toast.text}
      </div>
    </div>
  );
}
