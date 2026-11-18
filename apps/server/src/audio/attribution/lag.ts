/**
 * Inter-channel lag refinement: the "audio file comparison" between the four mics.
 *
 * Because every mic in the room also hears the other three players, the same speech rhythm shows
 * up on all channels. After the clock fit, what is left is a small misalignment per track (each
 * device's constant input latency, timestamp bias and residual drift). It is measured from the
 * audio itself:
 *
 * 1. Each channel becomes an **activity envelope** `x = clamp(E − floor, 0, 40 dB)`: the dB above
 *    the noise floor, so noise fluctuations do not correlate.
 * 2. The timeline is cut into windows (default 40 s). For every pair of seats with enough data
 *    and activity in a window (std ≥ 1.5 dB on both), the mean-removed envelopes are
 *    cross-correlated over ±500 ms (normalised per lag). The peak is refined to sub-frame
 *    precision with a parabola through its neighbours. A window counts when the peak correlation
 *    is ≥ `lagMinCorr`, it is not at the edge of the search range, and no other local maximum
 *    comes within 92 % of it (periodic speech rhythm could otherwise alias).
 * 3. Per pair of tracks, gross outliers are removed around a robust line through lag versus time
 *    (more than max(30 ms, 5 σ) away).
 * 4. A weighted least-squares solve finds, per track, an offset `o` and, per clock group
 *    (device), a drift correction `ε` (ppm), so that `lag(A→B, t) ≈ δ_B(t) − δ_A(t)` with
 *    `δ(t) = o + ε·1e-6·(t − t_c)`. Priors: the anchor track (most data) has `o = 0`; each `ε`
 *    has the standard error of its timestamp regression as prior σ (a long, clean track barely
 *    moves, a short noisy one follows the audio); other offsets get a weak 1 s prior so tracks
 *    without any shared sound stay where their timestamps put them. Three rounds of residual
 *    rejection (> max(4 σ, 8 ms)) make it robust.
 *
 * The result is reported per track as `offsetMs` (added to the clock-fit start), a refined
 * `driftPpm`, a 0–1 `confidence` (number of confirming windows and their residual spread) and the
 * RMS residual. Absolute time stays referenced to the anchor's client timestamps; the anchor
 * device's own input latency (typically 10–40 ms) cannot be recovered from audio.
 */

import { MAD_TO_SIGMA, median, quantileSorted, robustLine, solveLinear } from "./math";
import type { Placement, SeatChannel } from "./timeline";
import type { Timeline } from "./types";

export interface LagObservation {
  seatA: number;
  seatB: number;
  /** Placement indices. */
  a: number;
  b: number;
  /** Window centre (server ms). */
  tMs: number;
  /** How much later the shared sound appears on B's timeline than on A's (ms). */
  lagMs: number;
  corr: number;
  accepted: boolean;
}

export interface LagOptions {
  windowSec: number;
  maxLagMs: number;
  minCorr: number;
}

const ACTIVITY_CAP_DB = 40;

export function measureLags(
  channels: readonly SeatChannel[],
  tl: Timeline,
  options: LagOptions,
): { observations: LagObservation[]; windows: number } {
  const frames = tl.frames;
  let W = Math.round((options.windowSec * 1000) / tl.hopMs);
  const L = Math.max(2, Math.round(options.maxLagMs / tl.hopMs));
  if (frames < W) {
    if (frames < Math.round(10_000 / tl.hopMs)) return { observations: [], windows: 0 };
    W = frames;
  }
  const act = channels.map((ch) => {
    const x = new Float32Array(frames);
    for (let f = 0; f < frames; f++) {
      const e = ch.energyDb[f]!;
      if (Number.isNaN(e)) x[f] = Number.NaN;
      else {
        const v = e - ch.floorDb[f]!;
        x[f] = v < 0 ? 0 : Math.min(v, ACTIVITY_CAP_DB);
      }
    }
    return x;
  });
  const nWin = Math.floor(frames / W);
  const observations: LagObservation[] = [];
  const A = new Float32Array(W);
  const B = new Float32Array(W + 2 * L);
  const P = new Float64Array(W + 2 * L + 1);
  const r = new Float64Array(2 * L + 1);
  for (let w = 0; w < nWin; w++) {
    const lo = w * W;
    const hi = lo + W;
    // The track that supplies most of each channel's frames in this window.
    const dominant = channels.map((ch) => {
      const counts = new Map<number, number>();
      for (let f = lo; f < hi; f++) {
        const t = ch.track[f]!;
        if (t >= 0 && !Number.isNaN(ch.energyDb[f]!)) counts.set(t, (counts.get(t) ?? 0) + 1);
      }
      let best = -1;
      let bestN = 0;
      for (const [t, n] of counts) {
        if (n > bestN) {
          best = t;
          bestN = n;
        }
      }
      return bestN >= 0.5 * W ? best : -1;
    });
    for (let i = 0; i < channels.length; i++) {
      const ti = dominant[i]!;
      if (ti < 0) continue;
      for (let j = i + 1; j < channels.length; j++) {
        const tj = dominant[j]!;
        if (tj < 0) continue;
        const ci = channels[i]!;
        const cj = channels[j]!;
        const xi = act[i]!;
        const xj = act[j]!;
        // Means and spreads inside the window.
        let si = 0;
        let sii = 0;
        let ni = 0;
        let sj = 0;
        let sjj = 0;
        let nj = 0;
        for (let f = lo; f < hi; f++) {
          if (ci.track[f] === ti && !Number.isNaN(xi[f]!)) {
            si += xi[f]!;
            sii += xi[f]! * xi[f]!;
            ni++;
          }
          if (cj.track[f] === tj && !Number.isNaN(xj[f]!)) {
            sj += xj[f]!;
            sjj += xj[f]! * xj[f]!;
            nj++;
          }
        }
        if (ni < 0.5 * W || nj < 0.5 * W) continue;
        const mi = si / ni;
        const mj = sj / nj;
        const sdi = Math.sqrt(Math.max(0, sii / ni - mi * mi));
        const sdj = Math.sqrt(Math.max(0, sjj / nj - mj * mj));
        if (sdi < 1.5 || sdj < 1.5) continue;
        let ea = 0;
        for (let f = lo; f < hi; f++) {
          const v = ci.track[f] === ti && !Number.isNaN(xi[f]!) ? xi[f]! - mi : 0;
          A[f - lo] = v;
          ea += v * v;
        }
        P[0] = 0;
        for (let k = 0; k < W + 2 * L; k++) {
          const f = lo - L + k;
          const ok = f >= 0 && f < frames && cj.track[f] === tj && !Number.isNaN(xj[f]!);
          const v = ok ? xj[f]! - mj : 0;
          B[k] = v;
          P[k + 1] = P[k]! + v * v;
        }
        let bestK = 0;
        let bestR = Number.NEGATIVE_INFINITY;
        for (let k = 0; k <= 2 * L; k++) {
          // tau = k − L; B index of A[n] shifted by tau is n + k.
          let num = 0;
          for (let n = 0; n < W; n++) num += A[n]! * B[n + k]!;
          const eb = P[k + W]! - P[k]!;
          const v = ea > 0 && eb > 0 ? num / Math.sqrt(ea * eb) : 0;
          r[k] = v;
          if (v > bestR) {
            bestR = v;
            bestK = k;
          }
        }
        let accepted = bestR >= options.minCorr && bestK > 0 && bestK < 2 * L;
        // Reject when another local maximum (away from the main lobe) comes close.
        if (accepted) {
          for (let k = 1; k < 2 * L; k++) {
            if (Math.abs(k - bestK) <= 5) continue;
            const v = r[k]!;
            if (v >= r[k - 1]! && v >= r[k + 1]! && v > 0.92 * bestR) {
              accepted = false;
              break;
            }
          }
        }
        let delta = 0;
        if (bestK > 0 && bestK < 2 * L) {
          const ym = r[bestK - 1]!;
          const y0 = r[bestK]!;
          const yp = r[bestK + 1]!;
          const den = ym - 2 * y0 + yp;
          if (den < 0) delta = Math.max(-0.5, Math.min(0.5, (0.5 * (ym - yp)) / den));
        }
        observations.push({
          seatA: ci.seat,
          seatB: cj.seat,
          a: ti,
          b: tj,
          tMs: tl.t0 + (lo + W / 2) * tl.hopMs,
          lagMs: (bestK - L + delta) * tl.hopMs,
          corr: bestR,
          accepted,
        });
      }
    }
  }
  return { observations, windows: nWin };
}

export interface OffsetSolution {
  /** Per placement: the misalignment `o` (ms) at its group's reference time. */
  offsets: Float64Array;
  /** Per clock group: the drift correction (ppm). */
  epsPpm: Map<string, number>;
  /** Group reference times (ms). */
  groupCentre: Map<string, number>;
  residualRmsMs: number | null;
  perPlacement: Array<{ observations: number; residualRmsMs: number | null; confidence: number }>;
}

/**
 * Solves per-track offsets and per-device drift corrections from the lag observations.
 * Marks rejected observations by clearing `accepted`.
 */
export function solveOffsets(
  placements: readonly Placement[],
  groupSigmaPpm: ReadonlyMap<string, number>,
  observations: LagObservation[],
  anchor: number,
): OffsetSolution {
  const P = placements.length;
  const groups = [...new Set(placements.map((p) => p.group))];
  const G = groups.length;
  const gIndex = new Map(groups.map((g, i) => [g, i]));
  const groupCentre = new Map<string, number>();
  for (const g of groups) {
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const p of placements) {
      if (p.group !== g) continue;
      lo = Math.min(lo, p.startTs + p.offsetMs);
      hi = Math.max(hi, p.startTs + p.offsetMs + p.samples * p.msPerSample);
    }
    groupCentre.set(g, (lo + hi) / 2);
  }
  // Gross-outlier rejection per pair of placements, around a robust line lag(t).
  const byPair = new Map<string, LagObservation[]>();
  for (const o of observations) {
    if (!o.accepted) continue;
    const key = `${o.a}:${o.b}`;
    const list = byPair.get(key) ?? [];
    list.push(o);
    byPair.set(key, list);
  }
  for (const list of byPair.values()) {
    if (list.length < 3) continue;
    const t = list.map((o) => o.tMs);
    const y = list.map((o) => o.lagMs);
    const line = robustLine(t, y);
    const res = list.map((o) => o.lagMs - line.intercept - line.slope * o.tMs);
    const sigma = MAD_TO_SIGMA * median(res.map(Math.abs));
    const thr = Math.max(30, 5 * sigma);
    list.forEach((o, i) => {
      if (Math.abs(res[i]!) > thr) o.accepted = false;
    });
  }
  const N = P + G;
  let sigmaObs = 3;
  let x: Float64Array = new Float64Array(N);
  const residualOf = (o: LagObservation, sol: Float64Array) => {
    const pa = placements[o.a]!;
    const pb = placements[o.b]!;
    const ga = gIndex.get(pa.group)!;
    const gb = gIndex.get(pb.group)!;
    const da = sol[o.a]! + sol[P + ga]! * 1e-6 * (o.tMs - groupCentre.get(pa.group)!);
    const db = sol[o.b]! + sol[P + gb]! * 1e-6 * (o.tMs - groupCentre.get(pb.group)!);
    return o.lagMs - (db - da);
  };
  for (let round = 0; round < 4; round++) {
    const M = new Float64Array(N * N);
    const rhs = new Float64Array(N);
    for (let i = 0; i < P; i++) M[i * N + i] = M[i * N + i]! + 1e-6; // weak prior: |o| ≲ 1 s
    M[anchor * N + anchor] = M[anchor * N + anchor]! + 1e6;
    for (let g = 0; g < G; g++) {
      const s = Math.min(300, Math.max(0.2, groupSigmaPpm.get(groups[g]!) ?? 300));
      M[(P + g) * N + P + g] = M[(P + g) * N + P + g]! + 1 / (s * s);
    }
    const w0 = 1 / (sigmaObs * sigmaObs);
    for (const o of observations) {
      if (!o.accepted) continue;
      const pa = placements[o.a]!;
      const pb = placements[o.b]!;
      const ga = P + gIndex.get(pa.group)!;
      const gb = P + gIndex.get(pb.group)!;
      const idx = [o.b, o.a, gb, ga];
      const coef = [
        1,
        -1,
        1e-6 * (o.tMs - groupCentre.get(pb.group)!),
        -1e-6 * (o.tMs - groupCentre.get(pa.group)!),
      ];
      const w = w0 * Math.min(1, Math.max(0.25, o.corr));
      for (let u = 0; u < 4; u++) {
        const iu = idx[u]!;
        rhs[iu] = rhs[iu]! + w * coef[u]! * o.lagMs;
        for (let v = 0; v < 4; v++) {
          const iv = idx[v]!;
          M[iu * N + iv] = M[iu * N + iv]! + w * coef[u]! * coef[v]!;
        }
      }
    }
    const sol = solveLinear(M, rhs, N);
    if (!sol) break;
    x = sol;
    if (round === 3) break;
    const res: number[] = [];
    for (const o of observations) if (o.accepted) res.push(residualOf(o, x));
    if (res.length < 2) break;
    const sorted = Float64Array.from(res.map(Math.abs)).sort();
    sigmaObs = Math.max(1, MAD_TO_SIGMA * quantileSorted(sorted, 0.5));
    const thr = Math.max(4 * sigmaObs, 8);
    for (const o of observations) if (o.accepted && Math.abs(residualOf(o, x)) > thr) o.accepted = false;
  }
  const per = placements.map(() => ({ n: 0, ss: 0 }));
  let ssAll = 0;
  let nAll = 0;
  for (const o of observations) {
    if (!o.accepted) continue;
    const rr = residualOf(o, x);
    for (const k of [o.a, o.b]) {
      per[k]!.n++;
      per[k]!.ss += rr * rr;
    }
    ssAll += rr * rr;
    nAll++;
  }
  const epsPpm = new Map<string, number>();
  groups.forEach((g, i) => {
    epsPpm.set(g, x[P + i]!);
  });
  return {
    offsets: x.slice(0, P),
    epsPpm,
    groupCentre,
    residualRmsMs: nAll ? Math.sqrt(ssAll / nAll) : null,
    perPlacement: per.map(({ n, ss }) => {
      const rms = n ? Math.sqrt(ss / n) : null;
      const confidence = n && rms !== null ? (1 - Math.exp(-n / 4)) * Math.exp(-((rms / 10) ** 2)) : 0;
      return { observations: n, residualRmsMs: rms, confidence };
    }),
  };
}
