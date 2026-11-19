import { z } from "zod";

/* ═══════════════════════════════════════════════════════════════════════════
 * AUDIO REASON CATALOGUE — every track start reason, track stop reason and
 * microphone state, with what each one means. This file is the only place
 * where that is written down: the zod enums (and so the socket protocol and
 * the event payloads), the audio_tracks.csv codebook, the server's
 * `interrupted` / `closed` track status, the facilitator's labels and
 * wrap-up check, and the capture engine's reason types all come from here.
 * Add a reason here, then run `npm run docs:generate`.
 * ═══════════════════════════════════════════════════════════════════════════ */

/** One track start reason. */
export interface AudioStartReasonDef {
  /** Short text for the facilitator's event log and timeline, e.g. "page reload". */
  label: string;
  /** What it means, for the codebook and the schema docs (lower case, no final full stop). */
  description: string;
}

/**
 * How a track ended, which decides its stored and exported status: `clean` → `closed`,
 * `interrupted` → `interrupted` (the browser or its microphone went away, or the server restarted).
 */
export type AudioTrackEnding = "clean" | "interrupted";

/** One track stop reason. */
export interface AudioStopReasonDef extends AudioStartReasonDef {
  ending: AudioTrackEnding;
  /**
   * How the facilitator's wrap-up check names a track that stopped for this reason (audio may be
   * missing), or null when it does not flag it. Every `interrupted` reason is flagged; a few clean
   * ones are too (e.g. `track_ended`), without changing their status.
   */
  wrapUpIssue: string | null;
}

/** One microphone state, as a browser reports it in `audio:level`. */
export interface MicStateDef {
  description: string;
  /** The engine holds the microphone and wants to record: permission granted, a track may run. */
  capturing: boolean;
  /** Audio is flowing, so there is a level to show (implies `capturing`). */
  hasLevel: boolean;
}

export const AUDIO_START_REASON_DEFS = {
  mic_check: { label: "mic check", description: "first capture of the seat (its mic check)" },
  resume: { label: "recording resumed", description: "recording resumed after a facilitator pause" },
  reconnect: { label: "reconnect", description: "the browser reconnected" },
  reload: { label: "page reload", description: "the page was reloaded" },
  permission_regained: {
    label: "microphone back",
    description: "the microphone came back after a permission or device loss",
  },
  context_resumed: {
    label: "audio engine resumed",
    description:
      "the browser's audio engine ran again after the system suspended it (e.g. sleep, another app took the device)",
  },
  clock_jump: {
    label: "clock jump",
    description: "the capture clock jumped, so a new track keeps the sample timeline exact",
  },
  discontinuity: {
    label: "audio discontinuity",
    description: "the browser delivered a gap or overlap in the audio too large to patch",
  },
  cleared: {
    label: "unsent audio cleared",
    description:
      "the browser discarded its unsent audio (e.g. the seat was unbound) and capture continued in a new track",
  },
} as const satisfies Record<string, AudioStartReasonDef>;

const clean = (
  label: string,
  description: string,
  wrapUpIssue: string | null = null,
): AudioStopReasonDef => ({
  label,
  description,
  ending: "clean",
  wrapUpIssue,
});
const interrupted = (label: string, description: string, wrapUpIssue: string): AudioStopReasonDef => ({
  label,
  description,
  ending: "interrupted",
  wrapUpIssue,
});

export const AUDIO_STOP_REASON_DEFS = {
  paused: clean("recording paused", "facilitator paused recording"),
  game_complete: clean("game complete", "the game ended"),
  closed: clean("session closed", "the session was closed"),
  aborted: clean("session aborted", "the session was aborted"),
  withdrawn: clean("withdrawn", "the participant withdrew"),
  disconnect: interrupted(
    "disconnected",
    "the browser disconnected (the server closed the track)",
    "disconnected",
  ),
  permission_lost: interrupted(
    "microphone permission lost",
    "the microphone permission or device went away",
    "microphone permission lost",
  ),
  error: interrupted(
    "capture error",
    "capture failed (also when the browser closed its audio engine)",
    "capture error",
  ),
  client_stop: clean("stopped by the browser", "the browser stopped the track itself (e.g. page unload)"),
  skipped: clean(
    "mic check skipped",
    "the facilitator skipped the seat's mic check (the seat is not recorded)",
  ),
  interrupted: interrupted(
    "interrupted",
    "the server found the track still open when it loaded the session again (e.g. after a restart) or the seat started another track",
    "not closed cleanly",
  ),
  context_suspended: clean("audio engine suspended", "the system suspended the browser's audio engine"),
  context_interrupted: clean(
    "audio engine interrupted",
    "the system interrupted the browser's audio engine",
    "audio engine interrupted",
  ),
  clock_jump: clean("clock jump", "the capture clock jumped"),
  discontinuity: clean("audio discontinuity", "a gap or overlap in the audio too large to patch"),
  track_ended: clean(
    "microphone track ended",
    "the browser ended the microphone track (device unplugged or permission revoked)",
    "microphone unplugged or blocked",
  ),
  cleared: clean(
    "unsent audio cleared",
    "the browser discarded its unsent audio (e.g. the seat was unbound)",
  ),
} as const satisfies Record<string, AudioStopReasonDef>;

export const MIC_STATE_DEFS = {
  recording: { description: "capturing with signal", capturing: true, hasLevel: true },
  no_signal: {
    description: "capturing but silent for a long time (muted or unplugged mic)",
    capturing: true,
    hasLevel: true,
  },
  denied: { description: "permission refused", capturing: false, hasLevel: false },
  error: { description: "capture failed", capturing: false, hasLevel: false },
  idle: { description: "not capturing (not yet, or not allowed)", capturing: false, hasLevel: false },
  paused: {
    description: "recording paused by the facilitator (or the browser's audio engine was suspended)",
    capturing: true,
    hasLevel: false,
  },
  requesting: {
    description: "waiting for the permission prompt or setting up capture",
    capturing: false,
    hasLevel: false,
  },
} as const satisfies Record<string, MicStateDef>;

/* ─────────────────────────── derived: values, types, schemas ─────────────────────────── */

const keysOf = <K extends string>(defs: Record<K, unknown>) => Object.keys(defs) as [K, ...K[]];

/** Why a track (one continuous capture run) started. */
export const AUDIO_START_REASONS = keysOf(AUDIO_START_REASON_DEFS);
export type AudioStartReason = keyof typeof AUDIO_START_REASON_DEFS;
/** Why a track stopped. */
export const AUDIO_STOP_REASONS = keysOf(AUDIO_STOP_REASON_DEFS);
export type AudioStopReason = keyof typeof AUDIO_STOP_REASON_DEFS;
/** State of a seat's microphone, as reported by its browser in `audio:level`. */
export const MIC_LEVEL_STATES = keysOf(MIC_STATE_DEFS);
export type MicLevelState = keyof typeof MIC_STATE_DEFS;

/** "'a' = what a means, 'b' = …": the value list of a codebook or schema description. */
function valueList(defs: Record<string, { description: string }>): string {
  return Object.entries(defs)
    .map(([value, d]) => `'${value}' = ${d.description}`)
    .join(", ");
}

/** Description of the start reason values (the schema's and the `start_reason` column's). */
export const AUDIO_START_REASONS_DOC = `Why the track started: ${valueList(AUDIO_START_REASON_DEFS)}`;
/** Description of the stop reason values (the schema's and the `stop_reason` column's). */
export const AUDIO_STOP_REASONS_DOC = `Why the track stopped: ${valueList(AUDIO_STOP_REASON_DEFS)}`;

export const AudioStartReasonSchema = z.enum(AUDIO_START_REASONS).describe(AUDIO_START_REASONS_DOC);
export const AudioStopReasonSchema = z.enum(AUDIO_STOP_REASONS).describe(AUDIO_STOP_REASONS_DOC);
export const MicLevelStateSchema = z
  .enum(MIC_LEVEL_STATES)
  .describe(`Microphone state: ${valueList(MIC_STATE_DEFS)}`);

/** Stop reasons whose track counts as `interrupted`, in catalogue order. */
export const INTERRUPTED_STOP_REASONS = AUDIO_STOP_REASONS.filter(
  (r) => AUDIO_STOP_REASON_DEFS[r].ending === "interrupted",
);

/* ─────────────────────────── lookups ─────────────────────────── */

const has = (defs: object, key: string) => Object.hasOwn(defs, key);

export function isAudioStartReason(s: string): s is AudioStartReason {
  return has(AUDIO_START_REASON_DEFS, s);
}
export function isAudioStopReason(s: string): s is AudioStopReason {
  return has(AUDIO_STOP_REASON_DEFS, s);
}

/**
 * How a closed track ended, from its stop reason: null (no reason stored) is clean; a reason this
 * build does not know (an older or newer client wrote it) counts as interrupted.
 */
export function audioTrackEnding(stopReason: string | null): AudioTrackEnding {
  if (stopReason === null) return "clean";
  return isAudioStopReason(stopReason) ? AUDIO_STOP_REASON_DEFS[stopReason].ending : "interrupted";
}

/**
 * Is the microphone capturing: held by the engine, which wants to record (`recording`,
 * `no_signal`, `paused`)? States outside the catalogue (e.g. the UI's `off`) are not.
 */
export function micCapturing(state: string): boolean {
  return has(MIC_STATE_DEFS, state) && MIC_STATE_DEFS[state as MicLevelState].capturing;
}

/** Is audio flowing, so there is a level to show (`recording`, `no_signal`)? */
export function micHasLevel(state: string): boolean {
  return has(MIC_STATE_DEFS, state) && MIC_STATE_DEFS[state as MicLevelState].hasLevel;
}
