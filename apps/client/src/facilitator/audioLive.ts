import {
  AUDIO_STOP_REASON_DEFS,
  AUDIO_STOP_REASONS,
  type AudioStartReason,
  type AudioStopReason,
  type AudioTrackSummary,
  CALIBRATION_MIN_MARGIN_DB,
  type CalibrationQuality,
  currentCalibrationTurn,
  isParticipant,
  isRecordedSeat,
  type MicCheckStatus,
  micCheckApplies,
  micHasLevel,
  RECORDING_PHASES,
  type ReadonlyGameState,
  type ReadonlySeatState,
  recordingVerdict,
  type SeatLiveStats,
  type SeatMicStats,
  type StoredEvent,
  seatList,
} from "@wkwa/shared";
import { fmtSigned, plural } from "../common/format";
import type { RecState } from "../ui/audioMeta";
import type { Tone } from "../ui/components";
import type { IconName } from "../ui/icons";

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
export function recordingExpected(st: ReadonlyGameState, seat: ReadonlySeatState): boolean {
  const v = recordingVerdict(st, seat);
  return v.record || v.reason === "paused";
}

/**
 * What the mic column shows for a seat, from its recording verdict: `off` (with why) for seats
 * that are not recorded or past the game, `skipped` for a skipped mic check, `paused` while only
 * the facilitator's pause stops the seat. Otherwise the browser's reported state, and `off` while
 * there is no reading (`idle`, e.g. the browser disconnected, or before the mic check).
 */
export function micCell(
  st: ReadonlyGameState,
  seat: ReadonlySeatState,
  mic: SeatMicStats | undefined,
): MicCell {
  const off = (tip: string): MicCell => ({ state: "off", tip, db: null, peakDb: null });
  const v = recordingVerdict(st, seat);
  // why there is no reading to show (the seat is recorded now, or soon)
  let idleTip =
    "Not recording: no reading from this browser (disconnected, or the mic check has not opened the microphone yet)";
  if (!v.record)
    switch (v.reason) {
      case "audio_off":
        return off("This session does not record audio");
      case "unbound":
        return off("No client in this seat");
      case "not_participant":
        return off("Not recorded: fake player or agent");
      case "withdrawn":
        return off("Not recorded: the participant withdrew");
      case "consent_declined":
        return off("Not recorded: consent declined");
      case "no_audio_consent":
        return off("Not recorded: the participant did not permit audio recording (or was not asked)");
      case "mic_check_skipped":
        return {
          state: "skipped",
          tip: "Mic check skipped: this seat is not recorded",
          db: null,
          peakDb: null,
        };
      case "no_mic_check_step":
        return off("Not recorded: this session's onboarding has no mic check");
      case "game_complete":
        return off("Not recording: the game is complete");
      case "session_closed":
        return off("Not recording: the session is closed");
      case "session_aborted":
        return off("Not recording: the session was aborted");
      case "paused":
        return {
          state: "paused",
          tip: "Recording paused for everyone by the facilitator",
          db: null,
          peakDb: null,
        };
      case "consent_pending":
      case "not_started":
        idleTip = "Not recording yet: recording starts at the mic check, after consent";
        break;
      case "mic_check_held":
        idleTip = "Not recording yet: the mic checks wait until every seat has finished consent";
        break;
    }
  if (!mic || mic.state === "idle") return off(idleTip);
  const level = micHasLevel(mic.state);
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

/**
 * Mic check status of a seat, for the mic column during onboarding: null when the check does not
 * apply (no audio, unbound, withdrawn, fake player or agent, no audio consent, consent not given).
 */
export function micCheckStatus(st: ReadonlyGameState, seat: ReadonlySeatState): MicCheckStatus | null {
  if (!seat.bound || seat.withdrawn || seat.consent !== "given" || !micCheckApplies(st, seat)) return null;
  return seat.micCheck;
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

export function micsSummary(
  st: ReadonlyGameState,
  mics: Record<number, SeatMicStats | undefined>,
): MicsSummary {
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

export interface CalibrationSummary {
  tone: Extract<Tone, "neutral" | "live" | "warn">;
  icon: IconName;
  /** The NEXT panel's tag: the state with its detail (who reads now, the weak seats). */
  text: string;
  /** The calibration card's tag: the state in a word or two (the card says the rest). */
  label: string;
  tip: string;
}

/**
 * The calibration's state as a tag (NEXT panel and calibration card): not run yet, running (who
 * reads now), checking the audio, the separation verdict (weak seats with their margins), skipped.
 */
export function calibrationSummary(st: ReadonlyGameState): CalibrationSummary {
  const c = st.audio.calibration;
  switch (c.status) {
    case "running": {
      const turn = currentCalibrationTurn(st);
      return {
        tone: "live",
        icon: "voice",
        text: turn
          ? `running · seat ${turn.seat} reading (${c.order.indexOf(turn.seat) + 1}/${c.order.length})`
          : "running · starting",
        label: "calibrating",
        tip: "Each seat reads its sentence while the others stay quiet",
      };
    }
    case "done": {
      const q = c.quality;
      if (!q)
        return {
          tone: "warn",
          icon: "idle",
          text: "done · checking the audio",
          label: "checking…",
          tip: "The turns are over; the quick check waits for their audio",
        };
      const weak = q.perSeat.filter((p) => !p.ok);
      if (weak.length === 0)
        return {
          tone: "live",
          icon: "ok",
          text: "done · separation ok",
          label: "calibration ok",
          tip: "Every seat's own voice is clearly louder on its own microphone",
        };
      return {
        tone: "warn",
        icon: "microphoneWarning",
        text: `done · weak separation: ${weak
          .map((p) => `seat ${p.seat}${p.marginDb !== null ? ` (${fmtSigned(p.marginDb, "dB")})` : ""}`)
          .join(", ")}`,
        label: "needs attention",
        tip: "A seat's voice is nearly as loud on another microphone: check its headset is plugged in, chosen as microphone and worn close to the mouth, then redo",
      };
    }
    case "skipped":
      return {
        tone: "neutral",
        icon: "close",
        text: "skipped",
        label: "skipped",
        tip: "Skipped: attribution assumes a conservative leakage between the microphones (overlapping speech is missed more often)",
      };
    default:
      return {
        tone: "warn",
        icon: "idle",
        text: "not run yet",
        label: "not run yet",
        tip: "Each seat reads a sentence in turn, before round 1",
      };
  }
}

/** Plain advice for one seat of the calibration check (null when the seat passed). */
export function calibrationAdvice(r: SeatQuality): string | null {
  if (r.ok) return null;
  if (r.ownDb === null || r.marginDb === null)
    return `No audio from seat ${r.seat}: check its microphone and connection, then redo the calibration.`;
  if (r.marginDb < CALIBRATION_MIN_MARGIN_DB)
    return `Seat ${r.seat}: own voice only ${fmtSigned(r.marginDb, "dB")} over the others. Check the headset is plugged in, chosen as microphone and its mic sits at the corner of the mouth, then redo the calibration.`;
  return `Seat ${r.seat}: its voice is hard to tell apart from the others on the other microphones. Check the headset is plugged in, chosen as microphone and worn close to the mouth, then redo the calibration.`;
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

/** Stop reasons that mean audio may be missing, and how the wrap-up check names them (the catalogue's `wrapUpIssue`). */
const BROKEN_STOPS: Partial<Record<AudioStopReason, string>> = Object.fromEntries(
  AUDIO_STOP_REASONS.flatMap((r) => {
    const why = AUDIO_STOP_REASON_DEFS[r].wrapUpIssue;
    return why === null ? [] : [[r, why]];
  }),
);

/**
 * Before closing: is every real seat's audio on the server? Uses the live upload backlog, the seats'
 * connection and the stored tracks (null while not loaded yet). Interrupted tracks and missing
 * chunks are listed too.
 */
export function wrapUpAudioCheck(
  st: ReadonlyGameState,
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
    // the server forgets an offline seat's backlog and closes its track, but the browser still holds the audio
    const recorded = isRecordedSeat(recordingVerdict(st, s));
    if (recorded && !s.connected)
      lines.push({
        seat: s.seat,
        kind: "upload",
        text: `Seat ${s.seat} offline: audio it still holds arrives when it reconnects.`,
      });
    else if (pending > 0)
      lines.push({
        seat: s.seat,
        kind: "upload",
        text: `Seat ${s.seat} still uploading ${plural(pending, "chunk")}: keep that browser open.`,
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
        (t.stopReason ? BROKEN_STOPS[t.stopReason] : undefined) ??
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
        text: `Seat ${s.seat}: ${plural(gaps, "chunk")} missing from the stored audio.`,
      });
    if (tracks !== null && mine.length === 0 && recorded)
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
  tracks: Array<
    Span & { seat: number; trackId: string; reason: AudioStartReason; stopReason: AudioStopReason | null }
  >;
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
