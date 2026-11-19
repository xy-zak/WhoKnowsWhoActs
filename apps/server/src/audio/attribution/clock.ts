/**
 * Track clocks: where each track's samples sit on the server clock.
 *
 * Every chunk carries `clientTs`, the client's (clock-synchronised) estimate of when its first
 * sample was captured, with ≈ ±20 ms of jitter plus a constant input latency. Device sample clocks
 * also drift (±100 ppm ≈ 0.36 s per hour), so a track's time is modelled as a line:
 *
 *     clientTs ≈ startTs + startSample · msPerSample
 *
 * fitted robustly: an O(n) Theil–Sen-style start (median of slopes between chunks half the series
 * apart), then iteratively re-weighted least squares that drops chunks more than 3.5 σ (robust,
 * from the MAD; at least 2 ms) from the line, until the inlier set is stable. A chunk without a
 * usable `clientTs` falls back to `serverTs − duration`.
 *
 * Drift is a property of the **device**, so all tracks of one seat share one slope (with one
 * intercept per track). That keeps the drift of short tracks (a reload, a pause) well determined.
 * A long track (≥ 5 min) whose own slope disagrees with the seat's longest track (by more than
 * 4 σ + 20 ppm; a plugged-in USB headset has its own clock) gets its own clock group. A slope beyond `maxPlausibleDriftPpm` is treated as a
 * broken timestamp series: the nominal rate is used and a warning is raised.
 *
 * Expected precision with ±20 ms uniform jitter and one chunk per 5 s: about 17 ppm (1σ) for a
 * 5-minute track, 6 ppm for 10 minutes and 0.4 ppm for an hour. The cross-correlation step
 * (`lag.ts`) refines both the constant offsets and the drift afterwards.
 */

import { MAD_TO_SIGMA, median, quantileSorted, round } from "./math";
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
  /** Tracks in one group share a sample clock (the same device). */
  group: string;
  sampleRate: number;
  /** Server time of sample 0 (ms). */
  startTs: number;
  msPerSample: number;
  driftPpm: number;
  /** Standard error of the drift (ppm). */
  driftSigmaPpm: number;
  /** RMS residual of the inlier chunks (ms). */
  residualRmsMs: number;
  chunks: number;
  outliers: number;
  /** Chunks placed by `serverTs` because `clientTs` was missing. */
  serverTsFallbacks: number;
}

/** End of a track's audio: one past the last sample any of its chunks holds (0 without chunks). */
export function trackSampleEnd(chunks: Iterable<Pick<ChunkMeta, "startSample" | "sampleCount">>): number {
  let end = 0;
  for (const c of chunks) end = Math.max(end, c.startSample + c.sampleCount);
  return end;
}

export function driftFromMsPerSample(msPerSample: number, sampleRate: number): number {
  return (1000 / (msPerSample * sampleRate) - 1) * 1e6;
}

export function msPerSampleFromDrift(driftPpm: number, sampleRate: number): number {
  return 1000 / (sampleRate * (1 + driftPpm * 1e-6));
}

interface Points {
  x: Float64Array; // startSample − xr
  y: Float64Array; // clientTs − yr
  xr: number;
  yr: number;
  serverFallbacks: number;
}

function toPoints(track: ClockTrackInput): Points | null {
  const seen = new Set<number>();
  const list: Array<{ x: number; y: number }> = [];
  let serverFallbacks = 0;
  for (const c of track.chunks) {
    if (!Number.isFinite(c.startSample) || seen.has(c.seq)) continue;
    let y = c.clientTs;
    if (!Number.isFinite(y)) {
      if (!Number.isFinite(c.serverTs)) continue;
      y = c.serverTs - (c.sampleCount * 1000) / track.sampleRate;
      serverFallbacks++;
    }
    seen.add(c.seq);
    list.push({ x: c.startSample, y });
  }
  if (list.length === 0) return null;
  list.sort((a, b) => a.x - b.x);
  const first = list[0]!;
  const x = new Float64Array(list.length);
  const y = new Float64Array(list.length);
  for (let i = 0; i < list.length; i++) {
    x[i] = list[i]!.x - first.x;
    y[i] = list[i]!.y - first.y;
  }
  return { x, y, xr: first.x, yr: first.y, serverFallbacks };
}

interface PooledFit {
  slope: number;
  /** Per group: intercept of the relative coordinates (y − yr = a + slope·(x − xr)). */
  intercepts: Float64Array;
  sigmaSlope: number;
  residualRms: number;
  outliers: Int32Array;
}

/** Robust common-slope fit with one intercept per group. */
function robustPooledFit(groups: readonly Points[], nominal: number, maxDev: number): PooledFit {
  const G = groups.length;
  // 1. Robust start: median of half-series slopes over all groups.
  const slopes: number[] = [];
  for (const g of groups) {
    const n = g.x.length;
    const h = Math.floor(n / 2);
    if (h < 1) continue;
    for (let k = 0; k + h < n; k++) {
      const dx = g.x[k + h]! - g.x[k]!;
      if (dx > 0) slopes.push((g.y[k + h]! - g.y[k]!) / dx);
    }
  }
  let slope = slopes.length ? median(slopes) : nominal;
  if (!(Math.abs(slope / nominal - 1) <= maxDev)) slope = nominal;
  const intercepts = new Float64Array(G);
  const fitIntercepts = (inlier: Uint8Array[] | null) => {
    for (let gi = 0; gi < G; gi++) {
      const g = groups[gi]!;
      const r: number[] = [];
      for (let k = 0; k < g.x.length; k++) {
        if (!inlier || inlier[gi]![k]) r.push(g.y[k]! - slope * g.x[k]!);
      }
      if (r.length === 0) for (let k = 0; k < g.x.length; k++) r.push(g.y[k]! - slope * g.x[k]!);
      intercepts[gi] = median(r);
    }
  };
  fitIntercepts(null);
  const inlier = groups.map((g) => new Uint8Array(g.x.length).fill(1));
  let sigmaSlope = Number.POSITIVE_INFINITY;
  let residualRms = 0;
  // 2. Iteratively re-weighted least squares with outlier rejection.
  for (let iter = 0; iter < 12; iter++) {
    const absRes: number[] = [];
    for (let gi = 0; gi < G; gi++) {
      const g = groups[gi]!;
      for (let k = 0; k < g.x.length; k++) absRes.push(Math.abs(g.y[k]! - intercepts[gi]! - slope * g.x[k]!));
    }
    const sorted = Float64Array.from(absRes).sort();
    const sigma = MAD_TO_SIGMA * quantileSorted(sorted, 0.5);
    const thr = Math.max(3.5 * sigma, 2);
    let changed = false;
    for (let gi = 0; gi < G; gi++) {
      const g = groups[gi]!;
      const mask = inlier[gi]!;
      for (let k = 0; k < g.x.length; k++) {
        const keep = Math.abs(g.y[k]! - intercepts[gi]! - slope * g.x[k]!) <= thr ? 1 : 0;
        if (keep !== mask[k]) {
          mask[k] = keep;
          changed = true;
        }
      }
    }
    // Pooled OLS: common slope, per-group means.
    let sxy = 0;
    let sxx = 0;
    const mx = new Float64Array(G);
    const my = new Float64Array(G);
    const cnt = new Int32Array(G);
    for (let gi = 0; gi < G; gi++) {
      const g = groups[gi]!;
      const mask = inlier[gi]!;
      for (let k = 0; k < g.x.length; k++) {
        if (!mask[k]) continue;
        mx[gi] = mx[gi]! + g.x[k]!;
        my[gi] = my[gi]! + g.y[k]!;
        cnt[gi] = cnt[gi]! + 1;
      }
      if (cnt[gi]! > 0) {
        mx[gi] = mx[gi]! / cnt[gi]!;
        my[gi] = my[gi]! / cnt[gi]!;
      }
      for (let k = 0; k < g.x.length; k++) {
        if (!mask[k]) continue;
        const dx = g.x[k]! - mx[gi]!;
        sxx += dx * dx;
        sxy += dx * (g.y[k]! - my[gi]!);
      }
    }
    const newSlope = sxx > 0 ? sxy / sxx : slope;
    if (Math.abs(newSlope / nominal - 1) <= maxDev) slope = newSlope;
    for (let gi = 0; gi < G; gi++) if (cnt[gi]! > 0) intercepts[gi] = my[gi]! - slope * mx[gi]!;
    // Residual statistics of the inliers.
    let ss = 0;
    let nIn = 0;
    for (let gi = 0; gi < G; gi++) {
      const g = groups[gi]!;
      const mask = inlier[gi]!;
      for (let k = 0; k < g.x.length; k++) {
        if (!mask[k]) continue;
        const r = g.y[k]! - intercepts[gi]! - slope * g.x[k]!;
        ss += r * r;
        nIn++;
      }
    }
    const dof = nIn - G - 1;
    residualRms = nIn > 0 ? Math.sqrt(ss / nIn) : 0;
    const sigmaRes = dof > 0 ? Math.sqrt(ss / dof) : Number.POSITIVE_INFINITY;
    sigmaSlope = sxx > 0 ? sigmaRes / Math.sqrt(sxx) : Number.POSITIVE_INFINITY;
    if (!changed && iter > 0) break;
  }
  const outliers = new Int32Array(G);
  for (let gi = 0; gi < G; gi++) {
    let o = 0;
    for (const v of inlier[gi]!) if (!v) o++;
    outliers[gi] = o;
  }
  return { slope, intercepts, sigmaSlope, residualRms, outliers };
}

function span(p: Points, sampleRate: number): number {
  return p.x.length ? (p.x[p.x.length - 1]! / sampleRate) * 1000 : 0;
}

/**
 * Fits the clock of every track. Tracks without a single usable chunk are left out and reported in
 * `warnings`.
 */
export function fitClocks(
  tracks: readonly ClockTrackInput[],
  options: { maxPlausibleDriftPpm?: number } = {},
): { fits: ClockFit[]; warnings: string[] } {
  const maxDev = (options.maxPlausibleDriftPpm ?? 1000) * 1e-6;
  const warnings: string[] = [];
  const fits: ClockFit[] = [];
  const bySeat = new Map<string, Array<{ t: ClockTrackInput; p: Points }>>();
  for (const t of tracks) {
    const p = toPoints(t);
    if (!p) {
      warnings.push(
        `Seat ${t.seat}: track ${t.trackId.slice(0, 8)} has no timestamped chunks and was skipped.`,
      );
      continue;
    }
    const key = `${t.seat}@${t.sampleRate}`;
    const list = bySeat.get(key) ?? [];
    list.push({ t, p });
    bySeat.set(key, list);
  }
  for (const list of bySeat.values()) {
    const rate = list[0]!.t.sampleRate;
    const nominal = 1000 / rate;
    let pool = list;
    const separate: typeof list = [];
    if (list.length > 1) {
      // Long tracks (≥ 5 min) are checked against the longest one: those whose own rate disagrees
      // run on another device clock and get their own group. Short tracks always join the seat's.
      const long = list
        .filter((e) => span(e.p, rate) >= 300_000 && e.p.x.length >= 20)
        .sort((a, b) => span(b.p, rate) - span(a.p, rate));
      const ref = long[0] ? robustPooledFit([long[0].p], nominal, maxDev) : null;
      for (const e of long.slice(1)) {
        const own = robustPooledFit([e.p], nominal, maxDev);
        const sigma = Math.hypot(own.sigmaSlope, ref!.sigmaSlope);
        if (Math.abs(own.slope - ref!.slope) > 4 * sigma + 20e-6 * nominal) separate.push(e);
      }
      if (separate.length) pool = list.filter((e) => !separate.includes(e));
    }
    const emit = (group: typeof list, groupName: string) => {
      if (!group.length) return;
      const fit = robustPooledFit(
        group.map((e) => e.p),
        nominal,
        maxDev,
      );
      let slope = fit.slope;
      const rawDrift = driftFromMsPerSample(slope, rate);
      if (!(Math.abs(rawDrift) <= maxDev * 1e6)) {
        slope = nominal;
        warnings.push(
          `Seat ${group[0]!.t.seat}: implausible clock drift (${round(rawDrift, 0)} ppm); using the nominal rate.`,
        );
      }
      const driftPpm = driftFromMsPerSample(slope, rate);
      const sigmaPpm = Number.isFinite(fit.sigmaSlope) ? (fit.sigmaSlope / slope) * 1e6 : 1000;
      group.forEach((e, gi) => {
        const a = fit.intercepts[gi]!;
        fits.push({
          trackId: e.t.trackId,
          seat: e.t.seat,
          group: groupName,
          sampleRate: rate,
          // y = yr + a + slope·(x − xr)  ⇒  y(0) = yr + a − slope·xr
          startTs: e.p.yr + a - slope * e.p.xr,
          msPerSample: slope,
          driftPpm,
          driftSigmaPpm: Math.min(1000, sigmaPpm),
          residualRmsMs: fit.residualRms,
          chunks: e.p.x.length,
          outliers: fit.outliers[gi]!,
          serverTsFallbacks: e.p.serverFallbacks,
        });
      });
    };
    emit(pool, `seat-${list[0]!.t.seat}@${rate}`);
    for (const e of separate) {
      warnings.push(
        `Seat ${e.t.seat}: track ${e.t.trackId.slice(0, 8)} runs on a different clock than the seat's other tracks (device changed?).`,
      );
      emit([e], `track-${e.t.trackId}`);
    }
  }
  return { fits, warnings };
}
