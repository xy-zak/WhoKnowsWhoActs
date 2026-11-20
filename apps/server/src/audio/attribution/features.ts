/**
 * `FeatureBuilder`: reduces a track's PCM, chunk by chunk, to 10 ms frames of
 *  - energy (dBFS, after a 100 Hz high-pass that removes rumble, handling noise and DC),
 *  - a clip flag,
 *  - a speech probability from the voice activity detector (`Vad`), when one is given.
 *
 * Chunks must arrive in `startSample` order (`seqOrderedChunks` does that). Samples before the
 * current position (a resent overlap) are skipped; a jump forward is a gap: its frames stay
 * "no data" (`NaN`), and the filter and the detector start afresh after it.
 *
 * `push` is synchronous; complete detector windows are queued and scored by `drain()` (async),
 * so the caller decides when the model runs and memory stays at about one chunk.
 */

import { AUDIO_SILENCE_DB } from "@wkwa/shared";
import { HOP_SAMPLES, type TrackFeatures } from "./types";

/** A voice activity detector over fixed windows of 16 kHz audio (float, −1…1). */
export interface Vad {
  readonly windowSamples: number;
  /** Forget the context (a gap in the audio). */
  reset(): void;
  /** Speech probability (0–1) of the next window. */
  next(window: Float32Array): Promise<number>;
}

const FULL_SCALE_SQ = 32768 * 32768;
/** One-pole high-pass at 100 Hz (16 kHz). */
const HP_R = Math.exp((-2 * Math.PI * 100) / 16000);

/** A growable typed array. */
class Grow<T extends Float32Array | Float64Array | Uint8Array> {
  data: T;
  constructor(
    private readonly make: (n: number) => T,
    private readonly fillValue = 0,
  ) {
    this.data = make(1024);
    this.data.fill(fillValue);
  }
  ensure(n: number): T {
    if (n > this.data.length) {
      const next = this.make(Math.max(n, this.data.length * 2));
      next.fill(this.fillValue);
      next.set(this.data);
      this.data = next;
    }
    return this.data;
  }
}

export class FeatureBuilder {
  private readonly sumSq = new Grow((n) => new Float64Array(n));
  private readonly count = new Grow((n) => new Float64Array(n));
  private readonly clip = new Grow((n) => new Uint8Array(n));
  private readonly prob = new Grow((n) => new Float32Array(n), Number.NaN);
  /** Next expected sample; frames end below `pos` (or are empty). */
  private pos = 0;
  private x1 = 0;
  private y1 = 0;
  /** Detector window being filled, its first sample, and windows waiting to be scored. */
  private win: Float32Array;
  private winFill = 0;
  private winStart = 0;
  private pending: Array<{ start: number; data: Float32Array; reset: boolean }> = [];
  private resetNext = true;

  constructor(private readonly vad: Vad | null = null) {
    this.win = new Float32Array(vad?.windowSamples ?? 0);
  }

  push(samples: Int16Array, startSample: number): void {
    let from = 0;
    if (startSample < this.pos)
      from = this.pos - startSample; // a resent overlap
    else if (startSample > this.pos) this.gap(startSample);
    if (from >= samples.length) return;
    const end = startSample + samples.length;
    const lastFrame = Math.floor((end - 1) / HOP_SAMPLES);
    const sumSq = this.sumSq.ensure(lastFrame + 1);
    const count = this.count.ensure(lastFrame + 1);
    const clip = this.clip.ensure(lastFrame + 1);
    for (let i = from; i < samples.length; i++) {
      const x = samples[i]!;
      const y = HP_R * (this.y1 + x - this.x1);
      this.x1 = x;
      this.y1 = y;
      const f = Math.floor((startSample + i) / HOP_SAMPLES);
      sumSq[f] = sumSq[f]! + y * y;
      count[f] = count[f]! + 1;
      if (x >= 32767 || x <= -32768) clip[f] = 1;
      if (this.vad) {
        if (this.winFill === 0) this.winStart = startSample + i;
        this.win[this.winFill++] = x / 32768;
        if (this.winFill === this.win.length) {
          this.pending.push({ start: this.winStart, data: this.win, reset: this.resetNext });
          this.resetNext = false;
          this.win = new Float32Array(this.win.length);
          this.winFill = 0;
        }
      }
    }
    this.pos = end;
  }

  /** Scores the queued detector windows. */
  async drain(): Promise<void> {
    if (!this.vad) return;
    const n = this.vad.windowSamples;
    for (const w of this.pending) {
      if (w.reset) this.vad.reset();
      const p = await this.vad.next(w.data);
      // every frame whose centre lies in the window gets its probability
      const first = Math.ceil((w.start - HOP_SAMPLES / 2) / HOP_SAMPLES);
      const last = Math.floor((w.start + n - 1 - HOP_SAMPLES / 2) / HOP_SAMPLES);
      const prob = this.prob.ensure(last + 1);
      for (let f = Math.max(0, first); f <= last; f++) prob[f] = p;
    }
    this.pending = [];
  }

  /** The features; call `drain()` first when a detector is used. */
  finish(): TrackFeatures {
    const frames = Math.ceil(this.pos / HOP_SAMPLES);
    const energyDb = new Float32Array(frames);
    const sumSq = this.sumSq.ensure(frames);
    const count = this.count.ensure(frames);
    for (let f = 0; f < frames; f++) {
      const n = count[f]!;
      energyDb[f] =
        n > 0
          ? Math.max(AUDIO_SILENCE_DB, 10 * Math.log10(sumSq[f]! / n / FULL_SCALE_SQ + 1e-12))
          : Number.NaN;
    }
    let speech: Float32Array | null = null;
    if (this.vad) {
      speech = this.prob.ensure(frames).slice(0, frames);
      // frames the last (partial) window did not score: no probability, so no speech
      for (let f = 0; f < frames; f++) if (Number.isNaN(speech[f]!) && count[f]! > 0) speech[f] = 0;
    }
    return { frames, energyDb, clipped: this.clip.ensure(frames).slice(0, frames), speech };
  }

  private gap(to: number) {
    this.pos = to;
    this.x1 = 0;
    this.y1 = 0;
    this.winFill = 0;
    this.resetNext = true;
  }
}
