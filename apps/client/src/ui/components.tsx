import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";
import { Icon } from "./Icon";
import type { IconName } from "./icons";

/* ─────────────────────────── Panel ─────────────────────────── */

export function Panel({
  title,
  icon,
  actions,
  children,
  className = "",
  style,
  nested = false,
  powerOn = true,
}: {
  title?: string;
  icon?: IconName;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  nested?: boolean;
  /** Play the CRT power-on animation when the panel appears. */
  powerOn?: boolean;
}) {
  return (
    <section
      className={`panel${nested ? " nested" : ""}${powerOn ? " power-on" : ""} ${className}`}
      style={style}
    >
      {title && (
        <span className="panel-title">
          {icon && <Icon name={icon} />}
          {title}
        </span>
      )}
      {actions && <span className="panel-actions">{actions}</span>}
      {children}
    </section>
  );
}

/* ─────────────────────────── Button ─────────────────────────── */

export type ButtonVariant = "primary" | "secondary" | "live" | "danger" | "danger-solid" | "ghost";

export function Button({
  variant = "secondary",
  icon,
  kbd,
  size,
  active,
  iconOnly,
  children,
  className = "",
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  icon?: IconName;
  kbd?: string;
  size?: "sm" | "lg";
  active?: boolean;
  /** Icon-only buttons need a `title` (tooltip) and get it as aria-label. */
  iconOnly?: boolean;
}) {
  const cls = [
    "btn",
    variant !== "secondary" ? `btn-${variant}` : "",
    size ?? "",
    active ? "active" : "",
    iconOnly ? "btn-icon" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button type={type} className={cls} aria-label={iconOnly ? rest.title : undefined} {...rest}>
      {icon && <Icon name={icon} size={size === "lg" ? 20 : 16} />}
      {children && <span>{children}</span>}
      {kbd && <kbd>{kbd}</kbd>}
    </button>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd>{children}</kbd>;
}

/* ─────────────────────────── Status tags, chips, progress ─────────────────────────── */

export type Tone = "neutral" | "live" | "ok" | "warn" | "danger" | "primary";

export function StatusTag({
  tone = "neutral",
  icon,
  children,
  solid = false,
  title,
}: {
  tone?: Tone;
  icon?: IconName;
  children: ReactNode;
  solid?: boolean;
  title?: string;
}) {
  return (
    <span className={`tag ${tone}${solid && tone === "live" ? " solid-live" : ""}`} title={title}>
      {icon && <Icon name={icon} />}
      {children}
    </span>
  );
}

export function Chip({ children }: { children: ReactNode }) {
  return <span className="chip">{children}</span>;
}

/** `▰▰▰▱▱ 3/5` — quota / progress bar in text form. */
export function AsciiProgress({
  used,
  limit,
  width = 5,
}: {
  used: number;
  limit: number | null;
  width?: number;
}) {
  if (limit === null) {
    return (
      <span className="ascii-progress">
        <span className="on">{used}</span>
        <span className="faint">/∞</span>
      </span>
    );
  }
  const n = Math.max(1, Math.min(width, limit || width));
  const filled = limit === 0 ? n : Math.round((Math.min(used, limit) / limit) * n);
  return (
    <span className={`ascii-progress${used >= limit ? " full" : ""}`}>
      <span className="on">{"▰".repeat(filled)}</span>
      <span className="off">{"▱".repeat(n - filled)}</span> {used}/{limit}
    </span>
  );
}

export function SeatDot({ seat }: { seat: number }) {
  return <span className="seat-dot" style={{ background: `var(--seat-${seat})` }} />;
}

/* ─────────────────────────── Stepper (wayfinding) ─────────────────────────── */

export interface StepDef {
  key: string;
  label: string;
}

/**
 * Horizontal step list: ✓ done · ▶ current · · upcoming. Done steps are
 * clickable when `onSelect` is given and the step is not locked.
 */
export function Stepper({
  steps,
  current,
  completed,
  locked,
  onSelect,
}: {
  steps: StepDef[];
  current: number;
  completed: (index: number) => boolean;
  locked?: (index: number) => boolean;
  onSelect?: (index: number) => void;
}) {
  return (
    <ol className="stepper" aria-label="Progress">
      {steps.map((s, i) => {
        const isCurrent = i === current;
        const isDone = !isCurrent && completed(i);
        const isLocked = locked?.(i) ?? false;
        const clickable = Boolean(onSelect) && isDone && !isLocked;
        const glyph = isCurrent ? "▶" : isDone ? (isLocked ? "■" : "✓") : "·";
        return (
          <li
            key={s.key}
            className={`${isCurrent ? "current" : ""} ${isDone ? "done" : ""} ${clickable ? "clickable" : ""}`}
          >
            <button
              type="button"
              disabled={!clickable}
              onClick={() => clickable && onSelect?.(i)}
              aria-current={isCurrent ? "step" : undefined}
              title={isLocked ? "Locked: the session has been created" : undefined}
            >
              <span className="glyph">{glyph}</span>
              {String(i + 1).padStart(2, "0")} {s.label}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** A labelled form field. */
export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed as children
    <label className="field">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

export function Check({
  label,
  checked,
  onChange,
  hint,
  disabled,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className="check">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>
        {label}
        {hint && <div className="hint">{hint}</div>}
      </span>
    </label>
  );
}

export function Callout({
  tone = "primary",
  icon = "info",
  children,
}: {
  tone?: Tone;
  icon?: IconName;
  children: ReactNode;
}) {
  return (
    <div className={`callout ${tone}`}>
      <span className="row nowrap" style={{ alignItems: "flex-start" }}>
        <Icon name={icon} />
        <span>{children}</span>
      </span>
    </div>
  );
}
