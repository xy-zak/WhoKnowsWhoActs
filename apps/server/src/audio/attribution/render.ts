/**
 * Streaming renderers: a seat's audio on the common session timeline, raw or cleaned.
 *
 * `renderAligned` turns a seat's tracks into one continuous 16 kHz Int16 signal that starts at the
 * timeline's `t0` and has exactly 160 samples per timeline frame, so sample `m` is the sound at
 * `t0 + m / 16` ms on the server clock for every seat. Each output sample is read from the track
 * that covers it at the fractional position given by the track's alignment
 * (`(t − startTs − offsetMs) / msPerSample`), with 4-point Catmull–Rom interpolation; that
 * removes clock drift (fractional resampling) and the measured offsets in one step. Before, between
 * and after tracks, and in lost chunks, the output is digital silence.
 *
 * `renderClean` does the same and multiplies by a gain that is 1 on frames in the seat's speech
 * mask and `attenuationDb` (default −30 dB) elsewhere, with raised-cosine fades of `fadeMs`
 * (default 10 ms) placed *outside* the mask so attributed speech is never cut into. The raw
 * stored audio is never modified; clean tracks are new derivatives.
 *
 * Both are async generators of blocks (default 1 s); they read each track's PCM once, in order,
 * through `SequentialPcmReader`, and keep only about one chunk per track in memory, so an hour
 * per seat never has to be decrypted into memory at once. Each track's chunk stream is closed
 * (`return()`) as soon as the track is done, and on early exit. Where two tracks of a seat overlap
 * in time, the earlier one is played, as on the analysis timeline. `renderedSampleCount` gives the exact
 * output length up front for a WAV header / HTTP `Content-Length`.
 */

import { maskToRuns, runsToMask } from "./smooth";
import { SAMPLE_RATE, type SeatMask, type Timeline, type TrackAlignment } from "./types";

export interface PcmChunk {
  startSample: number;
  samples: Int16Array;
}

export interface TrackSource {
  trackId: string;
  /** Total samples of the track (from the chunk index); anything the chunks do not cover is silence. */
  samples: number;
  /** The track's PCM in increasing `startSample` order; gaps are silence, re-sent overlaps are ignored. */
  chunks: AsyncIterable<PcmChunk> | Iterable<PcmChunk>;
}

/** What the renderers need from an `AttributionResult`. */
export interface RenderTiming {
  timeline: Timeline;
  alignment: readonly TrackAlignment[];
}

export interface RenderOptions {
  /** Output block size in samples (default 16 000 = 1 s). */
  blockSamples?: number;
  /** Render only frames `[fromFrame, toFrame)` of the timeline (default: all). */
  fromFrame?: number;
  toFrame?: number;
}

export interface CleanOptions extends RenderOptions {
  attenuationDb?: number;
  fadeMs?: number;
}

const OUT_RATE = SAMPLE_RATE;

/** Serves monotonic range reads from an ordered chunk stream, holding only what is still needed. */
export class SequentialPcmReader {
  private readonly it: AsyncIterator<PcmChunk> | Iterator<PcmChunk>;
  private queue: PcmChunk[] = [];
  private end = 0;
  private done = false;

  constructor(chunks: AsyncIterable<PcmChunk> | Iterable<PcmChunk>) {
    this.it =
      Symbol.asyncIterator in chunks
        ? (chunks as AsyncIterable<PcmChunk>)[Symbol.asyncIterator]()
        : (chunks as Iterable<PcmChunk>)[Symbol.iterator]();
  }

  /** Samples `[start, start + count)`; zeros where the track has no data. Calls must not go backwards. */
  async read(start: number, count: number, out: Int16Array = new Int16Array(count)): Promise<Int16Array> {
    const stop = start + count;
    while (!this.done && this.end < stop) {
      const r = await this.it.next();
      if (r.done) {
        this.done = true;
        break;
      }
      let c = r.value;
      const cEnd = c.startSample + c.samples.length;
      if (cEnd <= this.end) continue; // duplicate
      if (c.startSample < this.end)
        c = { startSample: this.end, samples: c.samples.subarray(this.end - c.startSample) };
      this.queue.push(c);
      this.end = cEnd;
    }
    // Keep a few samples of history for the interpolator.
    while (this.queue.length && this.queue[0]!.startSample + this.queue[0]!.samples.length < start - 8) {
      this.queue.shift();
    }
    out.fill(0, 0, count);
    for (const c of this.queue) {
      const a = Math.max(start, c.startSample);
      const b = Math.min(stop, c.startSample + c.samples.length);
      if (b > a) out.set(c.samples.subarray(a - c.startSample, b - c.startSample), a - start);
      if (c.startSample >= stop) break;
    }
    return out;
  }

  /** Closes the underlying chunk stream (e.g. a decryption stream) when it was not read to the end. */
  async close(): Promise<void> {
    if (this.done) return;
    this.done = true;
    this.queue = [];
    await this.it.return?.();
  }
}

/** Number of samples `renderAligned` / `renderClean` will produce. */
export function renderedSampleCount(timeline: Timeline, options: RenderOptions = {}): number {
  const perFrame = Math.round((timeline.hopMs * OUT_RATE) / 1000);
  const from = Math.max(0, options.fromFrame ?? 0);
  const to = Math.min(timeline.frames, options.toFrame ?? timeline.frames);
  return Math.max(0, to - from) * perFrame;
}

interface TrackPlan {
  alignment: TrackAlignment;
  source: TrackSource;
  reader: SequentialPcmReader | null;
  start: number;
  end: number;
  /** Where this track starts supplying output (later than `start` if an earlier track overlaps it). */
  from: number;
}

/** A seat's audio on the session timeline, drift-corrected, silence where it has no data. */
export async function* renderAligned(
  seat: number,
  sources: readonly TrackSource[],
  timing: RenderTiming,
  options: RenderOptions = {},
): AsyncGenerator<Int16Array> {
  const { timeline } = timing;
  const perFrame = Math.round((timeline.hopMs * OUT_RATE) / 1000);
  const from = Math.max(0, options.fromFrame ?? 0) * perFrame;
  const total = renderedSampleCount(timeline, options);
  const block = Math.max(1, options.blockSamples ?? OUT_RATE);
  const msPerOut = 1000 / OUT_RATE;
  const plans: TrackPlan[] = [];
  for (const a of timing.alignment) {
    if (a.seat !== seat) continue;
    const source = sources.find((s) => s.trackId === a.trackId);
    if (!source) continue;
    const samples = Math.min(source.samples, a.samples || source.samples);
    plans.push({
      alignment: a,
      source,
      reader: null,
      start: a.startTs + a.offsetMs,
      end: a.startTs + a.offsetMs + samples * a.msPerSample,
      from: a.startTs + a.offsetMs,
    });
  }
  plans.sort((x, y) => x.start - y.start);
  // Where two tracks of the seat overlap in time, the earlier track keeps the overlap (as on the
  // analysis timeline), so the audio always matches the frames the mask was computed from.
  let coveredUntil = Number.NEGATIVE_INFINITY;
  for (const p of plans) {
    p.from = Math.max(p.start, coveredUntil);
    coveredUntil = Math.max(coveredUntil, p.end);
  }
  let scratch = new Int16Array(0);
  try {
    for (let m0 = from; m0 < from + total; m0 += block) {
      const len = Math.min(block, from + total - m0);
      const out = new Int16Array(len);
      const tA = timeline.t0 + m0 * msPerOut;
      const tB = timeline.t0 + (m0 + len) * msPerOut;
      for (const p of plans) {
        if (p.end <= tA || p.from >= tB || p.from >= p.end) continue;
        p.reader ??= new SequentialPcmReader(p.source.chunks);
        const a = p.alignment;
        const step = msPerOut / a.msPerSample;
        // First and last output samples this track supplies in the block.
        const iA = Math.max(0, Math.ceil((p.from - tA) / msPerOut));
        const iB = Math.min(len, Math.ceil((p.end - tA) / msPerOut));
        if (iB > iA) {
          const pos0 = (tA + iA * msPerOut - p.start) / a.msPerSample;
          const posLast = pos0 + (iB - 1 - iA) * step;
          // Track samples [base, hi) cover the interpolator's 4-point support; before sample 0 is silence.
          const base = Math.max(0, Math.floor(pos0) - 1);
          const hi = Math.floor(posLast) + 3;
          const count = Math.max(0, hi - base);
          if (scratch.length < count) scratch = new Int16Array(count);
          const buf = await p.reader.read(base, count, scratch);
          const get = (k: number) => (k < base || k - base >= count ? 0 : buf[k - base]!);
          for (let i = iA; i < iB; i++) {
            const pos = pos0 + (i - iA) * step;
            const k = Math.floor(pos);
            const t = pos - k;
            const xm1 = get(k - 1);
            const x0 = get(k);
            const x1 = get(k + 1);
            const x2 = get(k + 2);
            const y =
              x0 +
              0.5 * t * (x1 - xm1 + t * (2 * xm1 - 5 * x0 + 4 * x1 - x2 + t * (3 * (x0 - x1) + x2 - xm1)));
            const r = Math.round(y);
            out[i] = r > 32767 ? 32767 : Math.max(r, -32768);
          }
        }
        if (p.end <= tB) {
          // Done with this track: release its stream now rather than at the end.
          await p.reader.close();
          p.reader = null;
          p.from = p.end;
        }
      }
      yield out;
    }
  } finally {
    // Also runs when the consumer stops early (an aborted download, a truncating wavStream).
    for (const p of plans) await p.reader?.close();
  }
}

/** Per-sample gain for output samples `[m0, m0 + len)` from mask runs in samples. */
function fillGain(
  gain: Float32Array,
  m0: number,
  len: number,
  runs: readonly number[],
  runIndex: { i: number },
  fade: number,
  floor: number,
): void {
  gain.fill(floor, 0, len);
  const mEnd = m0 + len;
  // Skip runs that ended (with their fade) before this block.
  while (runIndex.i + 1 < runs.length && runs[runIndex.i + 1]! + fade <= m0) runIndex.i += 2;
  for (let r = runIndex.i; r + 1 < runs.length; r += 2) {
    const rs = runs[r]!;
    const re = runs[r + 1]!;
    if (rs - fade >= mEnd) break;
    const a = Math.max(m0, rs - fade);
    const b = Math.min(mEnd, re + fade);
    for (let m = a; m < b; m++) {
      let g: number;
      if (m >= rs && m < re) g = 1;
      else {
        const d = m < rs ? rs - m : m - re + 1;
        g = fade > 0 ? floor + (1 - floor) * 0.5 * (1 + Math.cos((Math.PI * d) / (fade + 1))) : floor;
      }
      if (g > gain[m - m0]!) gain[m - m0] = g;
    }
  }
}

/**
 * A seat's aligned audio with everything outside its speech mask attenuated (default −30 dB,
 * 10 ms raised-cosine fades outside the mask). `mask` is the seat's `SeatMask` from the result or a
 * frame-level 0/1 array on the same timeline.
 */
export async function* renderClean(
  seat: number,
  sources: readonly TrackSource[],
  timing: RenderTiming,
  mask: SeatMask | Uint8Array,
  options: CleanOptions = {},
): AsyncGenerator<Int16Array> {
  const { timeline } = timing;
  const perFrame = Math.round((timeline.hopMs * OUT_RATE) / 1000);
  const frameMask = mask instanceof Uint8Array ? mask : runsToMask(mask.runs, timeline.frames);
  const runs = maskToRuns(frameMask).map((f) => f * perFrame);
  const floor = 10 ** ((options.attenuationDb ?? -30) / 20);
  const fade = Math.max(0, Math.round(((options.fadeMs ?? 10) * OUT_RATE) / 1000));
  const runIndex = { i: 0 };
  let m0 = Math.max(0, options.fromFrame ?? 0) * perFrame;
  let gain = new Float32Array(0);
  for await (const block of renderAligned(seat, sources, timing, options)) {
    if (gain.length < block.length) gain = new Float32Array(block.length);
    fillGain(gain, m0, block.length, runs, runIndex, fade, floor);
    for (let i = 0; i < block.length; i++) block[i] = Math.round(block[i]! * gain[i]!);
    m0 += block.length;
    yield block;
  }
}
