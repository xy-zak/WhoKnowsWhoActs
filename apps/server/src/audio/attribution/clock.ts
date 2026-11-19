/**
 * Track clocks: where each track's samples sit on the server clock.
 *
 * Every chunk carries `clientTs`, the client's clock-synchronised estimate of when its first sample
 * was captured (≈ ±20 ms of jitter). Device sample clocks also drift (±100 ppm ≈ 0.36 s per
 * hour), so a track's time is a line, fitted robustly per track:
 *
 *     clientTs ≈ startTs + startSample · msPerSample
 *
 * Slope from the median of slopes between chunks half the series apart, intercept from the median,
 * then two rounds of least squares on the chunks within 3.5 σ (robust σ, at least 2 ms). Tracks
 * shorter than a minute keep the nominal rate (too few chunks to see drift, and it is below a frame).
 * A slope beyond `maxPlausibleDriftPpm` is a broken timestamp series: the nominal rate is used.
 * A chunk without a usable `clientTs` is placed by `serverTs − duration`.
 */

import type { ChunkMeta } from "./types";

export interface ClockTrackInput {
  trackId: string;
  seat: number;
  sampleRate: number;
  chunks: readonly ChunkMeta[];
}

export interface ClockFit {
  trackId: string;
  seat: number;
  /** Server time of sample 0 (ms). */
  startTs: number;
  msPerSample: number;
  driftPpm: number;
  /** RMS residual of the inlier chunks (ms). */
  residualMs: number;
  /** True when the timestamps implied an implausible drift and the nominal rate was used. */
  implausible: boolean;
}

const MIN_DRIFT_SPAN_MS = 60_000;

/** End of a track's audio: one past the last sample any of its chunks holds (0 without chunks). */
export function trackSampleEnd(chunks: Iterable<Pick<ChunkMeta, "startSample" | "sampleCount">>): number {
  let end = 0;
  for (const c of chunks) end = Math.max(end, c.startSample + c.sampleCount);
  return end;
}

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** The track's clock line, or null without chunks. */
export function fitClock(track: ClockTrackInput, maxPlausibleDriftPpm = 1000): ClockFit | null {
  const nominal = 1000 / track.sampleRate;
  const seen = new Set<number>();
  const x: number[] = [];
  const y: number[] = [];
  for (const c of [...track.chunks].sort((a, b) => a.startSample - b.startSample)) {
    if (seen.has(c.seq)) continue;
    seen.add(c.seq);
    const ts =
      Number.isFinite(c.clientTs) && c.clientTs > 0 ? c.clientTs : c.serverTs - c.sampleCount * nominal;
    x.push(c.startSample);
    y.push(ts);
  }
  if (x.length === 0) return null;
  const n = x.length;
  const lineFrom = (slope: number, idx: number[]) => ({
    slope,
    intercept: median(idx.map((i) => y[i]! - slope * x[i]!)),
  });
  const all = x.map((_, i) => i);
  let line = lineFrom(nominal, all);
  let inliers = all;
  if ((x[n - 1]! - x[0]!) * nominal >= MIN_DRIFT_SPAN_MS && n >= 4) {
    const half = n >> 1;
    const slopes: number[] = [];
    for (let i = 0; i + half < n; i++) slopes.push((y[i + half]! - y[i]!) / (x[i + half]! - x[i]!));
    line = lineFrom(median(slopes), all);
    for (let round = 0; round < 2; round++) {
      const r = all.map((i) => y[i]! - line.intercept - line.slope * x[i]!);
      const sigma = Math.max(2, 1.4826 * median(r.map(Math.abs)));
      inliers = all.filter((i) => Math.abs(r[i]!) <= 3.5 * sigma);
      if (inliers.length < 4) break;
      line = leastSquares(
        inliers.map((i) => x[i]!),
        inliers.map((i) => y[i]!),
      );
    }
  }
  let implausible = false;
  if (Math.abs((nominal / line.slope - 1) * 1e6) > maxPlausibleDriftPpm) {
    implausible = true;
    line = lineFrom(nominal, all);
    inliers = all;
  }
  const rms = Math.sqrt(
    inliers.reduce((a, i) => a + (y[i]! - line.intercept - line.slope * x[i]!) ** 2, 0) / inliers.length,
  );
  return {
    trackId: track.trackId,
    seat: track.seat,
    startTs: line.intercept,
    msPerSample: line.slope,
    driftPpm: (nominal / line.slope - 1) * 1e6,
    residualMs: rms,
    implausible,
  };
}

function leastSquares(x: number[], y: number[]): { slope: number; intercept: number } {
  const n = x.length;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i]! - mx) * (y[i]! - my);
    sxx += (x[i]! - mx) ** 2;
  }
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx };
}
