import {
  AUDIO_SAMPLE_RATE,
  type AudioTrackSummary,
  type CalibrationQuality,
  type GameState,
  isParticipant,
  micCheckApplies,
  RECORDING_PHASES,
  type SeatLiveStats,
  type SeatMicStats,
  type SeatState,
  type StoredEvent,
  seatList,
  shouldRecord,
} from "@wkwa/shared";
import type { RecState } from "../ui/audioMeta";

/*
 * Pure helpers behind the facilitator's LIVE audio monitoring: the seats table's mic column,
 * the status bar's mic count, the calibration quality card, the wrap-up audio check and the
 * timeline's audio lanes. No React, no DOM: unit-tested in test/audioLive.test.ts.
 */

/** No stored chunk for this long while a seat says it records: the mic column warns (ms). */
export const STALE_CHUNK_MS = 15_000;
/** Upload backlog (chunks of 5 s) at which the mic column warns, growing or not. */
export const BACKLOG_WARN_CHUNKS = 3;
/** The engine's minimum calibration margin (dB): below it a seat's voice is hard to tell apart. */
export const CALIBRATION_MIN_MARGIN_DB = 10;

/** Each seat's live mic figures from the dashboard's stats. */
export function micStatsOf(stats: Record<number, SeatLiveStats> | undefined): Record<number, SeatMicStats> {
  const out: Record<number, SeatMicStats> = {};
  for (const [seat, s] of Object.entries(stats ?? {})) if (s.mic) out[Number(seat)] = s.mic;
  return out;
}

/* ─────────────────────────── seats table: mic column ─────────────────────────── */

export interface MicCell {
  state: RecState;
  /** Hover helper of the tag: what the state means for this seat (undefined = the state's own). */
  tip?: string;
  /** Level to draw (null = no meter reading to show). */
  db: number | null;
  peakDb: number | null;
}

/** Should this seat record if recording were not paused? (The denominator of "mics n/m".) */
export function recordingExpected(st: GameState, seat: SeatState): boolean {
  return shouldRecord({ ...st, audio: { ...st.audio, recordingPaused: false } }, seat);
}

/**
 * What the mic column shows for a seat: the browser's reported state, `paused` while the
 * facilitator paused recording, `skipped` when the mic check was skipped, `off` before the mic
 * check, for seats that are never recorded (fake player, agent, no audio consent, withdrawn) and
 * while there is no reading (`idle`, e.g. the browser disconnected).
 */
export function micCell(st: GameState, seat: SeatState, mic: SeatMicStats | undefined): MicCell {
  const off = (tip: string): MicCell => ({ state: "off", tip, db: null, peakDb: null });
  if (!st.audio.enabled) return off("This session does not record audio");
  if (!seat.bound) return off("No client in this seat");
  if (!isParticipant(seat)) return off("Not recorded: fake player or agent");
  if (seat.withdrawn) return off("Not recorded: the participant withdrew");
  if (seat.consent === "declined") return off("Not recorded: consent declined");
  if (seat.consent === "given" && !seat.audioConsent)
    return off("Not recorded: the participant did not permit audio recording");
  if (seat.micCheck === "skipped")
    return { state: "skipped", tip: "Mic check skipped: this seat is not recorded", db: null, peakDb: null };
  if (st.phase === "game_complete" || st.phase === "closed" || st.phase === "aborted")
    return off("Not recording: the game is complete");
  if (st.audio.recordingPaused)
    return {
      state: "paused",
      tip: "Recording paused for everyone by the facilitator",
      db: null,
      peakDb: null,
    };
  if (!mic || mic.state === "idle")
    return off(
      seat.consent !== "given"
        ? "Not recording yet: recording starts at the mic check, after consent"
        : recordingExpected(st, seat)
          ? "Not recording: no reading from this browser (disconnected, or the mic check has not opened the microphone yet)"
          : "Not recording yet: the mic checks wait until every seat has finished consent",
    );
  const level = mic.state === "recording" || mic.state === "no_signal";
  return {
    state: mic.state,
    ...(mic.state === "paused"
      ? {
          tip: "Paused: the browser's audio engine was suspended (e.g. the laptop slept, or another app took the microphone)",
        }
      : {}),
    db: level ? mic.rmsDb : null,
    peakDb: level ? mic.peakDb : null,
  };
}

/** Upload backlog trend of one seat: the last value that differed, and whether it went up then. */
export interface BacklogTrend {
  n: number;
  growing: boolean;
}

/** Next trend after a reading of `n` pending chunks (unchanged when `n` is the same as before). */
export function nextBacklogTrend(prev: BacklogTrend | undefined, n: number): BacklogTrend {
  if (!prev) return { n, growing: false };
  if (n === prev.n) return prev;
  return { n, growing: n > prev.n };
}

/** Backlog tone: warn when large, or when it grows beyond the one chunk in flight. */
export function backlogTone(n: number, growing: boolean): "neutral" | "warn" {
  return n >= BACKLOG_WARN_CHUNKS || (growing && n >= 2) ? "warn" : "neutral";
}

/** Age of the seat's last stored chunk (ms; null = none yet), warn when stale while recording. */
export function chunkAge(
  mic: SeatMicStats | undefined,
  serverNow: number,
): { ageMs: number | null; stale: boolean } {
  if (!mic || mic.lastChunkServerTs === null) return { ageMs: null, stale: false };
  const ageMs = Math.max(0, serverNow - mic.lastChunkServerTs);
  return { ageMs, stale: mic.state === "recording" && ageMs > STALE_CHUNK_MS };
}

/** `0.0 min`, `12.3 min`: audio stored for a seat. */
export function fmtMinutes(ms: number): string {
  return `${(Math.max(0, ms) / 60_000).toFixed(1)} min`;
}

/** Mic check status of a seat, for the mic column during onboarding (null = not applicable). */
export function micCheckText(st: GameState, seat: SeatState): string | null {
  if (!st.audio.enabled || !seat.bound || seat.withdrawn || !isParticipant(seat)) return null;
  if (seat.consent !== "given") return null;
  if (!micCheckApplies(st, seat)) return null;
  return seat.micCheck === "passed"
    ? "check passed"
    : seat.micCheck === "skipped"
      ? "check skipped"
      : "check pending";
}

/* ─────────────────────────── status bar: "mics 3/4" ─────────────────────────── */

export interface MicsSummary {
  /** The session records audio and is in a recording phase (show the segment). */
  show: boolean;
  paused: boolean;
  /** Seats whose browser reports `recording`. */
  recording: number;
  /** Seats that should record now (ignoring a pause). */
  expected: number;
  /** Expected seats that are not recording (seat numbers). */
  missing: number[];
}

export function micsSummary(st: GameState, mics: Record<number, SeatMicStats | undefined>): MicsSummary {
  const show = st.audio.enabled && RECORDING_PHASES.has(st.phase);
  const expected = seatList(st).filter((s) => recordingExpected(st, s));
  const ok = expected.filter((s) => mics[s.seat]?.state === "recording");
  return {
    show,
    paused: st.audio.recordingPaused,
    recording: ok.length,
    expected: expected.length,
    missing: expected.filter((s) => !ok.includes(s)).map((s) => s.seat),
  };
}

/* ─────────────────────────── calibration quality ─────────────────────────── */

export type SeatQuality = CalibrationQuality["perSeat"][number];

/** `+4 dB`, `−2 dB`, `—` for a calibration margin. */
export function fmtMargin(db: number | null): string {
  if (db === null || !Number.isFinite(db)) return "—";
  // one decimal: a failing 9.6 dB must not read as a passing "+10 dB"
  const r = Math.round(db * 10) / 10;
  if (r === 0) return "0.0 dB";
  return `${r < 0 ? "−" : "+"}${Math.abs(r).toFixed(1)} dB`;
}

/** Plain advice for one seat of the calibration check (null when the seat passed). */
export function calibrationAdvice(r: SeatQuality): string | null {
  if (r.ok) return null;
  if (r.ownDb === null || r.marginDb === null)
    return `No audio from seat ${r.seat}: check its microphone and connection, then redo the calibration.`;
  if (r.marginDb < CALIBRATION_MIN_MARGIN_DB)
    return `Seat ${r.seat}: own voice only ${fmtMargin(r.marginDb)} over the others. Move the laptop closer or use a headset, then redo the calibration.`;
  return `Seat ${r.seat}: its voice is hard to tell apart from the others on the other microphones. Move the laptop closer or use a headset, then redo the calibration.`;
}

/* ─────────────────────────── wrap-up audio check ─────────────────────────── */

/** The parts of a stored track the wrap-up check needs (GET /api/sessions/:id/audio → tracks). */
export type TrackStatusLite = Pick<AudioTrackSummary, "seat" | "status" | "stopReason" | "gaps">;

export interface AudioCheckLine {
  seat: number;
  /** `upload`: audio still on its way (keep the browser open); `issue`: something is missing. */
  kind: "upload" | "issue";
  text: string;
}

export interface AudioCheck {
  /** Nothing still on its way: every track closed, no pending upload. */
  uploaded: boolean;
  lines: AudioCheckLine[];
}

const BROKEN_STOPS: Record<string, string> = {
  disconnect: "disconnected",
  interrupted: "not closed cleanly",
  error: "capture error",
  permission_lost: "microphone permission lost",
  track_ended: "microphone unplugged or blocked",
  context_interrupted: "audio engine interrupted",
};

/**
 * Before closing: is every real seat's audio on the server? Uses the live upload backlog and the
 * stored tracks (null while not loaded yet). Interrupted tracks and missing chunks are listed too.
 */
export function wrapUpAudioCheck(
  st: GameState,
  mics: Record<number, SeatMicStats | undefined>,
  tracks: TrackStatusLite[] | null,
): AudioCheck {
  const lines: AudioCheckLine[] = [];
  if (!st.audio.enabled) return { uploaded: true, lines };
  for (const s of seatList(st)) {
    if (!s.bound && !tracks?.some((t) => t.seat === s.seat)) continue;
    if (!isParticipant(s)) continue;
    const mine = tracks?.filter((t) => t.seat === s.seat) ?? [];
    const pending = mics[s.seat]?.pendingChunks ?? 0;
    const open = mine.filter((t) => t.status === "open").length;
    if (pending > 0)
      lines.push({
        seat: s.seat,
        kind: "upload",
        text: `Seat ${s.seat} still uploading ${pending} chunk${pending === 1 ? "" : "s"}: keep that browser open.`,
      });
    else if (open > 0)
      lines.push({
        seat: s.seat,
        kind: "upload",
        text: `Seat ${s.seat}: track still open (the browser has not finished): keep that browser open.`,
      });
    const broken = new Map<string, number>();
    for (const t of mine) {
      // the server marks disconnect / error / permission stops `interrupted` too: name the reason first
      const why =
        BROKEN_STOPS[t.stopReason ?? ""] ??
        (t.status === "interrupted" ? BROKEN_STOPS.interrupted : undefined);
      if (why) broken.set(why, (broken.get(why) ?? 0) + 1);
    }
    for (const [why, n] of broken)
      lines.push({
        seat: s.seat,
        kind: "issue",
        text: `Seat ${s.seat}: ${n === 1 ? "track" : `${n} tracks`} interrupted (${why}).`,
      });
    const gaps = mine.reduce((n, t) => n + t.gaps, 0);
    if (gaps > 0)
      lines.push({
        seat: s.seat,
        kind: "issue",
        text: `Seat ${s.seat}: ${gaps} chunk${gaps === 1 ? "" : "s"} missing from the stored audio.`,
      });
    if (
      tracks !== null &&
      mine.length === 0 &&
      !s.withdrawn &&
      st.onboardingSteps.includes("mic_check") &&
      micCheckApplies(st, s) &&
      s.micCheck !== "skipped" &&
      s.consent === "given"
    )
      lines.push({ seat: s.seat, kind: "issue", text: `Seat ${s.seat}: no audio recorded.` });
  }
  return { uploaded: tracks !== null && !lines.some((l) => l.kind === "upload"), lines };
}

/* ─────────────────────────── timeline audio lanes ─────────────────────────── */

export interface Span {
  s: number;
  /** null = still open */
  e: number | null;
}

export interface AudioSpans {
  /** Recording spans per seat (AudioTrackStarted → AudioTrackStopped). */
  tracks: Array<Span & { seat: number; trackId: string; reason: string; stopReason: string | null }>;
  /** Recording paused for everyone (RecordingPaused → RecordingResumed). */
  pauses: Array<Span & { reason: string | null }>;
  /** Calibration runs (CalibrationStarted → CalibrationCompleted / CalibrationSkipped). */
  calibrations: Array<Span & { cancelled: boolean }>;
  /** Calibration turns per seat. */
  turns: Array<Span & { seat: number }>;
  /** First audio event (null = none: the session has no audio lanes). */
  firstTs: number | null;
}

/** Audio coverage from the event log, for the timeline's lanes. */
export function audioSpans(events: readonly StoredEvent[]): AudioSpans {
  const out: AudioSpans = { tracks: [], pauses: [], calibrations: [], turns: [], firstTs: null };
  let turnMs = 0;
  const mark = (ts: number) => {
    if (out.firstTs === null) out.firstTs = ts;
  };
  const closeTurn = (ts: number) => {
    const t = out.turns.at(-1);
    if (t && t.e === null) t.e = Math.min(ts, t.s + turnMs);
  };
  for (const ev of events) {
    switch (ev.type) {
      case "AudioTrackStarted":
        mark(ev.serverTs);
        if (ev.seat !== null)
          out.tracks.push({
            seat: ev.seat,
            trackId: ev.payload.trackId,
            reason: ev.payload.reason,
            stopReason: null,
            s: ev.serverTs,
            e: null,
          });
        break;
      case "AudioTrackStopped": {
        const t = out.tracks.find((x) => x.trackId === ev.payload.trackId && x.e === null);
        if (t) {
          t.e = ev.serverTs;
          t.stopReason = ev.payload.reason;
        }
        break;
      }
      case "RecordingPaused":
        mark(ev.serverTs);
        out.pauses.push({ s: ev.serverTs, e: null, reason: ev.payload.reason ?? null });
        break;
      case "RecordingResumed": {
        const p = out.pauses.at(-1);
        if (p && p.e === null) p.e = ev.serverTs;
        break;
      }
      case "CalibrationStarted":
        mark(ev.serverTs);
        turnMs = ev.payload.turnMs;
        out.calibrations.push({ s: ev.serverTs, e: null, cancelled: false });
        break;
      case "CalibrationTurn":
        closeTurn(ev.serverTs);
        if (out.calibrations.at(-1)?.e === null)
          out.turns.push({ seat: ev.payload.seat, s: ev.serverTs, e: null });
        break;
      case "CalibrationCompleted": {
        const c = out.calibrations.at(-1);
        if (c && c.e === null) c.e = ev.serverTs;
        // the logged windows are exact: replace the estimated ones of this run
        if (c) {
          out.turns = out.turns.filter((t) => t.s < c.s);
          for (const t of ev.payload.turns) out.turns.push({ seat: t.seat, s: t.startTs, e: t.endTs });
        }
        break;
      }
      case "CalibrationSkipped": {
        closeTurn(ev.serverTs);
        const c = out.calibrations.at(-1);
        if (c && c.e === null) {
          c.e = ev.serverTs;
          c.cancelled = ev.payload.cancelled === true;
        }
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/* ─────────────────────────── event log one-liners ─────────────────────────── */

/** First 8 characters of a track id: enough to tell tracks apart in the log. */
export function shortTrack(trackId: string): string {
  return trackId.slice(0, 8);
}

export const START_REASON_TEXT: Record<string, string> = {
  mic_check: "mic check",
  resume: "recording resumed",
  reconnect: "reconnect",
  reload: "page reload",
  permission_regained: "microphone back",
  context_resumed: "audio engine resumed",
  clock_jump: "clock jump",
  discontinuity: "audio discontinuity",
  cleared: "unsent audio cleared",
};

export const STOP_REASON_TEXT: Record<string, string> = {
  paused: "recording paused",
  game_complete: "game complete",
  closed: "session closed",
  aborted: "session aborted",
  withdrawn: "withdrawn",
  disconnect: "disconnected",
  permission_lost: "microphone permission lost",
  error: "capture error",
  client_stop: "stopped by the browser",
  skipped: "mic check skipped",
  interrupted: "interrupted",
  context_suspended: "audio engine suspended",
  context_interrupted: "audio engine interrupted",
  clock_jump: "clock jump",
  discontinuity: "audio discontinuity",
  track_ended: "microphone track ended",
  cleared: "unsent audio cleared",
};

/** `2:05` from a sample count at 16 kHz. */
export function samplesText(samples: number): string {
  const s = Math.round(samples / AUDIO_SAMPLE_RATE);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
