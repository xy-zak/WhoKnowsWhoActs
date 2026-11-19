import type {
  AttributionGrade,
  AttributionJobView,
  AttributionSummaryView,
  AudioDeletionScope,
  AudioExportRequestKind,
  AudioSessionView,
  SeatAudioSummary,
  SpeechSegmentRow,
  SpeechSegmentsView,
} from "@wkwa/shared";
import { fmtDuration } from "../../common/format";

/*
 * Pure helpers of the DATABASE tab's audio views: the REST response shapes
 * (the shared schemas plus the extra fields the server adds), formatting, the
 * explanations of the deletion scopes, and the state machine that follows an
 * attribution job while it is polled. No React, no I/O: unit-tested.
 */

/* ─────────────────────────── REST response shapes ─────────────────────────── */

/* The server's views, from packages/shared/src/audio.ts (under the names this tab uses). */
export type {
  AttributionGrade,
  AttributionJobView,
  AttributionSummaryView,
  AudioDeleteResult,
  AudioExportEntry,
  AudioExportFile,
  AudioExportResult,
  AudioSessionView,
} from "@wkwa/shared";
/** Per-seat totals of GET /api/sessions/:id/audio. */
export type SeatAudio = SeatAudioSummary;
export type SpeechSegment = SpeechSegmentRow;
/** GET /api/sessions/:id/audio/segments */
export type SegmentsView = SpeechSegmentsView;
/** What "Export audio" asks for: raw, clean or both. */
export type AudioExportKind = AudioExportRequestKind;
/** What "Delete audio" deletes: raw (and cleaned) audio, or all of it. */
export type AudioDeleteScope = AudioDeletionScope;

/* ─────────────────────────── Formatting ─────────────────────────── */

const ok = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n);

/** `m:ss`, or `h:mm:ss` from one hour; "—" when unknown. Rounded to the second. */
export function formatDuration(ms: number | null | undefined): string {
  if (!ok(ms) || ms < 0) return "—";
  return fmtDuration(ms);
}

/** A wall-clock ISO time as "YYYY-MM-DD HH:MM" (as the DATABASE tables show it). */
export function whenWall(w: string): string {
  return w.replace("T", " ").slice(0, 16);
}

/** Minutes with one decimal, e.g. "12.5 min" (for confirmations). */
export function formatMinutes(ms: number | null | undefined): string {
  if (!ok(ms) || ms < 0) return "—";
  return `${(ms / 60_000).toFixed(1)} min`;
}

/** File size in B / KB / MB / GB (1 KB = 1024 B). */
export function formatBytes(n: number | null | undefined): string {
  if (!ok(n) || n < 0) return "—";
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** First 12 hex digits of a SHA-256 and an ellipsis (the full hash is in the manifest). */
export function shortSha(sha: string): string {
  return sha.length > 12 ? `${sha.slice(0, 12)}…` : sha;
}

/** Share 0–1 as "25 %"; "—" when unknown. */
export function formatShare(x: number | null | undefined): string {
  return ok(x) ? `${Math.round(x * 100)} %` : "—";
}

/** Signed number with a unit, e.g. "+12.3 dB", "−4 ppm"; "—" when null. */
export function formatSigned(x: number | null | undefined, unit: string, digits = 1): string {
  if (!ok(x)) return "—";
  const v = x.toFixed(digits);
  const n = Number(v);
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(digits)} ${unit}`;
}

/** "1 track", "3 tracks" (regular English plurals only). */
export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** The sessions list's audio cell: "4 tr · 3:12", or "—" when nothing is stored. */
export function audioCell(tracks: number | undefined, ms: number | undefined): string {
  if (!tracks) return "—";
  return `${tracks} tr · ${formatDuration(ms ?? 0)}`;
}

/* ─────────────────────────── Attribution result ─────────────────────────── */

export const GRADE_TONE: Record<AttributionGrade, "live" | "warn"> = {
  good: "live",
  fair: "warn",
  poor: "warn",
};

export interface TalkBar {
  seat: number;
  ms: number;
  /** Share of all attributed talk time (0–1). */
  share: number;
  /** Filled cells, relative to the seat that talked most. */
  filled: number;
  width: number;
}

/** Per-seat talk time as a text bar list (`▰▰▰▱▱`), sorted by seat; the longest gets a full bar. */
export function talkBars(talkTimeMs: Record<string, number>, width = 20): TalkBar[] {
  const rows = Object.entries(talkTimeMs)
    .map(([k, ms]) => ({ seat: Number(k), ms: Math.max(0, ms) }))
    .filter((r) => Number.isInteger(r.seat))
    .sort((a, b) => a.seat - b.seat);
  const total = rows.reduce((n, r) => n + r.ms, 0);
  const max = Math.max(0, ...rows.map((r) => r.ms));
  return rows.map((r) => ({
    ...r,
    share: total > 0 ? r.ms / total : 0,
    filled: max > 0 ? Math.round((r.ms / max) * width) : 0,
    width,
  }));
}

/* ─────────────────────────── Speech timeline ─────────────────────────── */

export interface TimelineBar {
  /** Left edge and width as a percentage of the session span. */
  left: number;
  width: number;
  overlap: boolean;
  segment: SpeechSegment;
}

/**
 * Lay the speech segments out per seat on [t0, t1]: percentages, clamped to
 * the span, with a minimum visible width so a short turn still shows.
 */
export function timelineBars(
  segments: readonly SpeechSegment[],
  t0: number,
  t1: number,
  minWidth = 0.15,
): Map<number, TimelineBar[]> {
  const out = new Map<number, TimelineBar[]>();
  const span = t1 - t0;
  if (!(span > 0)) return out;
  for (const s of segments) {
    const a = Math.max(t0, Math.min(t1, s.startTs));
    const b = Math.max(t0, Math.min(t1, s.endTs));
    if (b < a) continue;
    const left = ((a - t0) / span) * 100;
    const width = Math.min(100 - left, Math.max(minWidth, ((b - a) / span) * 100));
    const list = out.get(s.seat) ?? [];
    list.push({ left, width, overlap: s.overlap, segment: s });
    out.set(s.seat, list);
  }
  return out;
}

/** The span the timeline covers: the seats' first to last audio, else the segments'. */
export function timelineSpan(
  seats: readonly SeatAudio[],
  segments: readonly SpeechSegment[],
): { t0: number; t1: number } | null {
  const starts = [
    ...seats.map((s) => s.firstServerTs).filter(ok),
    ...segments.map((s) => s.startTs).filter(ok),
  ];
  const ends = [...seats.map((s) => s.lastServerTs).filter(ok), ...segments.map((s) => s.endTs).filter(ok)];
  if (!starts.length || !ends.length) return null;
  const t0 = Math.min(...starts);
  const t1 = Math.max(...ends);
  return t1 > t0 ? { t0, t1 } : null;
}

/* ─────────────────────────── Deletion scopes ─────────────────────────── */

export interface ScopeExplanation {
  label: string;
  removes: string;
  keeps: string;
}

/** What each "delete audio" scope removes and keeps (matches the server's deleteSessionAudio). */
export const DELETE_SCOPES: Record<AudioDeleteScope, ScopeExplanation> = {
  raw: {
    label: "Raw audio, keep derived",
    removes: "every seat's recorded microphone audio and the cleaned tracks (their encrypted files and keys)",
    keeps:
      "the speech segments (who spoke when), talk time, the quality report and the track metadata (times, lengths, levels), so speaking-time analysis still works",
  },
  all: {
    label: "All audio",
    removes:
      "every audio row and file of the session: recordings, cleaned tracks, speech segments, talk time, quality report, track and chunk metadata, jobs and the session's audio folder",
    keeps: "only the register entry of this deletion",
  },
};

/** Said with every deletion: exported WAVs are copies outside the encrypted store. */
export const EXPORTS_NOT_DELETED =
  "Audio exports already written to the exports folder are not deleted: delete those folders by hand (and any copies elsewhere).";

export function scopeSentence(scope: AudioDeleteScope): string {
  const s = DELETE_SCOPES[scope];
  return `Deletes ${s.removes}. Keeps ${s.keeps}.`;
}

/* ─────────────────────────── Availability of the actions ─────────────────────────── */

export function hasRawAudio(view: AudioSessionView): boolean {
  return view.seats.some((s) => !s.rawDeleted && s.durationMs > 0);
}

/** Like the server: the attribution needs every track's raw audio (none deleted). */
export function rawComplete(view: AudioSessionView): boolean {
  return hasRawAudio(view) && !view.tracks.some((t) => t.status === "deleted");
}

export function hasCleanTrack(view: AudioSessionView, seat?: number): boolean {
  return view.derivatives.some((d) => d.kind === "clean" && (seat === undefined || d.seat === seat));
}

/** Why the attribution cannot start now, or null. */
export function attributionBlock(view: AudioSessionView, job: JobState): string | null {
  if (view.running) return "The session is still running: run the attribution once it has ended.";
  if (isJobBusy(job)) return "An attribution of this session is queued or running.";
  if (view.seats.length === 0) return "This session has no audio.";
  if (!rawComplete(view)) return "The raw audio was deleted: the attribution can no longer run.";
  return null;
}

/** Why this export cannot be written now, or null. */
export function exportBlock(
  view: AudioSessionView,
  job: JobState,
  kind: AudioExportKind,
  seat: number | "all",
): string | null {
  if (view.running) return "The session is still running: export once it has ended.";
  if (isJobBusy(job)) return "An attribution of this session is queued or running: export when it ends.";
  // same rules as the server: every chosen seat needs what is asked for
  const seats = seat === "all" ? view.seats : view.seats.filter((s) => s.seat === seat);
  if (seats.length === 0) return seat === "all" ? "This session has no audio." : `Seat ${seat} has no audio.`;
  const noRaw = seats.find((s) => s.rawDeleted || s.durationMs <= 0);
  if (kind !== "clean" && noRaw)
    return `The raw audio of seat ${noRaw.seat} was deleted (or holds no audio).`;
  const noClean = seats.find((s) => !hasCleanTrack(view, s.seat));
  if (kind !== "raw" && noClean)
    return `Seat ${noClean.seat} has no cleaned track: run the speaker attribution first.`;
  return null;
}

/** Why the audio cannot be deleted now, or null. */
export function deleteBlock(view: AudioSessionView, job: JobState): string | null {
  if (view.running) return "The session is still running: delete its audio once it has ended.";
  if (isJobBusy(job)) return "An attribution of this session is queued or running: wait until it ends.";
  if (view.tracks.length === 0 && view.derivatives.length === 0 && view.seats.length === 0)
    return "This session has no audio.";
  return null;
}

/* ─────────────────────────── Attribution job state machine ─────────────────────────── */

/** How often a queued or running job is polled (ms). */
export const JOB_POLL_MS = 750;
/** Failed polls in a row before the view gives up following the job (a brief network error is retried). */
export const JOB_POLL_MAX_ERRORS = 5;

export type JobState =
  | { phase: "idle" }
  /** POST sent, no job id yet. */
  | { phase: "starting" }
  /**
   * Queued or running; `polls` changes on every update so the next poll is scheduled;
   * `errors` counts failed polls in a row.
   */
  | {
      phase: "active";
      jobId: string;
      status: "queued" | "running";
      progress: number;
      polls: number;
      errors: number;
    }
  | { phase: "done"; jobId: string; summary: AttributionSummaryView | null }
  | { phase: "failed"; jobId: string | null; error: string };

export type JobAction =
  | { type: "start" }
  | { type: "job"; job: Pick<AttributionJobView, "jobId" | "status" | "progress" | "error" | "summary"> }
  | { type: "error"; error: string }
  | { type: "reset" };

export const JOB_IDLE: JobState = { phase: "idle" };

export function isJobBusy(s: JobState): boolean {
  return s.phase === "starting" || s.phase === "active";
}

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

export function jobReducer(s: JobState, a: JobAction): JobState {
  switch (a.type) {
    case "start":
      // never start twice
      return isJobBusy(s) ? s : { phase: "starting" };
    case "reset":
      return isJobBusy(s) ? s : JOB_IDLE;
    case "error":
      if (s.phase === "starting") return { phase: "failed", jobId: null, error: a.error };
      if (s.phase === "active") {
        // a failed poll is retried; only several in a row give up (the job may still be running)
        if (s.errors + 1 < JOB_POLL_MAX_ERRORS) return { ...s, polls: s.polls + 1, errors: s.errors + 1 };
        return {
          phase: "failed",
          jobId: s.jobId,
          error: `${a.error} (lost track of the job: reopen the audio view to see whether it finished)`,
        };
      }
      return s;
    case "job": {
      const j = a.job;
      // a late answer about another job, or about a job that already ended, changes nothing
      if (s.phase === "active" && s.jobId !== j.jobId) return s;
      if ((s.phase === "done" || s.phase === "failed") && s.jobId === j.jobId) return s;
      if (j.status === "done") return { phase: "done", jobId: j.jobId, summary: j.summary ?? null };
      if (j.status === "failed")
        return { phase: "failed", jobId: j.jobId, error: j.error || "The attribution failed." };
      const prev = s.phase === "active" ? s.progress : 0;
      return {
        phase: "active",
        jobId: j.jobId,
        status: j.status,
        progress: Math.max(prev, clamp01(j.progress)),
        polls: s.phase === "active" ? s.polls + 1 : 0,
        errors: 0,
      };
    }
  }
}

/** The job to follow when the audio view opens: the newest one, if it is still queued or running. */
export function initialJobState(view: Pick<AudioSessionView, "jobs">): JobState {
  const j = view.jobs[0];
  if (!j || (j.status !== "queued" && j.status !== "running")) return JOB_IDLE;
  return jobReducer(JOB_IDLE, { type: "job", job: j });
}

/** "▰▰▰▱▱▱▱▱▱▱ 30 %" parts for a job's progress. */
export function progressCells(progress: number, width = 10): { on: number; off: number; pct: number } {
  const p = clamp01(progress);
  const on = Math.round(p * width);
  return { on, off: width - on, pct: Math.round(p * 100) };
}
