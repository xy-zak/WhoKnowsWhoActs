import type { ButtonHTMLAttributes, CSSProperties, InputHTMLAttributes, ReactNode, Ref } from "react";
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
}: {
  title?: string;
  icon?: IconName;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  nested?: boolean;
}) {
  return (
    <section className={`panel${nested ? " nested" : ""} ${className}`} style={style}>
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
  tip,
  title,
  children,
  className = "",
  type = "button",
  ref,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  ref?: Ref<HTMLButtonElement>;
  variant?: ButtonVariant;
  icon?: IconName;
  kbd?: string;
  size?: "sm" | "lg";
  active?: boolean;
  /** Icon-only buttons need a `title`: it becomes their aria-label (and their tooltip when there is no `tip`). */
  iconOnly?: boolean;
  /** Hover/focus helper text (styled tooltip, also exposed to screen readers). Defaults to `title`. */
  tip?: string;
}) {
  const tipText = tip ?? title;
  const label = iconOnly ? title : undefined;
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
    <button
      ref={ref}
      type={type}
      className={cls}
      aria-label={label}
      data-tip={tipText}
      aria-description={tipText !== label ? tipText : undefined}
      {...rest}
    >
      {icon && <Icon name={icon} size={size === "lg" ? 20 : 16} />}
      {children && <span>{children}</span>}
      {kbd && <kbd>{kbd}</kbd>}
    </button>
  );
}

/* ─────────────────────────── Status tags, chips, progress ─────────────────────────── */

export type Tone = "neutral" | "live" | "ok" | "warn" | "danger" | "primary";

export function StatusTag({
  tone = "neutral",
  icon,
  children,
  solid = false,
  title,
  tip,
  className = "",
}: {
  tone?: Tone;
  icon?: IconName;
  children: ReactNode;
  solid?: boolean;
  /** Hover/focus helper text (styled tooltip). `title` is kept as an alias. */
  title?: string;
  tip?: string;
  className?: string;
}) {
  const help = tip ?? title;
  return (
    <span
      className={`tag ${tone}${solid && tone === "live" ? " solid-live" : ""} ${className}`}
      data-tip={help}
      aria-description={help}
    >
      {icon && <Icon name={icon} />}
      {children}
    </span>
  );
}

export function Chip({ children }: { children: ReactNode }) {
  return <span className="chip">{children}</span>;
}

/**
 * `▰▰▰▱▱ 3/5` — quota / progress bar in text form. At most `width` cells (fewer for a smaller
 * limit). `label` makes it a `role="progressbar"` with that name and its values; without a label
 * and without text it is decorative (hidden from screen readers). `text` replaces `used/limit`
 * (null: no text), `filled` the rounded count of lit cells, `color` the lit cells' colour.
 */
export function AsciiProgress({
  used,
  limit,
  width = 5,
  label,
  text,
  filled,
  color,
  className = "",
}: {
  used: number;
  limit: number | null;
  width?: number;
  label?: string;
  text?: ReactNode;
  filled?: number;
  color?: string;
  className?: string;
}) {
  if (limit === null) {
    return (
      <span className={`ascii-progress ${className}`.trim()}>
        <span className="on">{used}</span>
        <span className="faint">/∞</span>
      </span>
    );
  }
  const n = Math.max(1, Math.min(width, limit || width));
  const on = Math.max(
    0,
    Math.min(n, filled ?? (limit === 0 ? n : Math.round((Math.min(used, limit) / limit) * n))),
  );
  const shown = text === undefined ? `${used}/${limit}` : text;
  const a11y = label
    ? {
        role: "progressbar",
        "aria-label": label,
        "aria-valuemin": 0,
        "aria-valuemax": limit,
        "aria-valuenow": Math.min(used, limit),
      }
    : shown === null
      ? { "aria-hidden": true }
      : {};
  return (
    <span className={`ascii-progress${used >= limit ? " full" : ""} ${className}`.trim()} {...a11y}>
      <span className="on" style={color ? { color } : undefined}>
        {"▰".repeat(on)}
      </span>
      <span className="off">{"▱".repeat(n - on)}</span>
      {shown !== null && <> {shown}</>}
    </span>
  );
}

/** CSS colour of a seat (--seat-1 …); no seat gets the faint colour. */
export const seatColour = (seat: number | null) => (seat === null ? "var(--faint)" : `var(--seat-${seat})`);

export function SeatDot({ seat }: { seat: number }) {
  return <span className="seat-dot" style={{ background: seatColour(seat) }} />;
}

/* ─────────────────────────── Knowledge / power colours ─────────────────────────── */

/**
 * CSS colour of a knowledge type (Ka–Kd) or power type (Pa–Pd): both use the
 * colour of their letter (--k-a … --k-d). Unknown labels get the text colour.
 */
export function kColour(label: string | null | undefined): string {
  const letter = label?.[1];
  return letter && "abcd".includes(letter) ? `var(--k-${letter})` : "var(--text)";
}

/** A K or P label with its colour swatch, e.g. ▣ Kb. Pass `tip` to explain it on hover. */
export function LabelTag({ label, tip, filled = false }: { label: string; tip?: string; filled?: boolean }) {
  return (
    <span
      className="ktag"
      data-tip={tip}
      style={{ "--k": kColour(label) } as CSSProperties}
      aria-description={tip}
    >
      <span className={`ksw${filled ? " filled" : ""}`} aria-hidden="true" />
      {label}
    </span>
  );
}

/**
 * The map's propose/decide mark as a small swatch: hatched = proposed,
 * filled = decided, in the colour of the sub-square's knowledge type (or the
 * text colour when no type is given, e.g. in a legend).
 */
export function ActSwatch({ kind, k }: { kind: "propose" | "decide"; k?: string | null }) {
  return (
    <span
      className={`act-sw ${kind}`}
      style={k ? ({ "--k": kColour(k) } as CSSProperties) : undefined}
      aria-hidden="true"
    />
  );
}

/* ─────────────────────────── GridTable ─────────────────────────── */

/**
 * A `table.grid`: a header row of `head`, the rows as children, then `empty` (unless false) as
 * one faint row across all columns. `scroll` wraps it in a scroll box; a number is its max height.
 */
export function GridTable({
  head,
  empty,
  scroll,
  children,
}: {
  head?: string[];
  empty?: ReactNode;
  scroll?: true | number;
  children: ReactNode;
}) {
  const table = (
    <table className="grid">
      {head && (
        <thead>
          <tr>
            {head.map((h, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed columns, some without a title
              <th key={i}>{h}</th>
            ))}
          </tr>
        </thead>
      )}
      <tbody>
        {children}
        {empty && (
          <tr>
            <td colSpan={head?.length} className="faint">
              {empty}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
  if (!scroll) return table;
  return <div style={{ maxHeight: scroll === true ? undefined : scroll, overflow: "auto" }}>{table}</div>;
}

/* ─────────────────────────── Stepper (wayfinding) ─────────────────────────── */

export interface StepDef {
  key: string;
  label: string;
}

/** "07": the shown number of the step at 0-based index `i`. */
export const stepNum = (i: number) => String(i + 1).padStart(2, "0");

/** A step's glyph: ▶ current · ■ locked · – skipped (done) · ✓ done · · upcoming. */
export const stepGlyph = (s: { current: boolean; done: boolean; locked?: boolean; skipped?: boolean }) =>
  s.current ? "▶" : s.locked ? "■" : s.skipped && s.done ? "–" : s.done ? "✓" : "·";

/** Horizontal step list. Done steps are clickable when `onSelect` is given. */
export function Stepper({
  steps,
  current,
  completed,
  onSelect,
}: {
  steps: StepDef[];
  current: number;
  completed: (index: number) => boolean;
  onSelect?: (index: number) => void;
}) {
  return (
    <ol className="stepper" aria-label="Progress">
      {steps.map((s, i) => {
        const isCurrent = i === current;
        const isDone = !isCurrent && completed(i);
        const clickable = Boolean(onSelect) && isDone;
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
            >
              <span className="glyph">{stepGlyph({ current: isCurrent, done: isDone })}</span>
              {stepNum(i)} {s.label}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** A labelled form field. */
export function Field({
  label,
  hint,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed as children
    <label className="field">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

/** A text input and its submit button in one row; Enter submits too, unless `disabled`. */
export function TextSubmit({
  icon,
  tip,
  disabled,
  onSubmit,
  children,
  ...input
}: Omit<InputHTMLAttributes<HTMLInputElement>, "onSubmit"> & {
  icon: IconName;
  tip: string;
  onSubmit: () => void;
}) {
  return (
    <form
      className="row nowrap"
      onSubmit={(e) => {
        e.preventDefault();
        if (!disabled) onSubmit();
      }}
    >
      <input type="text" style={{ flex: 1 }} {...input} />
      <Button type="submit" icon={icon} disabled={disabled} tip={tip}>
        {children}
      </Button>
    </form>
  );
}

/** An error message (e.g. from the server, shown verbatim) with the error icon; nothing when empty. */
export function ErrorText({ text }: { text?: string | null | false }) {
  if (!text) return null;
  return (
    <span className="small t-danger" role="alert">
      <Icon name="error" /> {text}
    </span>
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

/** [ONLINE] / [OFFLINE] tag that flickers (CRT) whenever the connection state changes. */
export function ConnTag({ connected, withdrawn = false }: { connected: boolean; withdrawn?: boolean }) {
  if (withdrawn) return <StatusTag>withdrawn</StatusTag>;
  return connected ? (
    <StatusTag key="on" tone="live" className="conn-flicker">
      online
    </StatusTag>
  ) : (
    <StatusTag key="off" tone="danger" icon="disconnected" className="conn-flicker">
      offline
    </StatusTag>
  );
}
