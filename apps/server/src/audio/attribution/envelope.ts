/**
 * Streaming energy envelopes: the only place the engine looks at raw PCM during analysis.
 *
 * `EnvelopeBuilder` is fed a track's Int16 blocks in any block size (one 5 s chunk at a time is
 * typical) and keeps only per-5 ms partial sums, so an hour of one seat (≈ 115 MB of PCM) becomes
 * ≈ 3 MB of envelope. Per 10 ms frame it reports:
 *
 * - `energyDb`: mean-square energy over a **20 ms window centred on the 10 ms hop**, after a
 *   2nd-order 100 Hz Butterworth high-pass that removes DC offset, handling noise and rumble
 *   (cheap mics often have a large DC offset that would otherwise dominate quiet frames);
 * - `peakDb`: the largest raw sample magnitude in the hop;
 * - `clipped`: 1 when a raw sample in the hop reached full scale (|x| ≥ 32 700).
 *
 * Samples are placed by `startSample`, so a lost chunk leaves `NaN` ("no data") frames instead of
 * shifting the rest of the track; a chunk that arrives late fills its gap, and re-sent duplicates
 * are ignored. The filter is re-initialised
 * to its steady state after a gap, so a gap produces no step transient.
 */

import { powToDb } from "./math";
import { type Envelope, SAMPLE_RATE, SILENCE_DB } from "./types";

const FULL_SCALE_POW = 32768 * 32768;
const DEFAULT_CLIP_LEVEL = 32_700;

export interface EnvelopeOptions {
  /** Nominal sample rate (default 16 000); the hop is 10 ms of samples and must be even. */
  sampleRate?: number;
  /** High-pass cutoff before measuring energy (default 100 Hz; null = off). */
  highPassHz?: number | null;
  /** Absolute sample value from which a sample counts as clipped (default 32 700). */
  clipLevel?: number;
}

export class EnvelopeBuilder {
  readonly sampleRate: number;
  readonly hopSamples: number;
  private readonly sub: number;
  private readonly clipLevel: number;
  private readonly b0: number;
  private readonly b1: number;
  private readonly b2: number;
  private readonly a1: number;
  private readonly a2: number;
  private sum = new Float64Array(2048);
  private count = new Uint16Array(2048);
  private peak = new Uint16Array(2048);
  private clip = new Uint8Array(2048);
  private next = 0;
  private fresh = true;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  constructor(options: EnvelopeOptions = {}) {
    this.sampleRate = options.sampleRate ?? SAMPLE_RATE;
    this.hopSamples = Math.round(this.sampleRate / 100);
    if (this.hopSamples < 2 || this.hopSamples % 2 !== 0 || this.hopSamples * 100 !== this.sampleRate) {
      throw new Error(`EnvelopeBuilder: unsupported sample rate ${this.sampleRate}`);
    }
    this.sub = this.hopSamples / 2;
    this.clipLevel = options.clipLevel ?? DEFAULT_CLIP_LEVEL;
    const hz = options.highPassHz === undefined ? 100 : options.highPassHz;
    if (hz === null || hz <= 0) {
      this.b0 = 1;
      this.b1 = 0;
      this.b2 = 0;
      this.a1 = 0;
      this.a2 = 0;
    } else {
      // RBJ cookbook high-pass, Q = 1/√2 (Butterworth).
      const w0 = (2 * Math.PI * hz) / this.sampleRate;
      const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
      const cos = Math.cos(w0);
      const a0 = 1 + alpha;
      this.b0 = (1 + cos) / 2 / a0;
      this.b1 = -(1 + cos) / a0;
      this.b2 = (1 + cos) / 2 / a0;
      this.a1 = (-2 * cos) / a0;
      this.a2 = (1 - alpha) / a0;
    }
  }

  /** Index just after the last sample pushed so far. */
  get samplesSeen(): number {
    return this.next;
  }

  /**
   * Adds a block of samples that starts at sample index `startSample` of the track (default:
   * right after the previous block). A later start leaves a gap of "no data". Samples before the
   * current position fill earlier gaps (a chunk that arrived late); where data already exists
   * (a re-sent duplicate) they are ignored.
   */
  push(samples: Int16Array, startSample: number = this.next): void {
    let i = 0;
    let idx = startSample;
    if (idx < this.next) {
      i = Math.min(samples.length, this.next - idx);
      this.fillLate(samples, idx, i);
      idx = this.next;
    } else if (idx > this.next) {
      this.fresh = true;
    }
    const end = samples.length;
    if (i >= end) return;
    const sub = this.sub;
    this.ensure(Math.floor((idx + (end - i) - 1) / sub) + 2);
    const { b0, b1, b2, a1, a2, clipLevel } = this;
    const sum = this.sum;
    const count = this.count;
    const peak = this.peak;
    const clip = this.clip;
    let x1 = this.x1;
    let x2 = this.x2;
    let y1 = this.y1;
    let y2 = this.y2;
    if (this.fresh) {
      // Steady state for a constant input equal to the first sample: no step transient.
      x1 = samples[i]!;
      x2 = x1;
      y1 = 0;
      y2 = 0;
      this.fresh = false;
    }
    while (i < end) {
      const sb = Math.floor(idx / sub);
      const n = Math.min(end - i, (sb + 1) * sub - idx);
      const stop = i + n;
      let acc = 0;
      let pk = peak[sb]!;
      let cl = clip[sb]!;
      for (let k = i; k < stop; k++) {
        const x = samples[k]!;
        let y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        if (y < 1e-20 && y > -1e-20) y = 0; // avoid denormals in long digital silence
        x2 = x1;
        x1 = x;
        y2 = y1;
        y1 = y;
        acc += y * y;
        const ax = x < 0 ? -x : x;
        if (ax > pk) pk = ax;
        if (ax >= clipLevel) cl = 1;
      }
      sum[sb] = sum[sb]! + acc;
      count[sb] = count[sb]! + n;
      peak[sb] = pk;
      clip[sb] = cl;
      i = stop;
      idx += n;
    }
    this.x1 = x1;
    this.x2 = x2;
    this.y1 = y1;
    this.y2 = y2;
    this.next = idx;
  }

  /**
   * Accumulates `n` samples at track positions `[start, start + n)` (all before `next`) into
   * sub-blocks that hold no data yet, with their own filter run (reset after every skipped part).
   */
  private fillLate(samples: Int16Array, start: number, n: number): void {
    const { sub, b0, b1, b2, a1, a2, clipLevel, sum, count, peak, clip } = this;
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    let fresh = true;
    let i = 0;
    while (i < n) {
      const idx = start + i;
      const sb = Math.floor(idx / sub);
      const len = Math.min(n - i, (sb + 1) * sub - idx);
      const stop = i + len;
      if (count[sb] !== 0) {
        fresh = true;
        i = stop;
        continue;
      }
      if (fresh) {
        x1 = samples[i]!;
        x2 = x1;
        y1 = 0;
        y2 = 0;
        fresh = false;
      }
      let acc = 0;
      let pk = 0;
      let cl = 0;
      for (let k = i; k < stop; k++) {
        const x = samples[k]!;
        let y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        if (y < 1e-20 && y > -1e-20) y = 0;
        x2 = x1;
        x1 = x;
        y2 = y1;
        y1 = y;
        acc += y * y;
        const ax = x < 0 ? -x : x;
        if (ax > pk) pk = ax;
        if (ax >= clipLevel) cl = 1;
      }
      sum[sb] = acc;
      count[sb] = len;
      peak[sb] = pk;
      clip[sb] = cl;
      i = stop;
    }
  }

  /** The envelope of everything pushed so far (the builder can keep going afterwards). */
  finish(): Envelope {
    const hop = this.hopSamples;
    const sub = this.sub;
    const frames = Math.ceil(this.next / hop);
    const subs = Math.ceil(this.next / sub);
    this.ensure(2 * frames + 2);
    const energyDb = new Float32Array(frames);
    const peakDb = new Float32Array(frames);
    const clipped = new Uint8Array(frames);
    const { sum, count, peak, clip } = this;
    for (let k = 0; k < frames; k++) {
      const s0 = 2 * k;
      const s1 = s0 + 1;
      const own = count[s0]! + count[s1]!;
      if (own < sub) {
        energyDb[k] = Number.NaN;
        peakDb[k] = Number.NaN;
        continue;
      }
      let ss = sum[s0]! + sum[s1]!;
      let c = own;
      if (s0 > 0) {
        ss += sum[s0 - 1]!;
        c += count[s0 - 1]!;
      }
      if (s1 + 1 < subs) {
        ss += sum[s1 + 1]!;
        c += count[s1 + 1]!;
      }
      energyDb[k] = Math.max(SILENCE_DB, powToDb(ss / c / FULL_SCALE_POW));
      const pk = Math.max(peak[s0]!, peak[s1]!);
      peakDb[k] = pk > 0 ? Math.max(SILENCE_DB, 20 * Math.log10(pk / 32768)) : SILENCE_DB;
      clipped[k] = clip[s0]! | clip[s1]!;
    }
    return { sampleRate: this.sampleRate, hopSamples: hop, frames, energyDb, peakDb, clipped };
  }

  private ensure(subBlocks: number): void {
    if (subBlocks <= this.sum.length) return;
    let cap = this.sum.length;
    while (cap < subBlocks) cap *= 2;
    const sum = new Float64Array(cap);
    sum.set(this.sum);
    this.sum = sum;
    const count = new Uint16Array(cap);
    count.set(this.count);
    this.count = count;
    const peak = new Uint16Array(cap);
    peak.set(this.peak);
    this.peak = peak;
    const clip = new Uint8Array(cap);
    clip.set(this.clip);
    this.clip = clip;
  }
}

/** Envelope of one contiguous PCM buffer (convenience for tests and short windows). */
export function buildEnvelope(pcm: Int16Array, options?: EnvelopeOptions): Envelope {
  const b = new EnvelopeBuilder(options);
  b.push(pcm, 0);
  return b.finish();
}
