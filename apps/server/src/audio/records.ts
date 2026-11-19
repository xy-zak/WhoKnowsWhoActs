/**
 * Read-side views of a session's stored audio for REST and the CSV exports.
 *
 * Everything here works on database rows only: no file keys, no file names,
 * no audio content. The DB keeps a track's lifecycle as `recording | closed |
 * deleted`; the REST contract (`AudioTrackSummary`, packages/shared/src/audio.ts)
 * shows `open | closed | interrupted | deleted`.
 */
import { statSync } from "node:fs";
import {
  AUDIO_STOP_REASONS,
  type AudioDerivativeSummary,
  type AudioStopReason,
  type AudioTrackSummary,
} from "@wkwa/shared";
import type { AudioChunkRow, AudioDerivativeRow, AudioTrackRow, Store } from "../db/store";

/** Derivative kinds one attribution run produces (replaced together when it is re-run). */
export const ATTRIBUTION_DERIVATIVE_KINDS = [
  "speech_segments",
  "talk_time",
  "quality_report",
  "leakage_matrix",
  "clean",
] as const;
export type AttributionDerivativeKind = (typeof ATTRIBUTION_DERIVATIVE_KINDS)[number];

/**
 * Stop reasons after which a track did not end cleanly: the browser or its microphone went away, or
 * the track was still open when the session was loaded again (`interrupted`, e.g. after a restart).
 */
const INTERRUPTED_STOP_REASONS: ReadonlySet<string> = new Set([
  "disconnect",
  "interrupted",
  "permission_lost",
  "error",
]);
const KNOWN_STOP_REASONS: ReadonlySet<string> = new Set(AUDIO_STOP_REASONS);

/** DB status + stop reason → the REST status. Unknown stop reasons count as interrupted too. */
export function trackStatusOf(t: Pick<AudioTrackRow, "status" | "stopReason">): AudioTrackSummary["status"] {
  if (t.status === "deleted") return "deleted";
  if (t.status === "recording") return "open";
  if (t.stopReason !== null && !KNOWN_STOP_REASONS.has(t.stopReason)) return "interrupted";
  return t.stopReason !== null && INTERRUPTED_STOP_REASONS.has(t.stopReason) ? "interrupted" : "closed";
}

function stopReasonOf(reason: string | null): AudioStopReason | null {
  return reason !== null && KNOWN_STOP_REASONS.has(reason) ? (reason as AudioStopReason) : null;
}

/**
 * Missing chunks of a track: sequence numbers never received below the highest
 * one, plus places where consecutive chunks do not join up sample-for-sample.
 * Chunks the browser reported as dropped count when they exceed that (they may
 * have been the last ones).
 */
export function trackGaps(chunks: readonly AudioChunkRow[], droppedChunks: number): number {
  if (chunks.length === 0) return droppedChunks;
  let missing = 0;
  let breaks = 0;
  let prev: AudioChunkRow | null = null;
  for (const c of chunks) {
    if (prev) {
      if (c.seq > prev.seq + 1) missing += c.seq - prev.seq - 1;
      else if (c.startSample !== prev.startSample + prev.sampleCount) breaks++;
    } else missing += c.seq;
    prev = c;
  }
  return Math.max(missing + breaks, droppedChunks);
}

/** Size of a stored encrypted file, or 0 when it is gone. */
export function fileBytes(store: Store, sessionId: string, fileName: string | null): number {
  if (!fileName || !store.audioFiles) return 0;
  try {
    return statSync(store.audioFiles.pathOf(sessionId, fileName)).size;
  } catch {
    return 0;
  }
}

export interface TrackView {
  row: AudioTrackRow;
  chunks: AudioChunkRow[];
  summary: AudioTrackSummary;
  /** Server time just after the track's last sample (from its last chunk's client timestamp). */
  endTs: number;
}

export function trackViews(store: Store, sessionId: string): TrackView[] {
  return store
    .listAudioTracks(sessionId)
    .sort((a, b) => a.startedServerTs - b.startedServerTs || a.seat - b.seat)
    .map((row) => {
      const chunks = store.listAudioChunks(row.trackId);
      const last = chunks[chunks.length - 1];
      const rate = row.sampleRate > 0 ? row.sampleRate : 16_000;
      const endTs = last ? last.clientTs + (last.sampleCount * 1000) / rate : row.startedServerTs;
      return {
        row,
        chunks,
        endTs,
        summary: {
          trackId: row.trackId,
          seat: row.seat,
          startedServerTs: row.startedServerTs,
          closedServerTs: row.closedServerTs,
          stopReason: stopReasonOf(row.stopReason),
          samples: row.samples,
          durationMs: row.durationMs,
          chunks: row.chunks,
          gaps: trackGaps(chunks, row.droppedChunks),
          bytes: row.status === "deleted" ? 0 : fileBytes(store, sessionId, row.fileName),
          status: trackStatusOf(row),
        },
      };
    });
}

/** Per-seat totals for the DATABASE tab. */
export interface SeatAudioSummary {
  seat: number;
  tracks: number;
  /** Audio stored (sum of the tracks' durations, ms). */
  durationMs: number;
  /** Missing chunks inside tracks. */
  gaps: number;
  /** Breaks between consecutive tracks (a pause, a reload, a reconnect). */
  trackBreaks: number;
  /** First sample to last sample (ms), and the part of it without audio. */
  spanMs: number;
  missingMs: number;
  firstServerTs: number | null;
  lastServerTs: number | null;
  /** True once the seat's raw audio was deleted (metadata kept). */
  rawDeleted: boolean;
}

export function seatSummaries(views: readonly TrackView[]): SeatAudioSummary[] {
  const bySeat = new Map<number, TrackView[]>();
  for (const v of views) bySeat.set(v.row.seat, [...(bySeat.get(v.row.seat) ?? []), v]);
  return [...bySeat.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([seat, list]) => {
      const first = Math.min(...list.map((v) => v.chunks[0]?.clientTs ?? v.row.startedClientTs));
      const last = Math.max(...list.map((v) => v.endTs));
      const durationMs = list.reduce((n, v) => n + v.row.durationMs, 0);
      const spanMs = Math.max(0, Math.round(last - first));
      return {
        seat,
        tracks: list.length,
        durationMs,
        gaps: list.reduce((n, v) => n + v.summary.gaps, 0),
        trackBreaks: list.length - 1,
        spanMs,
        missingMs: Math.max(0, spanMs - durationMs),
        firstServerTs: Number.isFinite(first) ? first : null,
        lastServerTs: Number.isFinite(last) ? last : null,
        rawDeleted: list.every((v) => v.row.status === "deleted"),
      };
    });
}

/** What a clean derivative's params hold besides the engine options. */
export interface CleanParams {
  jobId: string;
  samples: number;
  sampleRate: number;
  timelineT0: number;
  attenuationDb: number;
  fadeMs: number;
  [k: string]: unknown;
}

export function derivativeSummary(store: Store, d: AudioDerivativeRow): AudioDerivativeSummary {
  const p = d.params as Partial<CleanParams>;
  const samples = typeof p.samples === "number" ? p.samples : 0;
  return {
    derivativeId: d.derivativeId,
    seat: d.seat ?? 0,
    kind: "clean",
    sourceTrackIds: d.sourceTracks,
    jobId: typeof p.jobId === "string" ? p.jobId : null,
    engineVersion: d.engineVersion,
    params: d.params,
    createdServerTs: d.createdServerTs,
    samples,
    durationMs: Math.round((samples * 1000) / (p.sampleRate ?? 16_000)),
    bytes: fileBytes(store, d.sessionId, d.fileName),
  };
}

/** One row of speech_segments (stored per seat in the `speech_segments` derivative, and in the CSV). */
export interface SpeechSegmentRow {
  seat: number;
  startTs: number;
  endTs: number;
  durationMs: number;
  round: number | null;
  phase: string | null;
  paused: boolean;
  recordingPaused: boolean;
  meanDb: number;
  confidence: number;
  overlap: boolean;
  overlapMs: number;
  overlapWith: number[];
}

/** The stored speech segments of a session, every seat, in time order (with the derivative that holds them). */
export function speechSegmentsOf(
  store: Store,
  sessionId: string,
): { segments: Array<SpeechSegmentRow & { participantCode: string | null; engineVersion: string }> } {
  const out: Array<SpeechSegmentRow & { participantCode: string | null; engineVersion: string }> = [];
  const list = store.listAudioDerivatives(sessionId, { kind: "speech_segments" });
  // a seat whose segments were erased is not named in the others' overlaps either (it would show when they spoke)
  const present = new Set(list.map((d) => d.seat));
  for (const d of list) {
    const full = store.getAudioDerivative(d.derivativeId);
    const data = full?.data as { segments?: SpeechSegmentRow[] } | null;
    for (const s of data?.segments ?? [])
      out.push({
        ...s,
        overlapWith: s.overlapWith.filter((x) => present.has(x)),
        participantCode: d.participantCode,
        engineVersion: d.engineVersion,
      });
  }
  out.sort((a, b) => a.startTs - b.startTs || a.seat - b.seat);
  return { segments: out };
}
