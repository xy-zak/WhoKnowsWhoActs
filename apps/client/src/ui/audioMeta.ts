import type { Tone } from "./components";
import type { IconName } from "./icons";

/*
 * Pure helpers and the state table behind the audio indicators (ui/audio.tsx):
 * the level meter's maths and what each recording state looks like.
 * No React, no DOM, so they are unit-tested directly (test/audioMeta.test.ts).
 * Rules: docs/AESTHETIC-RULES.md § 8.1 Audio indicators.
 */

/* ─────────────────────────── level meter ─────────────────────────── */

/** Default meter scale in dBFS: −60 (left edge) … 0 (full). */
export const METER_MIN_DB = -60;
export const METER_MAX_DB = 0;
/** Below this RMS level the meter warns "too quiet" (dBFS). */
export const QUIET_DB = -50;
/** A peak at or above this level counts as clipping (dBFS). */
export const CLIP_PEAK_DB = -1;
/** Cells of a full-size meter and of a compact (table-cell) meter. */
export const METER_CELLS = 12;
export const METER_CELLS_COMPACT = 8;

export interface MeterScale {
  min?: number;
  max?: number;
  cells?: number;
}

/** Warn thresholds in dBFS; `null` switches that warning off (e.g. no "too quiet" where silence is normal). */
export interface LevelThresholds {
  quietDb?: number | null;
  clipPeakDb?: number | null;
}

/** A usable cell count: a whole number, at least 1. */
export function cellCount(cells: number = METER_CELLS): number {
  return Number.isFinite(cells) ? Math.max(1, Math.round(cells)) : METER_CELLS;
}

/** A level that can be drawn: finite, or −∞ (digital silence). `null`/NaN mean "no level yet". */
function usable(db: number | null | undefined): db is number {
  return typeof db === "number" && !Number.isNaN(db);
}

/**
 * Number of filled cells for a level: the level's share of the scale, rounded
 * to the nearest cell and clamped to 0…cells. −∞, `null` and anything at or
 * below `min` give 0; anything at or above `max` fills every cell.
 */
export function dbToCells(
  db: number | null | undefined,
  { min = METER_MIN_DB, max = METER_MAX_DB, cells = METER_CELLS }: MeterScale = {},
): number {
  const n = cellCount(cells);
  if (!usable(db) || !(max > min)) return 0;
  const share = (db - min) / (max - min);
  if (!(share > 0)) return 0; // also −∞
  return Math.min(n, Math.round(share * n));
}

export type LevelState = "none" | "quiet" | "ok" | "clipping";

/** What a level means: no level yet, too quiet, fine, or clipping (clipping wins over quiet). */
export function levelState(
  db: number | null | undefined,
  peakDb?: number | null,
  { quietDb = QUIET_DB, clipPeakDb = CLIP_PEAK_DB }: LevelThresholds = {},
): LevelState {
  if (clipPeakDb !== null && usable(peakDb) && peakDb >= clipPeakDb) return "clipping";
  if (!usable(db)) return "none";
  return quietDb !== null && db < quietDb ? "quiet" : "ok";
}

/** Meter tone: neutral, or warn when too quiet or clipping. Never danger: a level is not an error. */
export function levelTone(
  db: number | null | undefined,
  peakDb?: number | null,
  thresholds?: LevelThresholds,
): "neutral" | "warn" {
  const s = levelState(db, peakDb, thresholds);
  return s === "quiet" || s === "clipping" ? "warn" : "neutral";
}

/** `−24 dB`, `0 dB`, `−∞ dB`; `— dB` when there is no level. Uses the real minus sign (U+2212). */
export function formatDb(db: number | null | undefined): string {
  if (!usable(db)) return "— dB";
  if (db === Number.NEGATIVE_INFINITY) return "−∞ dB";
  if (db === Number.POSITIVE_INFINITY) return "+∞ dB";
  const r = Math.round(db);
  if (r === 0) return "0 dB"; // also −0
  return r < 0 ? `−${-r} dB` : `+${r} dB`;
}

export type MeterCell = "on" | "off" | "peak";

/**
 * The meter's cells, left to right: `filled` lit cells, then empty ones, with
 * the peak-hold cell lit on its own when the peak is above the current level
 * (a VU meter's peak marker). Always exactly `cells` long.
 */
export function meterCells(filled: number, peakCell: number, cells: number): MeterCell[] {
  const n = cellCount(cells);
  const f = Math.max(0, Math.min(n, Math.round(filled)));
  const p = Math.max(0, Math.min(n, Math.round(peakCell)));
  return Array.from(
    { length: n },
    (_, i): MeterCell => (i < f ? "on" : p > f && i === p - 1 ? "peak" : "off"),
  );
}

/** The value a `role="meter"` reports: the level clamped to the scale (`min` when there is none). */
export function meterValue(db: number | null | undefined, min = METER_MIN_DB, max = METER_MAX_DB): number {
  if (!usable(db)) return min;
  return Math.max(min, Math.min(max, db));
}

/* ─────────────────────────── recording state ─────────────────────────── */

/** Every state a seat's microphone recording can be in, as shown by RecTag / RecordingBanner. */
export const REC_STATES = [
  "recording",
  "paused",
  "no_signal",
  "denied",
  "error",
  "off",
  "skipped",
  "requesting",
] as const;
export type RecState = (typeof REC_STATES)[number];

export interface RecStateMeta {
  /** Reserved-meaning tone (§ 2.2): live = recording, warn = needs attention, danger = error. */
  tone: Extract<Tone, "neutral" | "live" | "warn" | "danger">;
  icon: IconName;
  /** Tag text (shown in UPPERCASE by the tag style, except with OpenDyslexic). */
  text: string;
  /** Short tag text for table cells (compact). */
  short: string;
  /** Hover/focus helper for the facilitator. */
  tip: string;
  /** What the player reads in the RecordingBanner. */
  banner: string;
}

export const REC_STATE_META: Record<RecState, RecStateMeta> = {
  recording: {
    tone: "live",
    icon: "microphone",
    text: "rec",
    short: "rec",
    tip: "Recording: this microphone is being recorded",
    banner: "Your microphone is being recorded",
  },
  paused: {
    tone: "warn",
    icon: "microphoneOff",
    text: "paused",
    short: "paused",
    tip: "Recording paused for everyone by the facilitator",
    banner: "Recording paused by the facilitator",
  },
  no_signal: {
    tone: "warn",
    icon: "microphoneWarning",
    text: "no signal",
    short: "no sig",
    tip: "No signal: the microphone has been silent for a long time, or the device disappeared",
    banner: "No sound from your microphone. Check that it is plugged in and switched on",
  },
  denied: {
    tone: "danger",
    icon: "microphoneWarning",
    text: "mic denied",
    short: "denied",
    tip: "Microphone permission denied in the browser",
    banner: "Your browser blocked the microphone. Please ask the facilitator for help",
  },
  error: {
    tone: "danger",
    icon: "microphoneWarning",
    text: "mic error",
    short: "error",
    tip: "The microphone or the recorder failed",
    banner: "The microphone stopped working. Please ask the facilitator for help",
  },
  off: {
    tone: "neutral",
    icon: "microphoneOff",
    text: "not recording",
    short: "off",
    tip: "Not recording: audio is off for this session or seat (e.g. a fake or simulated player)",
    banner: "Your microphone is not being recorded",
  },
  skipped: {
    tone: "neutral",
    icon: "microphoneOff",
    text: "mic skipped",
    short: "skipped",
    tip: "Microphone skipped by the facilitator: this seat is not recorded",
    banner: "Your microphone is not being recorded: the facilitator skipped it",
  },
  requesting: {
    tone: "warn",
    icon: "idle",
    text: "asking…",
    short: "asking…",
    tip: "Waiting for permission to use the microphone: the browser is asking",
    banner: "Waiting for microphone permission. Choose Allow in your browser's prompt",
  },
};

/** The look of a recording state. Anything unknown (e.g. a capture state such as "idle") reads as not recording. */
export function recStateMeta(state: string): RecStateMeta {
  return Object.hasOwn(REC_STATE_META, state) ? REC_STATE_META[state as RecState] : REC_STATE_META.off;
}
