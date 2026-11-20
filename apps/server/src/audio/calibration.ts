import { AUDIO_SAMPLE_RATE, clampDb, int16FromLeBytes, type PayloadOf, samplesToMs } from "@wkwa/shared";
import {
  type CalibrationReport,
  type CalibrationTurn,
  type ChunkMeta,
  FeatureBuilder,
  quickCalibrationCheck,
  type TrackInput,
} from "./attribution";

/** Audio before the first turn and after the last one that the check keeps (ms): room noise for the floors. */
export const CALIBRATION_MARGIN_MS = 1000;

interface CollectedChunk {
  meta: ChunkMeta;
  samples: Int16Array;
}

/**
 * Keeps, in memory and only while one calibration run is open, the audio chunks captured from just
 * before its first turn on, so the quick leakage check can run the moment the last chunks are in
 * (on the window of the turns as they were actually timed). About 4 seats × 35 s × 32 kB/s ≈ 4.5 MB at most; dropped
 * as soon as the check ran or the run ended. Nothing is written anywhere: the chunks are stored by
 * the normal ingest path as well.
 */
export class CalibrationCollector {
  private readonly tracks = new Map<string, { seat: number; chunks: CollectedChunk[] }>();

  constructor(
    /** The calibration run this collector belongs to (`state.audio.calibrationRuns`). */
    readonly run: number,
    readonly seats: readonly number[],
    readonly fromTs: number,
  ) {}

  /** Add a stored chunk if it is a calibrating seat's and overlaps the window. `pcm` is s16le. */
  add(seat: number, trackId: string, meta: ChunkMeta, pcm: Uint8Array) {
    if (!this.seats.includes(seat)) return;
    if (meta.clientTs + samplesToMs(meta.sampleCount) <= this.fromTs) return;
    let entry = this.tracks.get(trackId);
    if (!entry) {
      entry = { seat, chunks: [] };
      this.tracks.set(trackId, entry);
    }
    if (entry.chunks.some((c) => c.meta.seq === meta.seq)) return;
    // a copy: the chunk's buffer is not ours to keep
    entry.chunks.push({ meta, samples: int16FromLeBytes(pcm).slice(0, meta.sampleCount) });
  }

  /** Latest capture time (server clock) up to which a seat's audio has arrived; -Infinity = none. */
  coveredUntil(seat: number): number {
    let until = Number.NEGATIVE_INFINITY;
    for (const t of this.tracks.values()) {
      if (t.seat !== seat) continue;
      for (const c of t.chunks) until = Math.max(until, c.meta.clientTs + samplesToMs(c.meta.sampleCount));
    }
    return until;
  }

  /** Has every calibrating seat's audio arrived up to `ts`? */
  complete(ts: number): boolean {
    return this.seats.every((s) => this.coveredUntil(s) >= ts);
  }

  /** The collected audio as attribution inputs: one track per capture run, re-based to its first collected chunk. */
  trackInputs(): TrackInput[] {
    const out: TrackInput[] = [];
    for (const [trackId, t] of this.tracks) {
      const chunks = [...t.chunks].sort((a, b) => a.meta.startSample - b.meta.startSample);
      const base = chunks[0]?.meta.startSample ?? 0;
      const builder = new FeatureBuilder(); // levels only: no speech model on the live path
      for (const c of chunks) builder.push(c.samples, c.meta.startSample - base);
      out.push({
        trackId,
        seat: t.seat,
        sampleRate: AUDIO_SAMPLE_RATE,
        chunks: chunks.map((c) => ({ ...c.meta, startSample: c.meta.startSample - base })),
        features: builder.finish(),
      });
    }
    return out;
  }

  /** Run the quick leakage check on the collected audio, over the turns' window plus a margin (milliseconds). */
  check(turns: readonly CalibrationTurn[]): CalibrationReport {
    const toTs = Math.max(this.fromTs, ...turns.map((t) => t.endTs)) + CALIBRATION_MARGIN_MS;
    return quickCalibrationCheck(this.trackInputs(), turns, { fromTs: this.fromTs, toTs });
  }
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const db = (v: number | null) => (v === null || !Number.isFinite(v) ? null : round1(clampDb(v)));

/**
 * The CalibrationChecked payload from a quick check: one row per seat in turn order. A seat the
 * check has no figures for (no audio at all) is not ok. `marginDb` is ownDb − bestOtherDb, as the
 * event documents it; `ok` is the engine's verdict, which uses the gain-invariant margin.
 */
export function calibrationCheckedPayload(
  report: CalibrationReport,
  order: readonly number[],
): PayloadOf<"CalibrationChecked"> {
  const perSeat = order.map((seat) => {
    const q = report.seats.find((r) => r.seat === seat);
    if (!q) return { seat, ownDb: null, bestOtherDb: null, marginDb: null, ok: false };
    const ownDb = db(q.ownDb);
    const bestOtherDb = db(q.bestOtherDb);
    return {
      seat,
      ownDb,
      bestOtherDb,
      marginDb: ownDb !== null && bestOtherDb !== null ? round1(ownDb - bestOtherDb) : null,
      ok: q.ok,
    };
  });
  return { perSeat, ok: report.ok && perSeat.every((s) => s.ok) };
}
