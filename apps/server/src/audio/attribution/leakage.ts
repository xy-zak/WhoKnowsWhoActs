/**
 * The 4×4 leakage matrix: how much quieter (or louder) each seat's voice is on every other mic.
 *
 * `G[s][j]` (dB) is the level of seat s's voice on mic j minus its level on its own mic s, so
 * `G[s][s] = 0`. It folds together the acoustic path (distance, direction, headset or laptop mic)
 * and the gain difference between the two devices. Every entry is a **median over frames** in
 * which seat s is the only speaker, of the noise-corrected level difference
 *
 *     d = nc(E_j) − nc(E_s),   nc(E) = 10·log10(10^(E/10) − 10^(F/10))
 *
 * (power subtraction of each mic's noise floor F). When the leakage is below mic j's noise floor
 * most of the time, the entry is flagged `belowFloor` and acts as an upper bound. The robust
 * spread of `d` is kept as well: it sets how far a mic may exceed the predicted leakage before the
 * frame is called overlapping speech.
 *
 * **From calibration** (preferred). The facilitator-led calibration gives each seat a turn of
 * about 6 s to read a sentence while the others stay quiet; the server logs each turn's start and
 * end. Frames of seat s's turn in which its own mic is ≥ 10 dB above its floor form row s.
 *
 * **Estimated** (no calibration, or a seat's turn failed). Frames in which one mic leads all others
 * by ≥ 2 dB, is ≥ 15 dB above its floor and keeps the lead for at least 100 ms count as that seat
 * speaking alone. The lead is judged either by level above each mic's floor or by level relative to
 * each mic's typical speech level (its 95th percentile, i.e. its own participant's voice); both
 * cancel mic gain in different situations, so `analyse` runs both and keeps the less ambiguous
 * result. After a first attribution pass the rows are re-measured from frames attributed to a
 * single seat with good confidence (up to two EM-style refinements).
 *
 * **Quality per seat** (`CalibrationSeatQuality`): own level and SNR; the best other mic's level
 * and the raw margin `ownDb − bestOtherDb`; and the **gain-invariant margin**
 * `min_j −(G[s][j] + G[j][s]) / 2`. Gain differences cancel in that sum (a mic set 10 dB louder
 * raises G[s][j] and lowers G[j][s] by the same amount), and it is half the distance between the
 * "s speaks" and "j speaks" level patterns, i.e. what the attribution actually has to work with.
 * Headsets give 15–25 dB, laptops 3–10 dB; below `minMarginDb` (10 dB) the seat is flagged with
 * advice such as "move the mic closer or use a headset".
 *
 * `quickCalibrationCheck` runs the calibration part alone on the calibration window, from envelopes
 * already roughly on the server clock (±50 ms is plenty for 6 s turns). It takes milliseconds, so
 * the server can show the result in LIVE right after the last turn.
 */

import { fitClocks } from "./clock";
import {
  CENSOR_DB,
  dbAdd,
  median,
  NumberList,
  noiseCorrected,
  robustSigma,
  round,
  roundOrNull,
} from "./math";
import { constantNoiseFloor } from "./noiseFloor";
import type { Placement, SeatChannel } from "./timeline";
import { buildChannels, makeTimeline, typicalLevels } from "./timeline";
import {
  type AttributionOptions,
  type CalibrationIssue,
  type CalibrationReport,
  type CalibrationSeatQuality,
  type CalibrationTurn,
  DEAD_DB,
  HOP_MS,
  type LeakageReport,
  resolveOptions,
  SAMPLE_RATE,
  SILENCE_DB,
  type Timeline,
  type TrackInput,
} from "./types";

/**
 * How "one mic clearly dominates" is judged when estimating without calibration: by level above
 * the mic's own noise floor (`floor`), or by level relative to the mic's own typical speech level,
 * its 95th percentile (`p95`). The first fails when noise floors differ a lot, the second when one
 * mic is set so loud that another voice is its loudest sound; `analyse` tries both.
 */
export type DominanceRule = "floor" | "p95";

export type RowSource = "calibration" | "estimated" | "default" | "none";

/** Working form of the leakage matrix (row-major n×n, indexed by seat index). */
export interface LeakageModel {
  n: number;
  seats: number[];
  G: Float64Array;
  spread: Float64Array;
  censored: Uint8Array;
  rowSource: RowSource[];
  rowFrames: Int32Array;
}

export function emptyModel(seats: readonly number[]): LeakageModel {
  const n = seats.length;
  const G = new Float64Array(n * n).fill(Number.NaN);
  const spread = new Float64Array(n * n).fill(Number.NaN);
  for (let i = 0; i < n; i++) {
    G[i * n + i] = 0;
    spread[i * n + i] = 0;
  }
  return {
    n,
    seats: [...seats],
    G,
    spread,
    censored: new Uint8Array(n * n),
    rowSource: seats.map(() => "none"),
    rowFrames: new Int32Array(n),
  };
}

export function cloneModel(m: LeakageModel): LeakageModel {
  return {
    n: m.n,
    seats: [...m.seats],
    G: Float64Array.from(m.G),
    spread: Float64Array.from(m.spread),
    censored: Uint8Array.from(m.censored),
    rowSource: [...m.rowSource],
    rowFrames: Int32Array.from(m.rowFrames),
  };
}

const MIN_ROW_FRAMES = 20;

/** Measures row `s` from frames in which seat index `s` is taken to be the only speaker. */
export function measureRow(
  model: LeakageModel,
  channels: readonly SeatChannel[],
  s: number,
  frames: ArrayLike<number>,
  source: RowSource,
): boolean {
  const n = model.n;
  const cs = channels[s]!;
  if (frames.length < MIN_ROW_FRAMES) return false;
  const diffs = new NumberList(frames.length);
  let anyEntry = false;
  for (let j = 0; j < n; j++) {
    if (j === s) continue;
    const cj = channels[j]!;
    diffs.length = 0;
    let censored = 0;
    for (let k = 0; k < frames.length; k++) {
      const f = frames[k]!;
      const ej = cj.energyDb[f]!;
      const es = cs.energyDb[f]!;
      if (!(ej > DEAD_DB) || !(es > DEAD_DB)) continue;
      const fj = cj.floorDb[f]!;
      if (ej - fj < CENSOR_DB) censored++;
      diffs.push(noiseCorrected(ej, fj) - noiseCorrected(es, cs.floorDb[f]!));
    }
    const v = diffs.view();
    if (v.length < MIN_ROW_FRAMES) {
      model.G[s * n + j] = Number.NaN;
      model.spread[s * n + j] = Number.NaN;
      continue;
    }
    const g = median(v);
    model.G[s * n + j] = g;
    model.spread[s * n + j] = robustSigma(v, g);
    model.censored[s * n + j] = censored > 0.5 * v.length ? 1 : 0;
    anyEntry = true;
  }
  if (anyEntry) {
    model.rowSource[s] = source;
    model.rowFrames[s] = frames.length;
  }
  return anyEntry;
}

/** Fills every unknown entry of a measured row, and every unmeasured row, with a cautious default. */
export function fillDefaults(model: LeakageModel, channels: readonly SeatChannel[]): void {
  const n = model.n;
  const floors = channels.map((ch) => {
    const v: number[] = [];
    for (let f = 0; f < ch.energyDb.length; f += 10) if (ch.energyDb[f]! > DEAD_DB) v.push(ch.floorDb[f]!);
    return v.length ? median(v) : Number.NaN;
  });
  for (let s = 0; s < n; s++) {
    let filled = false;
    for (let j = 0; j < n; j++) {
      if (j === s || !Number.isNaN(model.G[s * n + j]!)) continue;
      // No measurement: assume −10 dB acoustically, corrected for the gain difference that the
      // two noise floors suggest (room noise is roughly the same at every seat).
      const gainDiff =
        Number.isFinite(floors[j]!) && Number.isFinite(floors[s]!) ? floors[j]! - floors[s]! : 0;
      model.G[s * n + j] = gainDiff - 10;
      model.spread[s * n + j] = 3;
      filled = true;
    }
    if (filled && model.rowSource[s] === "none") model.rowSource[s] = "default";
  }
}

/** Frame index range `[from, to)` whose frame centres fall in `[startTs, endTs)`. */
export function framesInWindow(tl: Timeline, startTs: number, endTs: number): [number, number] {
  const from = Math.max(0, Math.ceil((startTs - tl.t0) / tl.hopMs - 0.5));
  const to = Math.min(tl.frames, Math.ceil((endTs - tl.t0) / tl.hopMs - 0.5));
  return [from, Math.max(from, to)];
}

interface TurnStats {
  turnFrames: number;
  dataFrames: number;
  clippedFrames: number;
  active: Int32Array;
}

function turnStats(
  channels: readonly SeatChannel[],
  tl: Timeline,
  turns: readonly CalibrationTurn[],
  s: number,
  activeDb: number,
): TurnStats {
  const cs = channels[s]!;
  const active = new NumberList(1024);
  let turnFrames = 0;
  let dataFrames = 0;
  let clippedFrames = 0;
  for (const t of turns) {
    if (t.seat !== cs.seat) continue;
    const [from, to] = framesInWindow(tl, t.startTs, t.endTs);
    for (let f = from; f < to; f++) {
      turnFrames++;
      const e = cs.energyDb[f]!;
      if (!(e > DEAD_DB)) continue;
      dataFrames++;
      if (cs.clipped[f]) clippedFrames++;
      if (e - cs.floorDb[f]! >= activeDb) active.push(f);
    }
  }
  return { turnFrames, dataFrames, clippedFrames, active: Int32Array.from(active.view()) };
}

/**
 * Measures the calibrated rows of `model` from the turns and rates every seat that had a turn.
 * Rows of seats whose turn produced no usable speech stay unmeasured.
 */
export function measureCalibration(
  model: LeakageModel,
  channels: readonly SeatChannel[],
  tl: Timeline,
  turns: readonly CalibrationTurn[],
  opts: AttributionOptions,
): { seats: CalibrationSeatQuality[]; warnings: string[] } {
  const n = model.n;
  const stats: Array<TurnStats | null> = [];
  for (let s = 0; s < n; s++) {
    const hasTurn = turns.some((t) => t.seat === channels[s]!.seat);
    if (!hasTurn) {
      stats.push(null);
      continue;
    }
    const st = turnStats(channels, tl, turns, s, opts.calibrationActiveDb);
    stats.push(st);
    if (st.active.length >= opts.minCalibrationFrames)
      measureRow(model, channels, s, st.active, "calibration");
  }
  const seats: CalibrationSeatQuality[] = [];
  const warnings: string[] = [];
  for (let s = 0; s < n; s++) {
    const st = stats[s];
    if (!st) continue;
    const q = rateSeat(model, channels, tl, turns, s, st, opts);
    seats.push(q);
    if (!q.ok && q.advice) warnings.push(`Seat ${q.seat} calibration: ${q.advice}`);
  }
  return { seats, warnings };
}

function rateSeat(
  model: LeakageModel,
  channels: readonly SeatChannel[],
  tl: Timeline,
  turns: readonly CalibrationTurn[],
  s: number,
  st: TurnStats,
  opts: AttributionOptions,
): CalibrationSeatQuality {
  const n = model.n;
  const cs = channels[s]!;
  const issues: CalibrationIssue[] = [];
  const measured = model.rowSource[s] === "calibration";
  let ownDb: number | null = null;
  let snrDb: number | null = null;
  let bestOtherDb: number | null = null;
  let bestOtherSeat: number | null = null;
  let rawMarginDb: number | null = null;
  let marginDb: number | null = null;
  let othersActiveShare = 0;
  const clippingShare = st.dataFrames ? st.clippedFrames / st.dataFrames : 0;
  if (st.dataFrames < 0.5 * st.turnFrames || st.turnFrames === 0) issues.push("no_signal");
  else if (st.active.length < opts.minCalibrationFrames) issues.push("not_enough_speech");
  if (st.active.length > 0) {
    const lv = new Float64Array(st.active.length);
    const sn = new Float64Array(st.active.length);
    st.active.forEach((f, k) => {
      lv[k] = cs.energyDb[f]!;
      sn[k] = cs.energyDb[f]! - cs.floorDb[f]!;
    });
    ownDb = median(lv);
    snrDb = median(sn);
  }
  if (measured && ownDb !== null) {
    let maxG = Number.NEGATIVE_INFINITY;
    let minMargin = Number.POSITIVE_INFINITY;
    for (let j = 0; j < n; j++) {
      if (j === s) continue;
      const g = model.G[s * n + j]!;
      if (Number.isNaN(g)) continue;
      if (g > maxG) {
        maxG = g;
        bestOtherSeat = channels[j]!.seat;
      }
      const back = model.rowSource[j] === "calibration" ? model.G[j * n + s]! : Number.NaN;
      const m = Number.isNaN(back) ? -g : -(g + back) / 2;
      if (m < minMargin) minMargin = m;
    }
    if (Number.isFinite(maxG)) {
      bestOtherDb = ownDb + maxG;
      rawMarginDb = -maxG;
    }
    if (Number.isFinite(minMargin)) marginDb = minMargin;
    // Did someone else talk during this turn? (another mic well above what this voice explains)
    let other = 0;
    let total = 0;
    for (const t of turns) {
      if (t.seat !== cs.seat) continue;
      const [from, to] = framesInWindow(tl, t.startTs, t.endTs);
      for (let f = from; f < to; f++) {
        const es = cs.energyDb[f]!;
        if (!(es > DEAD_DB)) continue;
        total++;
        const own = noiseCorrected(es, cs.floorDb[f]!);
        for (let k = 0; k < n; k++) {
          if (k === s) continue;
          const ck = channels[k]!;
          const ek = ck.energyDb[f]!;
          const g = model.G[s * n + k]!;
          if (!(ek > DEAD_DB) || Number.isNaN(g)) continue;
          if (ek - ck.floorDb[f]! < opts.activeMarginDb) continue;
          if (ek - dbAdd(own + g, ck.floorDb[f]!) > 10) {
            other++;
            break;
          }
        }
      }
    }
    othersActiveShare = total ? other / total : 0;
  }
  if (snrDb !== null && snrDb < opts.minSnrDb && !issues.includes("no_signal")) issues.push("too_quiet");
  if (marginDb !== null && marginDb < opts.minMarginDb) issues.push("low_margin");
  if (clippingShare > opts.maxClippingShare) issues.push("clipping");
  if (othersActiveShare > 0.15) issues.push("others_spoke");
  return {
    seat: cs.seat,
    frames: st.active.length,
    ownDb: roundOrNull(ownDb),
    snrDb: roundOrNull(snrDb),
    bestOtherDb: roundOrNull(bestOtherDb),
    bestOtherSeat,
    rawMarginDb: roundOrNull(rawMarginDb),
    marginDb: roundOrNull(marginDb),
    clippingShare: round(clippingShare, 4),
    othersActiveShare: round(othersActiveShare, 4),
    ok: issues.length === 0,
    issues,
    advice: adviceFor(issues, { snrDb, marginDb, opts }),
  };
}

function adviceFor(
  issues: readonly CalibrationIssue[],
  ctx: { snrDb: number | null; marginDb: number | null; opts: AttributionOptions },
): string | null {
  const first = issues[0];
  switch (first) {
    case undefined:
      return null;
    case "no_signal":
      return "no audio from this seat during its turn: check that the browser is recording and the mic is not muted.";
    case "not_enough_speech":
      return "too little speech during its turn: ask the participant to read the whole sentence aloud, then redo the calibration.";
    case "too_quiet":
      return `own voice only ${round(ctx.snrDb ?? 0, 1)} dB above the background noise (needs ${ctx.opts.minSnrDb} dB): move the mic closer or raise the input level.`;
    case "low_margin":
      return `own voice only +${round(ctx.marginDb ?? 0, 1)} dB over the other mics (needs ${ctx.opts.minMarginDb} dB): move the mic closer, sit further apart or use a headset.`;
    case "clipping":
      return "the mic clips (too loud): lower the input level or move the mic slightly away.";
    case "others_spoke":
      return "someone else spoke during this seat's turn: redo the calibration.";
  }
  return null;
}

/**
 * Seat-index labels for frames where one mic clearly dominates. Each mic's level is compared
 * relative to its own typical speech level (its 95th percentile, which is the participant's own
 * voice), so neither mic gain nor noise floor decides. The winner must also be ≥ 15 dB above its floor.
 */
function dominanceFrames(
  channels: readonly SeatChannel[],
  opts: AttributionOptions,
  rule: DominanceRule,
): NumberList[] {
  const n = channels.length;
  const frames = channels[0]?.energyDb.length ?? 0;
  const ref = typicalLevels(channels);
  const lists = channels.map(() => new NumberList(4096));
  let runSeat = -1;
  let runStart = 0;
  const flush = (end: number) => {
    if (runSeat < 0) return;
    const len = end - runStart;
    if (len < opts.estimateMinRunFrames) return;
    // Skip the edges of each run (transitions between speakers).
    for (let f = runStart + 2; f < end - 2; f++) lists[runSeat]!.push(f);
  };
  for (let f = 0; f < frames; f++) {
    let best = -1;
    let bestScore = Number.NEGATIVE_INFINITY;
    let second = Number.NEGATIVE_INFINITY;
    let bestSnr = 0;
    for (let j = 0; j < n; j++) {
      const e = channels[j]!.energyDb[f]!;
      if (!(e > DEAD_DB) || (rule === "p95" && Number.isNaN(ref[j]!))) continue;
      const score = rule === "p95" ? e - ref[j]! : e - channels[j]!.floorDb[f]!;
      if (score > bestScore) {
        second = bestScore;
        bestScore = score;
        best = j;
        bestSnr = e - channels[j]!.floorDb[f]!;
      } else if (score > second) second = score;
    }
    const label = best >= 0 && bestSnr >= opts.estimateMinSnrDb && bestScore - second >= 2 ? best : -1;
    if (label !== runSeat) {
      flush(f);
      runSeat = label;
      runStart = f;
    }
  }
  flush(frames);
  return lists;
}

const MIN_ESTIMATE_FRAMES = 200;

/** Estimates rows `rows` (seat indices) from frames where one mic clearly dominates. */
export function estimateRowsFromDominance(
  model: LeakageModel,
  channels: readonly SeatChannel[],
  rows: readonly number[],
  opts: AttributionOptions,
  rule: DominanceRule = "floor",
): void {
  if (rows.length === 0) return;
  const lists = dominanceFrames(channels, opts, rule);
  for (const s of rows) {
    const list = lists[s]!;
    if (list.length >= MIN_ESTIMATE_FRAMES) measureRow(model, channels, s, list.view(), "estimated");
  }
}

/** Frames attributed to seat `s` alone with good confidence (for re-estimating the leakage). */
export function confidentSingleFrames(
  channels: readonly SeatChannel[],
  dominant: Int8Array,
  active: readonly Uint8Array[],
  confidence: readonly Float32Array[],
  s: number,
): Float64Array {
  const n = channels.length;
  const cs = channels[s]!;
  const list = new NumberList(4096);
  for (let f = 0; f < dominant.length; f++) {
    if (dominant[f] !== s || confidence[s]![f]! < 0.5) continue;
    let alone = true;
    for (let k = 0; k < n; k++) {
      if (k !== s && active[k]![f]) {
        alone = false;
        break;
      }
    }
    if (!alone) continue;
    if (cs.energyDb[f]! - cs.floorDb[f]! < 12) continue;
    list.push(f);
  }
  return Float64Array.from(list.view());
}

export function leakageReport(
  model: LeakageModel,
  session: LeakageModel | null,
  changeOnlyFrom: "calibration" | null,
): LeakageReport {
  const n = model.n;
  const matrix = (m: LeakageModel, arr: Float64Array) =>
    Array.from({ length: n }, (_, s) =>
      Array.from({ length: n }, (_, j) => (m.rowSource[s] === "none" ? null : roundOrNull(arr[s * n + j]))),
    );
  let maxChange: number | null = null;
  if (session) {
    for (let s = 0; s < n; s++) {
      if (changeOnlyFrom && model.rowSource[s] !== changeOnlyFrom) continue;
      if (session.rowSource[s] !== "estimated") continue;
      for (let j = 0; j < n; j++) {
        if (j === s || model.censored[s * n + j] || session.censored[s * n + j]) continue;
        const a = model.G[s * n + j]!;
        const b = session.G[s * n + j]!;
        if (Number.isNaN(a) || Number.isNaN(b)) continue;
        const d = Math.abs(a - b);
        if (maxChange === null || d > maxChange) maxChange = d;
      }
    }
  }
  return {
    seats: [...model.seats],
    matrixDb: matrix(model, model.G),
    spreadDb: matrix(model, model.spread),
    belowFloor: Array.from({ length: n }, (_, s) =>
      Array.from({ length: n }, (_, j) => model.censored[s * n + j] === 1),
    ),
    source: model.rowSource.includes("calibration") ? "calibration" : "estimated",
    rowSource: model.rowSource.map((r) => (r === "none" ? "default" : r)),
    rowFrames: Array.from(model.rowFrames),
    sessionMatrixDb: session ? matrix(session, session.G) : null,
    maxChangeDb: roundOrNull(maxChange),
  };
}

/** One seat's envelope for the quick calibration check, already on (roughly) the server clock. */
export interface CalibrationChannel {
  seat: number;
  /** Server time of the start of frame 0 (ms). */
  t0: number;
  /** Frame hop (default 10 ms). */
  hopMs?: number;
  energyDb: Float32Array;
  clipped?: Uint8Array;
}

/**
 * Fast calibration check on just the calibration window: leakage rows from the turns and a
 * quality verdict per seat. Give it a little silence around the turns if you can (the noise floor
 * is the 5th percentile of each channel over the window).
 */
export function quickCalibrationCheck(
  channelsIn: readonly CalibrationChannel[],
  turns: readonly CalibrationTurn[],
  options?: Partial<AttributionOptions>,
): CalibrationReport {
  const started = performance.now();
  const opts = resolveOptions(options);
  const seats = [...new Set([...channelsIn.map((c) => c.seat), ...turns.map((t) => t.seat)])].sort(
    (a, b) => a - b,
  );
  const hop = HOP_MS;
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const c of channelsIn) {
    const h = c.hopMs ?? hop;
    start = Math.min(start, c.t0);
    end = Math.max(end, c.t0 + c.energyDb.length * h);
  }
  for (const t of turns) {
    start = Math.min(start, t.startTs);
    end = Math.max(end, t.endTs);
  }
  if (!Number.isFinite(start) || !(end > start)) start = end = 0;
  const t0 = Math.floor(start / hop) * hop;
  const tl: Timeline = { t0, hopMs: hop, frames: Math.max(0, Math.ceil((end - t0) / hop)) };
  const channels: SeatChannel[] = seats.map((seat) => ({
    seat,
    energyDb: new Float32Array(tl.frames).fill(Number.NaN),
    clipped: new Uint8Array(tl.frames),
    track: new Int16Array(tl.frames).fill(-1),
    floorDb: new Float32Array(tl.frames),
    overlapFrames: 0,
  }));
  for (const c of channelsIn) {
    const ch = channels[seats.indexOf(c.seat)]!;
    const h = c.hopMs ?? hop;
    for (let f = 0; f < tl.frames; f++) {
      const k = Math.round((t0 + (f + 0.5) * hop - c.t0) / h - 0.5);
      if (k < 0 || k >= c.energyDb.length) continue;
      const e = c.energyDb[k]!;
      if (Number.isNaN(e)) continue;
      ch.energyDb[f] = e;
      ch.clipped[f] = c.clipped?.[k] ?? 0;
      ch.track[f] = 0;
    }
  }
  const sparse: number[] = [];
  for (const ch of channels) {
    const floor = constantNoiseFloor(ch.energyDb, opts.floorPercentile);
    if (Number.isNaN(floor)) {
      // Too little audio from this seat so far to judge it: treat it as no data.
      if (ch.energyDb.some((e) => !Number.isNaN(e))) sparse.push(ch.seat);
      ch.energyDb.fill(Number.NaN);
      ch.floorDb.fill(SILENCE_DB);
    } else ch.floorDb.fill(floor);
  }
  const model = emptyModel(seats);
  const { seats: quality, warnings } = measureCalibration(model, channels, tl, turns, opts);
  for (const seat of sparse)
    warnings.push(`Seat ${seat}: not enough audio received yet to check the calibration.`);
  for (const seat of seats) {
    if (!turns.some((t) => t.seat === seat)) warnings.push(`Seat ${seat}: no calibration turn.`);
  }
  return {
    ok: quality.length > 0 && quality.every((q) => q.ok) && warnings.length === 0,
    seats: quality,
    leakage: leakageReport(model, null, null),
    warnings,
    elapsedMs: round(performance.now() - started, 1),
  };
}

/**
 * Builds the quick-check input from tracks (envelopes of whatever chunks have arrived), using the
 * same clock fit as the full analysis, limited to `[fromTs, toTs)`.
 */
export function calibrationChannelsFromTracks(
  tracks: readonly TrackInput[],
  fromTs: number,
  toTs: number,
): CalibrationChannel[] {
  const { fits } = fitClocks(
    tracks.map((t) => ({
      trackId: t.trackId,
      seat: t.seat,
      sampleRate: t.sampleRate ?? SAMPLE_RATE,
      chunks: t.chunks,
    })),
  );
  const seats = [...new Set(tracks.map((t) => t.seat))].sort((a, b) => a - b);
  const placements: Placement[] = [];
  for (const t of tracks) {
    const fit = fits.find((f) => f.trackId === t.trackId);
    if (!fit) continue;
    placements.push({
      trackId: t.trackId,
      seat: t.seat,
      seatIndex: seats.indexOf(t.seat),
      group: fit.group,
      sampleRate: fit.sampleRate,
      hopSamples: t.envelope.hopSamples,
      startTs: fit.startTs,
      msPerSample: fit.msPerSample,
      offsetMs: 0,
      samples: t.envelope.frames * t.envelope.hopSamples,
      envelope: t.envelope,
    });
  }
  const tl = makeTimeline(placements, HOP_MS, { fromTs, toTs });
  if (!tl) return [];
  const channels = buildChannels(seats, placements, tl, { windowFrames: 3000, percentile: 0.05 });
  return channels.map((ch) => ({
    seat: ch.seat,
    t0: tl.t0,
    hopMs: tl.hopMs,
    energyDb: ch.energyDb,
    clipped: ch.clipped,
  }));
}
