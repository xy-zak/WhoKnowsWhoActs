/**
 * Adaptive noise floor per channel: a running low percentile of the frame energies.
 *
 * The floor at each moment is the `percentile` (default 5 %) of the frame energies within a
 * centred sliding window (default 30 s), evaluated once per second and linearly interpolated in
 * between. A 0.5 dB histogram that is updated incrementally as the window slides keeps this
 * O(frames). Frames without data and dead frames (digital silence) are ignored. Steps whose window
 * holds too little data borrow the nearest valid step; a channel with no data at all gets the
 * silence level.
 *
 * Even in a lively four-person discussion every mic hears pauses between words and turns, so
 * the 5th percentile tracks the room noise and mic self-noise, not the speech. It follows slow
 * changes (a fan starting) within about half a window.
 */

import { quantileSorted } from "./math";
import { DEAD_DB, SILENCE_DB } from "./types";

const BIN_DB = 0.5;
const MIN_DB = SILENCE_DB;
const BINS = Math.ceil((0 - MIN_DB) / BIN_DB) + 1;

function binOf(e: number): number {
  const b = Math.floor((e - MIN_DB) / BIN_DB);
  return b < 0 ? 0 : b >= BINS ? BINS - 1 : b;
}

export interface NoiseFloorOptions {
  windowFrames: number;
  stepFrames?: number;
  percentile: number;
}

/** Per-frame noise floor (dBFS) of one channel's timeline energies (`NaN` = no data). */
export function estimateNoiseFloor(energyDb: Float32Array, options: NoiseFloorOptions): Float32Array {
  const frames = energyDb.length;
  const out = new Float32Array(frames);
  if (frames === 0) return out;
  const step = Math.max(1, options.stepFrames ?? 100);
  const half = Math.max(step, Math.floor(options.windowFrames / 2));
  const minCount = Math.max(50, Math.floor(options.windowFrames * 0.05));
  const q = options.percentile;
  const nSteps = Math.ceil(frames / step);
  const values = new Float64Array(nSteps).fill(Number.NaN);
  const hist = new Int32Array(BINS);
  let count = 0;
  let lo = 0;
  let hi = 0;
  const add = (f: number, sign: number) => {
    const e = energyDb[f]!;
    if (!(e > DEAD_DB)) return; // NaN or dead
    const b = binOf(e);
    hist[b] = hist[b]! + sign;
    count += sign;
  };
  for (let s = 0; s < nSteps; s++) {
    const centre = s * step + step / 2;
    const newLo = Math.max(0, Math.floor(centre - half));
    const newHi = Math.min(frames, Math.ceil(centre + half));
    while (hi < newHi) add(hi++, 1);
    while (lo < newLo) add(lo++, -1);
    if (count < minCount) continue;
    const target = q * count;
    let cum = 0;
    for (let b = 0; b < BINS; b++) {
      const h = hist[b]!;
      if (cum + h >= target && h > 0) {
        values[s] = MIN_DB + BIN_DB * (b + (target - cum) / h);
        break;
      }
      cum += h;
    }
  }
  // Fill steps without enough data from their neighbours.
  let any = false;
  for (let s = 0; s < nSteps; s++) if (!Number.isNaN(values[s]!)) any = true;
  if (!any) {
    out.fill(SILENCE_DB);
    return out;
  }
  let last = Number.NaN;
  for (let s = 0; s < nSteps; s++) {
    if (Number.isNaN(values[s]!)) values[s] = last;
    else last = values[s]!;
  }
  last = Number.NaN;
  for (let s = nSteps - 1; s >= 0; s--) {
    if (Number.isNaN(values[s]!)) values[s] = last;
    else last = values[s]!;
  }
  // Interpolate per frame between step centres.
  for (let f = 0; f < frames; f++) {
    const pos = (f - step / 2) / step;
    const s0 = Math.floor(pos);
    if (s0 < 0) out[f] = values[0]!;
    else if (s0 >= nSteps - 1) out[f] = values[nSteps - 1]!;
    else {
      const w = pos - s0;
      out[f] = values[s0]! + w * (values[s0 + 1]! - values[s0]!);
    }
  }
  return out;
}

/** A single floor for a short window (the quick calibration check): the percentile of all valid frames. */
export function constantNoiseFloor(energyDb: Float32Array, percentile: number): number {
  const v: number[] = [];
  for (const e of energyDb) if (e > DEAD_DB) v.push(e);
  if (v.length < 20) return Number.NaN;
  v.sort((a, b) => a - b);
  return quantileSorted(v, percentile);
}
