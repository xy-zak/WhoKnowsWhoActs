/**
 * Small numeric helpers of the attribution engine: dB/power conversions, robust statistics
 * (median, quantiles, MAD), the Huber loss, a robust line fit and a dense linear solver.
 */

import { SILENCE_DB } from "./types";

/** 10·log10(x) = DB_PER_NEPER · ln(x). */
export const DB_PER_NEPER = 10 / Math.LN10;
const MIN_POW = 1e-12; // −120 dB
/** Scale from MAD to σ for a normal distribution. */
export const MAD_TO_SIGMA = 1.4826;

/** Power ratio → dB, floored at the silence level. */
export function powToDb(p: number): number {
  return p > MIN_POW ? DB_PER_NEPER * Math.log(p) : SILENCE_DB;
}

export function dbToPow(db: number): number {
  return Math.exp(db / DB_PER_NEPER);
}

/** Level of two incoherent sounds together. */
export function dbAdd(a: number, b: number): number {
  return powToDb(dbToPow(a) + dbToPow(b));
}

/** Below this distance above the floor (dB), a level is treated as "at or below the noise". */
export const CENSOR_DB = 2;
/** Power ratio (signal+noise)/noise at `CENSOR_DB`. */
export const CENSOR_RATIO = 10 ** (CENSOR_DB / 10);
/** Value of `noiseCorrected` at the censoring limit, relative to the floor (≈ −2.33 dB). */
export const CENSORED_OFFSET = DB_PER_NEPER * Math.log(CENSOR_RATIO - 1);

/**
 * The part of `db` that is not noise (power subtraction of `floorDb`). Levels within
 * `CENSOR_DB` of the floor are clamped to the value at that limit (continuous, ≈ floor − 2.3 dB):
 * they only tell us the signal is at most about the floor.
 */
export function noiseCorrected(db: number, floorDb: number): number {
  if (db - floorDb < CENSOR_DB) return floorDb + CENSORED_OFFSET;
  return powToDb(dbToPow(db) - dbToPow(floorDb));
}

/** Linear-interpolated quantile of an already sorted array (`NaN` when empty). */
export function quantileSorted(sorted: ArrayLike<number>, q: number): number {
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  const pos = Math.min(Math.max(q, 0), 1) * (n - 1);
  const i = Math.floor(pos);
  const a = sorted[i]!;
  return i + 1 < n ? a + (pos - i) * (sorted[i + 1]! - a) : a;
}

/** Median of the first `n` values (default all); `NaN` when empty. Values must not be `NaN`. */
export function median(values: ArrayLike<number>, n = values.length): number {
  if (n === 0) return Number.NaN;
  const s = new Float64Array(n);
  for (let i = 0; i < n; i++) s[i] = values[i]!;
  s.sort();
  return quantileSorted(s, 0.5);
}

/** Robust σ: 1.4826 × the median absolute deviation from `center`. */
export function robustSigma(values: ArrayLike<number>, center: number, n = values.length): number {
  if (n === 0) return Number.NaN;
  const d = new Float64Array(n);
  for (let i = 0; i < n; i++) d[i] = Math.abs(values[i]! - center);
  d.sort();
  return MAD_TO_SIGMA * quantileSorted(d, 0.5);
}

/** Huber loss scaled so that it equals r² inside ±delta (sqrt of a sum of these is "dB-like"). */
export function huber(r: number, delta: number): number {
  const a = r < 0 ? -r : r;
  return a <= delta ? a * a : delta * (2 * a - delta);
}

/**
 * Robust line through (x, y): the median of slopes between points half the series apart
 * (a cheap, O(n) relative of Theil–Sen that tolerates ~25 % outliers), then the median intercept.
 */
export function robustLine(x: ArrayLike<number>, y: ArrayLike<number>): { slope: number; intercept: number } {
  const n = x.length;
  if (n === 0) return { slope: 0, intercept: Number.NaN };
  if (n === 1) return { slope: 0, intercept: y[0]! };
  const h = Math.max(1, Math.floor(n / 2));
  const slopes: number[] = [];
  for (let k = 0; k + h < n; k++) {
    const dx = x[k + h]! - x[k]!;
    if (dx !== 0) slopes.push((y[k + h]! - y[k]!) / dx);
  }
  const slope = slopes.length ? median(slopes) : 0;
  const r = new Float64Array(n);
  for (let k = 0; k < n; k++) r[k] = y[k]! - slope * x[k]!;
  return { slope, intercept: median(r) };
}

/**
 * Solves `A·x = b` (A is n×n, row-major) by Gaussian elimination with partial pivoting.
 * Returns null when the system is singular. The inputs are not modified.
 */
export function solveLinear(A: Float64Array, b: Float64Array, n: number): Float64Array | null {
  const M = Float64Array.from(A);
  const x = Float64Array.from(b);
  for (let c = 0; c < n; c++) {
    let p = c;
    let best = Math.abs(M[c * n + c]!);
    for (let r = c + 1; r < n; r++) {
      const v = Math.abs(M[r * n + c]!);
      if (v > best) {
        best = v;
        p = r;
      }
    }
    if (!(best > 1e-300)) return null;
    if (p !== c) {
      for (let k = 0; k < n; k++) {
        const t = M[c * n + k]!;
        M[c * n + k] = M[p * n + k]!;
        M[p * n + k] = t;
      }
      const t = x[c]!;
      x[c] = x[p]!;
      x[p] = t;
    }
    const d = M[c * n + c]!;
    for (let r = c + 1; r < n; r++) {
      const f = M[r * n + c]! / d;
      if (f === 0) continue;
      for (let k = c; k < n; k++) M[r * n + k] = M[r * n + k]! - f * M[c * n + k]!;
      x[r] = x[r]! - f * x[c]!;
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = x[r]!;
    for (let k = r + 1; k < n; k++) s -= M[r * n + k]! * x[k]!;
    x[r] = s / M[r * n + r]!;
  }
  return x;
}

/** A growable list of numbers backed by a typed array. */
export class NumberList {
  private data: Float64Array;
  length = 0;
  constructor(capacity = 256) {
    this.data = new Float64Array(Math.max(1, capacity));
  }
  push(v: number): void {
    if (this.length === this.data.length) {
      const next = new Float64Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = v;
  }
  /** A view of the stored values (valid until the next push). */
  view(): Float64Array {
    return this.data.subarray(0, this.length);
  }
}

/** Rounds to `digits` decimals (for reports; keeps JSON small and stable). */
export function round(v: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** Like `round`, but passes null/NaN/±Infinity through as null. */
export function roundOrNull(v: number | null | undefined, digits = 2): number | null {
  return v === null || v === undefined || !Number.isFinite(v) ? null : round(v, digits);
}
