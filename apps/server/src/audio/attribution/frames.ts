/**
 * Frame attribution: who is speaking in each 10 ms frame, from the four mic levels alone.
 *
 * Model. A mic hears every voice, attenuated by the leakage matrix, plus its own noise:
 *
 *     P_j = Σ_s 10^((L_s + G[s][j]) / 10) + 10^(F_j / 10)
 *
 * (L_s = seat s's voice level on its own mic, F_j = mic j's noise floor, all in dB).
 *
 * Per frame:
 * 1. **Candidates**: mics at least `activeMarginDb` (6 dB) above their floor. None → silence.
 * 2. **Dominant speaker**: for each hypothesis "seat s speaks alone", take L_s from s's own mic
 *    (noise-corrected) and predict every other mic j as `dbAdd(L_s + G[s][j], F_j)`. The cost is the
 *    sum of Huber losses (quadratic up to `huberDb`, then linear) of observed − predicted; the
 *    lowest cost wins. Only candidate seats can be the speaker (a voice is loudest on its own mic
 *    relative to that mic's floor), except a seat whose mic has **no data** right now: it can still
 *    be hypothesised (its level fitted as the median over the other mics) at a small extra cost
 *    (`absentPenalty`). If such an absent seat wins, the frame is "unattributable" and nobody is
 *    credited; that keeps a seat whose mic dropped out from being attributed to its neighbour.
 *    In frames with an absent seat, a **level prior** also applies: a hypothesis whose fitted level
 *    is more than 12 dB below that seat's typical speech level (the 95th percentile of its mic) is
 *    penalised, because a faint sound on one mic is more likely another voice leaking in than a
 *    quiet own voice. Seats that never had data are never hypothesised.
 * 3. **Overlap**: every other candidate k is tested against the dominant speaker's predicted
 *    leakage. If mic k exceeds it by more than `max(overlapMarginDb, overlapSpreadFactor · σ[s][k])`
 *    (σ = the measured spread of that leakage), seat k is speaking as well.
 * 4. **Confidence** of the dominant decision: with `d` = √cost(second) − √cost(best) (a dB-like
 *    distance between the two best hypotheses) and `q` = the RMS residual of the best one,
 *    `conf = d² / (d² + 16) · 1 / (1 + (q/6)²)`. The frame is **ambiguous** when `d < ambiguousDb`
 *    or `q > 8 dB` (no single-speaker pattern fits). Overlap frames get 0.5–0.95 depending on
 *    how far the excess clears the margin.
 *
 * Only level *ratios between mics* are used: nothing about the voice itself (no spectra, pitch or
 * embeddings), so the engine attributes speech to a seat without identifying the person.
 */

import type { LeakageModel } from "./leakage";
import { CENSOR_RATIO, CENSORED_OFFSET, dbToPow, huber, powToDb } from "./math";
import { type SeatChannel, typicalLevels } from "./timeline";
import { type AttributionOptions, DEAD_DB } from "./types";

/** Dominant-speaker codes besides a seat index. */
export const SILENT = -1;
export const ABSENT = -2;
export const NO_DATA = -3;

/** Level prior (frames with an absent seat): how far below its typical level a voice may be for free. */
const LEVEL_PRIOR_DB = 12;

export interface FrameDecisions {
  /** Raw activity per seat index: 1 = dominant speaker, 2 = overlapping speaker, 0 = not speaking. */
  active: Uint8Array[];
  /** Per-frame confidence per seat index (0 where not active). */
  confidence: Float32Array[];
  /** Dominant seat index per frame, or SILENT / ABSENT / NO_DATA. */
  dominant: Int8Array;
  /** 1 where the dominant decision was ambiguous. */
  ambiguous: Uint8Array;
  speechFrames: number;
  ambiguousFrames: number;
  absentFrames: number;
}

export function attributeFrames(
  channels: readonly SeatChannel[],
  model: LeakageModel,
  opts: AttributionOptions,
  typical: readonly number[] = typicalLevels(channels),
): FrameDecisions {
  const n = channels.length;
  const frames = channels[0]?.energyDb.length ?? 0;
  const active = channels.map(() => new Uint8Array(frames));
  const confidence = channels.map(() => new Float32Array(frames));
  const dominant = new Int8Array(frames);
  const ambiguous = new Uint8Array(frames);
  const G = model.G;
  const gPow = new Float64Array(n * n);
  const margin = new Float64Array(n * n);
  const rowOk = new Uint8Array(n);
  for (let s = 0; s < n; s++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      const g = G[s * n + j]!;
      if (Number.isNaN(g)) ok = false;
      gPow[s * n + j] = dbToPow(g);
      const sp = model.spread[s * n + j]!;
      margin[s * n + j] = Math.min(
        15,
        Math.max(opts.overlapMarginDb, opts.overlapSpreadFactor * (Number.isNaN(sp) ? 0 : sp)),
      );
    }
    rowOk[s] = ok ? 1 : 0;
  }
  const e = new Float64Array(n);
  const ec = new Float64Array(n);
  const nz = new Float64Array(n);
  const has = new Uint8Array(n);
  const cand = new Uint8Array(n);
  const tmp = new Float64Array(n);
  const delta = opts.huberDb;
  // Typical speech level per seat (95th percentile of its mic), for the level prior.
  const ref = typical;
  for (let s = 0; s < n; s++) if (Number.isNaN(ref[s]!)) rowOk[s] = 0;
  let speechFrames = 0;
  let ambiguousFrames = 0;
  let absentFrames = 0;
  for (let f = 0; f < frames; f++) {
    let nHas = 0;
    let nCand = 0;
    for (let j = 0; j < n; j++) {
      const ch = channels[j]!;
      const v = ch.energyDb[f]!;
      if (v > DEAD_DB) {
        has[j] = 1;
        nHas++;
        const fl = ch.floorDb[f]!;
        e[j] = v;
        const pn = dbToPow(fl);
        nz[j] = pn;
        const pv = dbToPow(v);
        ec[j] = pv > pn * CENSOR_RATIO ? powToDb(pv - pn) : fl + CENSORED_OFFSET; // noiseCorrected, inlined
        const c = v - fl >= opts.activeMarginDb ? 1 : 0;
        cand[j] = c;
        nCand += c;
      } else {
        has[j] = 0;
        cand[j] = 0;
      }
    }
    if (nHas === 0) {
      dominant[f] = NO_DATA;
      continue;
    }
    if (nCand === 0) {
      dominant[f] = SILENT;
      continue;
    }
    speechFrames++;
    let anyAbsent = false;
    for (let s = 0; s < n; s++) if (rowOk[s] && !has[s]) anyAbsent = true;
    let best = -1;
    let bestCost = Number.POSITIVE_INFINITY;
    let bestL = 0;
    let bestTerms = 1;
    let bestExtra = 0;
    let second = Number.POSITIVE_INFINITY;
    for (let s = 0; s < n; s++) {
      if (!rowOk[s]) continue;
      let L: number;
      let cost = 0;
      let extra = 0;
      let terms = 0;
      if (has[s]) {
        if (!cand[s]) continue;
        L = ec[s]!;
      } else {
        let m = 0;
        for (let j = 0; j < n; j++) if (cand[j]) tmp[m++] = ec[j]! - G[s * n + j]!;
        // median of tmp[0..m)
        for (let a = 1; a < m; a++) {
          const v = tmp[a]!;
          let b = a - 1;
          while (b >= 0 && tmp[b]! > v) {
            tmp[b + 1] = tmp[b]!;
            b--;
          }
          tmp[b + 1] = v;
        }
        L = m % 2 ? tmp[(m - 1) / 2]! : 0.5 * (tmp[m / 2 - 1]! + tmp[m / 2]!);
        extra = opts.absentPenalty;
      }
      if (anyAbsent) {
        const short = ref[s]! - LEVEL_PRIOR_DB - L;
        if (short > 0) extra += huber(short, delta);
      }
      cost = extra;
      const pL = dbToPow(L);
      for (let j = 0; j < n; j++) {
        if (j === s || !has[j]) continue;
        const pred = powToDb(pL * gPow[s * n + j]! + nz[j]!);
        cost += huber(e[j]! - pred, delta);
        terms++;
        if (cost > second) break;
      }
      if (cost < bestCost) {
        second = bestCost;
        bestCost = cost;
        best = s;
        bestL = L;
        bestTerms = Math.max(1, terms);
        bestExtra = extra;
      } else if (cost < second) {
        second = cost;
      }
    }
    if (best < 0) {
      dominant[f] = SILENT;
      ambiguous[f] = 1;
      ambiguousFrames++;
      continue;
    }
    const sb = Math.sqrt(bestCost);
    const d = Number.isFinite(second) ? Math.sqrt(second) - sb : 20;
    const q = Math.sqrt(Math.max(0, bestCost - bestExtra) / bestTerms); // fit only, without priors
    const conf = ((d * d) / (d * d + 16)) * (1 / (1 + (q / 6) ** 2));
    if (d < opts.ambiguousDb || q > 8) {
      ambiguous[f] = 1;
      ambiguousFrames++;
    }
    if (has[best]) {
      dominant[f] = best;
      active[best]![f] = 1;
      confidence[best]![f] = conf;
    } else {
      dominant[f] = ABSENT;
      absentFrames++;
    }
    const pL = dbToPow(bestL);
    for (let k = 0; k < n; k++) {
      if (k === best || !cand[k]) continue;
      const pred = powToDb(pL * gPow[best * n + k]! + nz[k]!);
      const excess = e[k]! - pred;
      const m = margin[best * n + k]!;
      if (excess > m) {
        active[k]![f] = 2;
        confidence[k]![f] = Math.min(0.95, 0.5 + (excess - m) / 12);
      }
    }
  }
  return { active, confidence, dominant, ambiguous, speechFrames, ambiguousFrames, absentFrames };
}
