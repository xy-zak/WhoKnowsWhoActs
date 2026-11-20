/**
 * Read-side views of a session's stored audio for REST and the CSV exports.
 *
 * Everything here works on database rows only: no file keys, no file names,
 * no audio content. The DB keeps a track's lifecycle as `recording | closed |
 * deleted`; the REST contract (`AudioTrackSummary`, packages/shared/src/audio.ts)
 * shows `open | closed | interrupted | deleted`.
 */
import { statSync } from "node:fs";
import { stat } from "node:fs/promises";
import {
  AUDIO_SAMPLE_RATE,
  type AudioDerivativeKind,
  type AudioDerivativeSummary,
  type AudioStopReason,
  type AudioTrackSummary,
  audioTrackEnding,
  isAudioStopReason,
  type SeatAudioSummary,
  type SpeechSegmentRow,
} from "@wkwa/shared";
import type { AudioChunkRow, AudioDerivativeRow, AudioTrackRow, Store } from "../db/store";

/**
 * What each derivative kind holds. `sound`: voice audio, so it goes with "delete raw audio" (a kind
 * not listed here counts as sound: a kind added later errs on the side of deleting voice).
 * `attribution`: an attribution run writes it, and a re-run replaces the previous run's.
 */
export const DERIVATIVE_KINDS = {
  speech_segments: { sound: false, attribution: true },
  talk_time: { sound: false, attribution: true },
  quality_report: { sound: false, attribution: true },
  leakage_matrix: { sound: false, attribution: true },
  clean: { sound: true, attribution: true },
  /** Not produced yet: transcripts are text (personal data, but not voice recordings). */
  transcript: { sound: false, attribution: false },
} as const satisfies Record<AudioDerivativeKind | "transcript", { sound: boolean; attribution: boolean }>;

/** Derivative kinds one attribution run produces (replaced together when it is re-run). */
export const ATTRIBUTION_DERIVATIVE_KINDS = (
  Object.keys(DERIVATIVE_KINDS) as Array<keyof typeof DERIVATIVE_KINDS>
).filter((k): k is AudioDerivativeKind => DERIVATIVE_KINDS[k].attribution);

/** Does a derivative of this kind hold sound (and so go with the raw audio)? Unknown kinds do. */
export function isAudioDerivativeKind(kind: string): boolean {
  return (DERIVATIVE_KINDS as Record<string, { sound: boolean } | undefined>)[kind]?.sound ?? true;
}

/** DB status + stop reason → the REST status (`audioTrackEnding`: unknown stop reasons count as interrupted). */
export function trackStatusOf(t: Pick<AudioTrackRow, "status" | "stopReason">): AudioTrackSummary["status"] {
  if (t.status === "deleted") return "deleted";
  if (t.status === "recording") return "open";
  return audioTrackEnding(t.stopReason) === "interrupted" ? "interrupted" : "closed";
}

function stopReasonOf(reason: string | null): AudioStopReason | null {
  return reason !== null && isAudioStopReason(reason) ? reason : null;
}

/**
 * Missing chunks of a track: sequence numbers never received below the highest
 * one, plus places where consecutive chunks do not join up sample-for-sample.
 * Chunks the browser reported as dropped count when they exceed that (they may
 * have been the last ones).
 */
function trackGaps(chunks: readonly AudioChunkRow[], droppedChunks: number): number {
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

/** fileBytes without blocking the event loop (for REST). */
async function fileBytesAsync(store: Store, sessionId: string, fileName: string | null): Promise<number> {
  if (!fileName || !store.audioFiles) return 0;
  try {
    return (await stat(store.audioFiles.pathOf(sessionId, fileName))).size;
  } catch {
    return 0;
  }
}

export interface TrackView {
  row: AudioTrackRow;
  chunks: AudioChunkRow[];
  /** The REST summary without the size on disk (trackSummaries adds it). */
  summary: Omit<AudioTrackSummary, "bytes">;
  /** Server time just after the track's last sample (from its last chunk's client timestamp). */
  endTs: number;
}

/** A session's tracks in start order with their chunk index (database rows only: no file is read). */
export function trackViews(store: Store, sessionId: string): TrackView[] {
  return store
    .listAudioTracks(sessionId)
    .sort((a, b) => a.startedServerTs - b.startedServerTs || a.seat - b.seat)
    .map((row) => {
      const chunks = store.listAudioChunks(row.trackId);
      const last = chunks[chunks.length - 1];
      const rate = row.sampleRate > 0 ? row.sampleRate : AUDIO_SAMPLE_RATE;
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
          status: trackStatusOf(row),
        },
      };
    });
}

/** The REST summaries of `views`, with the size of each file on disk (stat calls run in parallel). */
export function trackSummaries(store: Store, views: readonly TrackView[]): Promise<AudioTrackSummary[]> {
  return Promise.all(
    views.map(async ({ row, summary }) => ({
      ...summary,
      bytes: row.status === "deleted" ? 0 : await fileBytesAsync(store, row.sessionId, row.fileName),
    })),
  );
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

export async function derivativeSummary(
  store: Store,
  d: AudioDerivativeRow,
): Promise<AudioDerivativeSummary> {
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
    durationMs: Math.round((samples * 1000) / (p.sampleRate ?? AUDIO_SAMPLE_RATE)),
    bytes: await fileBytesAsync(store, d.sessionId, d.fileName),
  };
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
