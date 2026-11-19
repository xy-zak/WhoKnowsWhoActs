/**
 * `analyse`: the whole offline attribution pipeline on envelopes (see `index.ts` for the overview).
 *
 * Stages (each timed in `timingsMs`): clock fit → timeline + noise floors → lag refinement →
 * re-mapping with the refined alignment → leakage matrix (calibration, else estimated) → frame
 * attribution (with one leakage refinement when it was estimated) → smoothing and segments →
 * quality report. It is synchronous and CPU-bound; run it in a `worker_thread`.
 */

import { driftFromMsPerSample, fitClocks, trackSampleEnd } from "./clock";
import { attributeFrames, type FrameDecisions } from "./frames";
import { measureLags, solveOffsets } from "./lag";
import {
  cloneModel,
  confidentSingleFrames,
  type DominanceRule,
  emptyModel,
  estimateRowsFromDominance,
  fillDefaults,
  type LeakageModel,
  leakageReport,
  measureCalibration,
  measureRow,
} from "./leakage";
import { median, round, roundOrNull } from "./math";
import { maskToRuns, segmentsFromMasks, smoothActivity } from "./smooth";
import { buildChannels, makeTimeline, type Placement, type SeatChannel, typicalLevels } from "./timeline";
import {
  type AnalysisHooks,
  type AnalysisInput,
  type AttributionOptions,
  type AttributionResult,
  type CalibrationSeatQuality,
  DEAD_DB,
  ENGINE_VERSION,
  HOP_MS,
  type LagPairReport,
  type LagReport,
  type QualityReport,
  resolveOptions,
  SAMPLE_RATE,
  type SeatQuality,
  type Timeline,
  type TrackAlignment,
} from "./types";

const MIN_REFINE_FRAMES = 200;

function emptyResult(seats: number[], opts: AttributionOptions, warnings: string[]): AttributionResult {
  const model = emptyModel(seats);
  return {
    engineVersion: ENGINE_VERSION,
    options: opts,
    timeline: { t0: 0, hopMs: HOP_MS, frames: 0, endTs: 0 },
    seats,
    alignment: [],
    leakage: leakageReport(model, null, null),
    segments: [],
    talkTimeMs: Object.fromEntries(seats.map((s) => [s, 0])),
    overlapMs: 0,
    masks: seats.map((seat) => ({ seat, runs: [] })),
    quality: {
      grade: "poor",
      calibration: null,
      leakageSource: "estimated",
      ambiguousFrameShare: 0,
      clippingShare: 0,
      noSignalShare: 1,
      absentSpeakerShare: 0,
      driftPpm: [],
      lag: { windows: 0, observations: 0, accepted: 0, residualRmsMs: null, pairs: [] },
      seats: seats.map((seat) => ({
        seat,
        tracks: 0,
        dataMs: 0,
        noDataShare: 1,
        deadShare: 0,
        noSignalShare: 1,
        clippingShare: 0,
        noiseFloorDb: null,
        speechLevelDb: null,
        snrDb: null,
        talkTimeMs: 0,
        overlapMs: 0,
        ambiguousShare: 0,
      })),
      warnings: [...warnings, "No audio to analyse."],
    },
    timingsMs: {},
  };
}

/** Gain-invariant margin of seat s from the matrix: min_j −(G[s][j] + G[j][s]) / 2. */
function marginOf(model: LeakageModel, s: number): number | null {
  const n = model.n;
  let m = Number.POSITIVE_INFINITY;
  for (let j = 0; j < n; j++) {
    if (j === s) continue;
    const a = model.G[s * n + j]!;
    const b = model.G[j * n + s]!;
    if (Number.isNaN(a) || Number.isNaN(b)) continue;
    m = Math.min(m, -(a + b) / 2);
  }
  return Number.isFinite(m) ? m : null;
}

/**
 * Fills the rows `toEstimate` (by `rule`), attributes the frames, and refines estimated or default
 * rows from the session's own confident single-speaker frames (up to twice). The final session rows
 * are returned as well, for the calibration consistency check.
 */
function attributeWithModel(
  model: LeakageModel,
  channels: readonly SeatChannel[],
  hasData: readonly boolean[],
  toEstimate: readonly number[],
  rule: DominanceRule,
  opts: AttributionOptions,
  typical: readonly number[],
): { model: LeakageModel; dec: FrameDecisions; session: LeakageModel; defaulted: boolean[] } {
  estimateRowsFromDominance(model, channels, toEstimate, opts, rule);
  const defaulted = model.rowSource.map((r) => r === "none");
  fillDefaults(model, channels);
  let dec = attributeFrames(channels, model, opts, typical);
  const n = model.n;
  const measureSession = (d: FrameDecisions): LeakageModel => {
    const m = emptyModel(model.seats);
    for (let s = 0; s < n; s++) {
      if (!hasData[s]) continue;
      const frames = confidentSingleFrames(channels, d.dominant, d.active, d.confidence, s);
      if (frames.length >= MIN_REFINE_FRAMES) measureRow(m, channels, s, frames, "estimated");
    }
    return m;
  };
  let session = measureSession(dec);
  for (let iter = 0; iter < 2; iter++) {
    const refine: number[] = [];
    for (let s = 0; s < n; s++) {
      if ((model.rowSource[s] === "estimated" || defaulted[s]) && session.rowSource[s] === "estimated")
        refine.push(s);
    }
    if (!refine.length) break;
    let change = 0;
    for (const s of refine) {
      for (let j = 0; j < n; j++) {
        const g = session.G[s * n + j]!;
        if (Number.isNaN(g)) continue;
        change = Math.max(change, Math.abs(g - model.G[s * n + j]!));
        model.G[s * n + j] = g;
        model.spread[s * n + j] = session.spread[s * n + j]!;
        model.censored[s * n + j] = session.censored[s * n + j]!;
      }
      model.rowSource[s] = "estimated";
      model.rowFrames[s] = session.rowFrames[s]!;
      defaulted[s] = false;
    }
    dec = attributeFrames(channels, model, opts, typical);
    session = measureSession(dec); // always from the final decisions
    if (change < 0.5) break;
  }
  return { model, dec, session, defaulted };
}

export function analyse(input: AnalysisInput, hooks: AnalysisHooks = {}): AttributionResult {
  const opts = resolveOptions(input.options);
  const timings: Record<string, number> = {};
  let mark = performance.now();
  const lap = (stage: string, fraction: number) => {
    const now = performance.now();
    timings[stage] = round(now - mark, 1);
    mark = now;
    hooks.onProgress?.({ stage, fraction });
  };
  const warnings: string[] = [];
  const seats = [...new Set([...(input.seats ?? []), ...input.tracks.map((t) => t.seat)])].sort(
    (a, b) => a - b,
  );

  // 1. Clock fit per track.
  const usable = input.tracks.filter((t) => {
    if (t.envelope.frames > 0) return true;
    warnings.push(`Seat ${t.seat}: track ${t.trackId.slice(0, 8)} has no audio and was skipped.`);
    return false;
  });
  const clock = fitClocks(
    usable.map((t) => ({
      trackId: t.trackId,
      seat: t.seat,
      sampleRate: t.sampleRate ?? SAMPLE_RATE,
      chunks: t.chunks,
    })),
    { maxPlausibleDriftPpm: opts.maxPlausibleDriftPpm },
  );
  warnings.push(...clock.warnings);
  const fitById = new Map(clock.fits.map((f) => [f.trackId, f]));
  const placements: Placement[] = [];
  for (const t of usable) {
    const fit = fitById.get(t.trackId);
    if (!fit) continue;
    let samples = trackSampleEnd(t.chunks);
    if (!(samples > 0)) samples = t.envelope.frames * t.envelope.hopSamples;
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
      samples,
      envelope: t.envelope,
    });
  }
  lap("clock", 0.05);

  let tl = makeTimeline(placements, HOP_MS, input.window);
  if (!tl) return emptyResult(seats, opts, warnings);
  const floorOpts = {
    windowFrames: Math.round((opts.floorWindowSec * 1000) / HOP_MS),
    percentile: opts.floorPercentile,
  };
  let channels = buildChannels(seats, placements, tl, floorOpts);
  lap("timeline", 0.15);

  // 2. Lag refinement by envelope cross-correlation.
  const lagMeasure = measureLags(channels, tl, {
    windowSec: opts.lagWindowSec,
    maxLagMs: opts.lagMaxMs,
    minCorr: opts.lagMinCorr,
  });
  const dataFrames = placements.map(() => 0);
  for (const ch of channels) {
    for (let f = 0; f < tl.frames; f++) {
      const t = ch.track[f]!;
      if (t >= 0 && !Number.isNaN(ch.energyDb[f]!)) dataFrames[t]!++;
    }
  }
  let anchor = 0;
  dataFrames.forEach((n, i) => {
    if (n > dataFrames[anchor]!) anchor = i;
  });
  const groupSigma = new Map<string, number>();
  for (const f of clock.fits) groupSigma.set(f.group, f.driftSigmaPpm);
  const solution = solveOffsets(placements, groupSigma, lagMeasure.observations, anchor);
  placements.forEach((p, i) => {
    const eps = (solution.epsPpm.get(p.group) ?? 0) * 1e-6;
    const tc = solution.groupCentre.get(p.group) ?? 0;
    const S = p.startTs + p.offsetMs;
    const S2 = S - solution.offsets[i]! - eps * (S - tc);
    p.msPerSample *= 1 - eps;
    p.offsetMs = S2 - p.startTs;
  });
  lap("lag", 0.3);

  // 3. Re-map with the refined alignment.
  tl = makeTimeline(placements, HOP_MS, input.window) ?? tl;
  channels = buildChannels(seats, placements, tl, floorOpts);
  lap("remap", 0.45);

  // 4. Leakage matrix.
  const model = emptyModel(seats);
  const turns = input.calibration?.turns ?? [];
  let calibration: CalibrationSeatQuality[] | null = null;
  if (turns.length) {
    const r = measureCalibration(model, channels, tl, turns, opts);
    calibration = r.seats;
    warnings.push(...r.warnings);
    // A turn in which someone else spoke does not measure this seat's leakage: estimate instead.
    for (const q of r.seats) {
      if (!q.issues.includes("others_spoke")) continue;
      const s = seats.indexOf(q.seat);
      const fresh = emptyModel(seats);
      for (let j = 0; j < model.n; j++) {
        model.G[s * model.n + j] = fresh.G[s * model.n + j]!;
        model.spread[s * model.n + j] = fresh.spread[s * model.n + j]!;
        model.censored[s * model.n + j] = 0;
      }
      model.rowSource[s] = "none";
      model.rowFrames[s] = 0;
    }
  } else {
    warnings.push(
      "No calibration: the leakage matrix was estimated from the session itself (less reliable, especially with laptop mics).",
    );
  }
  const hasData = channels.map((ch) => ch.energyDb.some((e) => e > DEAD_DB));
  const typical = typicalLevels(channels);
  const toEstimate = seats.map((_, s) => s).filter((s) => hasData[s] && model.rowSource[s] === "none");
  lap("leakage", 0.55);

  // 5. Frame attribution. Rows that had to be estimated are tried with both labelling rules and
  // refined from the session (EM-style); the least ambiguous result wins.
  const runs = (toEstimate.length ? (["floor", "p95"] as const) : (["floor"] as const)).map((rule) =>
    attributeWithModel(cloneModel(model), channels, hasData, toEstimate, rule, opts, typical),
  );
  const score = (r: (typeof runs)[number]) =>
    r.dec.speechFrames ? r.dec.ambiguousFrames / r.dec.speechFrames : 0;
  const chosen = runs.reduce((x, y) => (score(y) < score(x) ? y : x));
  const { dec, session, defaulted } = chosen;
  const finalModel = chosen.model;
  lap("frames", 0.8);

  // 6. Smoothing, masks and segments.
  const hop = tl.hopMs;
  const smoothing = {
    minGap: Math.round(opts.minGapMs / hop),
    minSpeech: Math.round(opts.minSpeechMs / hop),
    hangover: Math.round(opts.hangoverMs / hop),
    preRoll: Math.round(opts.preRollMs / hop),
  };
  const valid = channels.map((ch) => {
    const v = new Uint8Array(tl.frames);
    for (let f = 0; f < tl.frames; f++) v[f] = ch.energyDb[f]! > DEAD_DB ? 1 : 0;
    return v;
  });
  const masks = channels.map((_, s) => {
    const blocked = new Uint8Array(tl.frames);
    for (let f = 0; f < tl.frames; f++) {
      const d = dec.dominant[f]!;
      if (d >= 0 && d !== s) blocked[f] = 1;
    }
    return smoothActivity(dec.active[s]!, valid[s]!, blocked, smoothing);
  });
  const segments = segmentsFromMasks(masks, channels, dec.active, dec.confidence, tl);
  let overlapFrames = 0;
  for (let f = 0; f < tl.frames; f++) {
    let k = 0;
    for (const m of masks) k += m[f]!;
    if (k >= 2) overlapFrames++;
  }
  lap("smoothing", 0.9);

  // 7. Alignment and quality report.
  const alignment: TrackAlignment[] = placements.map((p, i) => {
    const fit = fitById.get(p.trackId)!;
    const per = solution.perPlacement[i]!;
    return {
      trackId: p.trackId,
      seat: p.seat,
      startTs: round(p.startTs, 3),
      offsetMs: round(p.offsetMs, 3),
      driftPpm: round(driftFromMsPerSample(p.msPerSample, p.sampleRate), 3),
      clockDriftPpm: round(fit.driftPpm, 3),
      msPerSample: p.msPerSample,
      samples: p.samples,
      alignedStartTs: round(p.startTs + p.offsetMs, 3),
      alignedEndTs: round(p.startTs + p.offsetMs + p.samples * p.msPerSample, 3),
      confidence: round(per.confidence, 3),
      anchor: i === anchor,
      clockGroup: fit.group,
      clockResidualMs: round(fit.residualRmsMs, 2),
      clockOutliers: fit.outliers,
      lagObservations: per.observations,
      lagResidualMs: roundOrNull(per.residualRmsMs),
    };
  });
  const sessionCheck = finalModel.rowSource.includes("calibration") ? session : null;
  const leakage = leakageReport(finalModel, sessionCheck, sessionCheck ? "calibration" : null);
  if (leakage.maxChangeDb !== null && leakage.maxChangeDb > opts.leakageChangeWarnDb) {
    warnings.push(
      `The leakage during the session differs from the calibration by up to ${round(leakage.maxChangeDb, 1)} dB (did people or mics move?).`,
    );
  }
  const quality = qualityReport({
    channels,
    tl,
    masks,
    dec,
    model: finalModel,
    defaulted,
    placements,
    alignment,
    calibration,
    lag: lagReport(lagMeasure, solution.residualRmsMs),
    warnings,
    opts,
  });
  const talkTimeMs: Record<number, number> = {};
  for (const q of quality.seats) talkTimeMs[q.seat] = q.talkTimeMs;
  lap("quality", 1);
  return {
    engineVersion: ENGINE_VERSION,
    options: opts,
    timeline: { t0: tl.t0, hopMs: tl.hopMs, frames: tl.frames, endTs: tl.t0 + tl.frames * tl.hopMs },
    seats,
    alignment,
    leakage,
    segments,
    talkTimeMs,
    overlapMs: overlapFrames * hop,
    masks: masks.map((m, s) => ({ seat: seats[s]!, runs: maskToRuns(m) })),
    quality,
    timingsMs: timings,
  };
}

function lagReport(measured: ReturnType<typeof measureLags>, residualRmsMs: number | null): LagReport {
  const pairs = new Map<
    string,
    { seatA: number; seatB: number; lags: number[]; corr: number[]; windows: number }
  >();
  for (const o of measured.observations) {
    const key = `${o.seatA}:${o.seatB}`;
    const p = pairs.get(key) ?? { seatA: o.seatA, seatB: o.seatB, lags: [], corr: [], windows: 0 };
    p.windows++;
    if (o.accepted) {
      p.lags.push(o.lagMs);
      p.corr.push(o.corr);
    }
    pairs.set(key, p);
  }
  const list: LagPairReport[] = [...pairs.values()].map((p) => ({
    seatA: p.seatA,
    seatB: p.seatB,
    windows: p.windows,
    accepted: p.lags.length,
    medianLagMs: p.lags.length ? round(median(p.lags), 2) : null,
    meanCorr: p.corr.length ? round(p.corr.reduce((a, b) => a + b, 0) / p.corr.length, 3) : null,
  }));
  return {
    windows: measured.windows,
    observations: measured.observations.length,
    accepted: measured.observations.filter((o) => o.accepted).length,
    residualRmsMs: roundOrNull(residualRmsMs),
    pairs: list,
  };
}

function qualityReport(ctx: {
  channels: readonly SeatChannel[];
  tl: Timeline;
  masks: readonly Uint8Array[];
  dec: FrameDecisions;
  model: LeakageModel;
  defaulted: readonly boolean[];
  placements: readonly Placement[];
  alignment: readonly TrackAlignment[];
  calibration: CalibrationSeatQuality[] | null;
  lag: LagReport;
  warnings: string[];
  opts: AttributionOptions;
}): QualityReport {
  const { channels, tl, masks, dec, model, opts, warnings } = ctx;
  const frames = tl.frames;
  let clippedAll = 0;
  let validAll = 0;
  const seats: SeatQuality[] = channels.map((ch, s) => {
    let validN = 0;
    let deadN = 0;
    let clipped = 0;
    let talk = 0;
    let overlap = 0;
    let dom = 0;
    let amb = 0;
    let gaps = 0;
    let inGap = false;
    const floors: number[] = [];
    const speech: number[] = [];
    for (let f = 0; f < frames; f++) {
      const e = ch.energyDb[f]!;
      const missing = Number.isNaN(e);
      if (missing) {
        if (!inGap) gaps++;
        inGap = true;
      } else inGap = false;
      if (!missing && e > DEAD_DB) {
        validN++;
        if (ch.clipped[f]) clipped++;
        if (f % 10 === 0) floors.push(ch.floorDb[f]!);
      } else if (!missing) deadN++;
      if (masks[s]![f]) {
        talk++;
        for (let k = 0; k < masks.length; k++) {
          if (k !== s && masks[k]![f]) {
            overlap++;
            break;
          }
        }
        if (dec.active[s]![f] === 1 && speech.length < 200_000) speech.push(e);
      }
      if (dec.dominant[f] === s) {
        dom++;
        if (dec.ambiguous[f]) amb++;
      }
    }
    clippedAll += clipped;
    validAll += validN;
    const noData = frames - validN - deadN;
    const noiseFloorDb = floors.length ? median(floors) : null;
    const speechLevelDb = speech.length ? median(speech) : null;
    const q: SeatQuality = {
      seat: ch.seat,
      tracks: ctx.placements.filter((p) => p.seatIndex === s).length,
      dataMs: (validN + deadN) * tl.hopMs,
      noDataShare: round(noData / frames, 4),
      deadShare: round(deadN / frames, 4),
      noSignalShare: round((noData + deadN) / frames, 4),
      clippingShare: round(validN ? clipped / validN : 0, 4),
      noiseFloorDb: roundOrNull(noiseFloorDb),
      speechLevelDb: roundOrNull(speechLevelDb),
      snrDb: roundOrNull(
        speechLevelDb !== null && noiseFloorDb !== null ? speechLevelDb - noiseFloorDb : null,
      ),
      talkTimeMs: talk * tl.hopMs,
      overlapMs: overlap * tl.hopMs,
      ambiguousShare: round(dom ? amb / dom : 0, 4),
    };
    if (validN === 0) {
      warnings.push(
        `Seat ${ch.seat}: no audio at all; this seat's speech cannot be attributed (its voice may be credited to a neighbour).`,
      );
    } else {
      if (q.noSignalShare > 0.05) {
        warnings.push(
          `Seat ${ch.seat}: no usable audio for ${round(q.noSignalShare * 100, 1)} % of the session (${gaps} gap${gaps === 1 ? "" : "s"}).`,
        );
      }
      if (q.clippingShare > opts.clippingWarnShare) {
        warnings.push(
          `Seat ${ch.seat}: clipping in ${round(q.clippingShare * 100, 2)} % of frames; lower its input level.`,
        );
      }
      if (ctx.defaulted[s]) {
        warnings.push(
          `Seat ${ch.seat}: its leakage could not be measured (it hardly spoke); a default was used.`,
        );
      }
      if (model.rowSource[s] !== "calibration") {
        const m = marginOf(model, s);
        if (m !== null && m < opts.minMarginDb) {
          warnings.push(
            `Seat ${ch.seat}: own voice only +${round(m, 1)} dB over the other mics (estimated; needs ${opts.minMarginDb} dB): attribution is less reliable.`,
          );
        }
      }
      if (ch.overlapFrames > 10) {
        warnings.push(
          `Seat ${ch.seat}: two of its tracks overlap in time by ${ch.overlapFrames * tl.hopMs} ms.`,
        );
      }
    }
    return q;
  });
  const ambiguousFrameShare = dec.speechFrames ? dec.ambiguousFrames / dec.speechFrames : 0;
  if (ambiguousFrameShare > opts.ambiguousWarnShare) {
    warnings.push(
      `${round(ambiguousFrameShare * 100, 1)} % of speech frames were ambiguous (mics hear each other too similarly).`,
    );
  }
  const withData = channels.filter((_, s) => seats[s]!.noSignalShare < 1).length;
  if (withData > 1 && ctx.lag.accepted === 0) {
    warnings.push(
      "Lag refinement found no shared sound between the mics; alignment relies on client timestamps only (±20–50 ms).",
    );
  } else if (ctx.lag.residualRmsMs !== null && ctx.lag.residualRmsMs > 10) {
    warnings.push(`Mic alignment is uncertain (residual ${round(ctx.lag.residualRmsMs, 1)} ms RMS).`);
  }
  for (const a of ctx.alignment) {
    if (Math.abs(a.driftPpm) > 300) {
      warnings.push(`Seat ${a.seat}: unusually large clock drift (${round(a.driftPpm, 0)} ppm).`);
    }
  }
  const absentSpeakerShare = dec.speechFrames ? dec.absentFrames / dec.speechFrames : 0;
  const noSignalShare = seats.length ? seats.reduce((a, q) => a + q.noSignalShare, 0) / seats.length : 1;
  const lowMargins = [
    ...(ctx.calibration ?? []).map((q) => q.marginDb),
    ...channels.map((_, s) => (model.rowSource[s] === "calibration" ? null : marginOf(model, s))),
  ].filter((m): m is number => m !== null);
  const poor =
    withData === 0 ||
    noSignalShare > 0.5 ||
    ambiguousFrameShare > 0.25 ||
    lowMargins.some((m) => m < opts.minMarginDb / 2);
  return {
    grade: poor ? "poor" : warnings.length ? "fair" : "good",
    calibration: ctx.calibration,
    leakageSource: model.rowSource.includes("calibration") ? "calibration" : "estimated",
    ambiguousFrameShare: round(ambiguousFrameShare, 4),
    clippingShare: round(validAll ? clippedAll / validAll : 0, 4),
    noSignalShare: round(noSignalShare, 4),
    absentSpeakerShare: round(absentSpeakerShare, 4),
    driftPpm: ctx.alignment.map((a) => ({ trackId: a.trackId, seat: a.seat, driftPpm: a.driftPpm })),
    lag: ctx.lag,
    seats,
    warnings: [...warnings],
  };
}
