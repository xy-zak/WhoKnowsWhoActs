import type { ReactNode } from "react";
import {
  CLIP_PEAK_DB,
  cellCount,
  dbToCells,
  formatDb,
  levelState,
  levelTone,
  METER_CELLS,
  METER_CELLS_COMPACT,
  METER_MAX_DB,
  METER_MIN_DB,
  meterCells,
  meterValue,
  QUIET_DB,
  type RecState,
  recStateMeta,
} from "./audioMeta";
import { StatusTag } from "./components";

/*
 * Audio indicators: the microphone level meter, the recording-state tag and
 * the player's recording banner. Static by design: nothing pulses, blinks or
 * transitions, and levels redraw instantly (docs/AESTHETIC-RULES.md § 8.1).
 */

const LEVEL_HINT = { quiet: "too quiet", clipping: "clipping" } as const;
const HINT_KEYS = ["quiet", "clipping"] as const;

/** The compact meter's hover helper: what the colour means. Fixed per meter, so it never goes stale while shown. */
function meterTip(quietDb: number | null, clipPeakDb: number | null): string {
  const warns = [
    quietDb !== null ? `too quiet (below ${formatDb(quietDb)})` : null,
    clipPeakDb !== null ? `clipping (a peak at ${formatDb(clipPeakDb)} or more)` : null,
  ].filter(Boolean);
  return `Microphone level (dB full scale)${warns.length ? `. Warn colour: ${warns.join(" or ")}` : ""}`;
}

/**
 * `▮▮▮▮▮▮▮▯▯▯▯▯ −24 dB`: a microphone level as a terminal-style bar. The cells
 * are drawn with CSS in the shape of ▮/▯ (no bundled font has those glyphs, and
 * the fallbacks differ per OS and font: tiny in OpenDyslexic), so the bar looks
 * and measures the same in every font and text size. Neutral normally;
 * warn when too quiet (below −50 dBFS) or clipping (peak ≥ −1 dBFS), never red.
 * `peakDb` marks the recent peak with a bright hollow cell above the level.
 * `quietDb` / `clipPeakDb` move the warn thresholds; `quietDb={null}` drops the
 * "too quiet" warning where silence is normal (the facilitator's seats: long
 * silence is RecTag's `no_signal`). `label` is the accessible name only
 * (default "Microphone level"). `compact` is for table cells: smaller, 8 cells
 * unless `cells` is given, no hint tag (the tooltip says what the colour means).
 * The full-size meter keeps room for its hint tag, so nothing moves when it shows.
 */
export function LevelMeter({
  db,
  peakDb = null,
  min = METER_MIN_DB,
  max = METER_MAX_DB,
  cells,
  quietDb = QUIET_DB,
  clipPeakDb = CLIP_PEAK_DB,
  label = "Microphone level",
  compact = false,
}: {
  db: number | null;
  peakDb?: number | null;
  min?: number;
  max?: number;
  cells?: number;
  quietDb?: number | null;
  clipPeakDb?: number | null;
  label?: string;
  compact?: boolean;
}) {
  const n = cellCount(cells ?? (compact ? METER_CELLS_COMPACT : METER_CELLS));
  const scale = { min, max, cells: n };
  const thresholds = { quietDb, clipPeakDb };
  const state = levelState(db, peakDb, thresholds);
  const warn = levelTone(db, peakDb, thresholds) === "warn";
  const hint = state === "quiet" || state === "clipping" ? LEVEL_HINT[state] : null;
  const dbText = formatDb(db);
  const cellKinds = meterCells(dbToCells(db, scale), dbToCells(peakDb, scale), n);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a native <meter> cannot draw the text cells; role="meter" carries the same semantics
    <span
      className={`level-meter${warn ? " warn" : ""}${compact ? " compact" : ""}`}
      role="meter"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={meterValue(db, min, max)}
      aria-valuetext={state === "none" ? "no level yet" : hint ? `${dbText}, ${hint}` : dbText}
      data-tip={compact ? meterTip(quietDb, clipPeakDb) : undefined}
    >
      <span className="lm-cells" aria-hidden="true">
        {cellKinds.map((kind, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a cell is its position on the scale
          <span key={i} className={`lm-cell ${kind}`} />
        ))}
      </span>
      <span className="lm-db" aria-hidden="true">
        {dbText}
      </span>
      {!compact && (
        // both hints are laid out, one on top of the other, and only the current one is visible
        <span className="lm-hint" aria-hidden="true">
          {HINT_KEYS.filter((k) => (k === "quiet" ? quietDb : clipPeakDb) !== null).map((k) => (
            <span key={k} className={state === k ? "shown" : undefined}>
              <StatusTag tone="warn">{LEVEL_HINT[k]}</StatusTag>
            </span>
          ))}
        </span>
      )}
    </span>
  );
}

/**
 * `[🎤 REC]`, `[PAUSED]`, `[NO SIGNAL]`, `[MIC DENIED]`, … : a seat's recording
 * state as a static status tag with its icon. Recording uses the live tone
 * (never red); paused, no signal and asking use warn; denied and error use
 * danger with the warning microphone; off and skipped are neutral (and so is
 * any unknown state). `compact` shortens the text for table cells; the tooltip
 * gives the full meaning.
 */
export function RecTag({
  state,
  tip,
  compact = false,
}: {
  state: RecState;
  tip?: string;
  compact?: boolean;
}) {
  const m = recStateMeta(state);
  return (
    <StatusTag tone={m.tone} icon={m.icon} tip={tip ?? m.tip} className={`rec-tag rec-${state}`}>
      {compact ? m.short : m.text}
    </StatusTag>
  );
}

/**
 * The player's permanent, non-dismissable recording line, e.g.
 * `[🎤 REC] Your microphone is being recorded` or `[PAUSED] Recording paused
 * by the facilitator`. `children` replaces the default message (an empty or
 * `false` child keeps it: the line always says what is happening).
 */
export function RecordingBanner({ state, children }: { state: RecState; children?: ReactNode }) {
  const m = recStateMeta(state);
  const message =
    children === undefined || children === null || typeof children === "boolean" || children === ""
      ? m.banner
      : children;
  return (
    <div className={`rec-banner ${m.tone}`} role="status">
      {/* no tooltip: the message next to it already says it, in the player's words */}
      <StatusTag tone={m.tone} icon={m.icon} className={`rec-tag rec-${state}`}>
        {m.text}
      </StatusTag>
      <span className="rec-banner-text">{message}</span>
    </div>
  );
}
