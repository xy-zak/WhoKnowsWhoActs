/**
 * `analyse`: the offline attribution pipeline on track features (overview in `index.ts`).
 *
 * clock fit per track → one 10 ms timeline per seat → noise floors → speech per mic (detector with
 * hysteresis, or energy above the floor) → leakage (calibration, else a conservative default) →
 * cross-channel gate → smoothing → segments, talk time, overlap → quality report.
 * Synchronous and CPU-light (well under a second per session hour); it runs in the job worker.
 */

import { AUDIO_SAMPLE_RATE } from "@wkwa/shared";
import { alignTrack, fitClock, median, trackSampleEnd } from "./clock";
import { maskToRuns, segmentsFromMasks, smoothSpeech } from "./smooth";
import {
  type AnalysisInput,
  type AttributionOptions,
  type AttributionResult,
  type CalibrationIssue,
  type CalibrationReport,
  type CalibrationSeatQuality,
  type CalibrationTurn,
  DEAD_DB,
  ENGINE_VERSION,
  HOP_MS,
  HOP_SAMPLES,
  type LeakageReport,
  resolveOptions,
  type SeatQuality,
  type Timeline,
  type TrackAlignment,
  type TrackInput,
} from "./types";

const round = (v: number, digits = 2) => Math.round(v * 10 ** digits) / 10 ** digits;
const roundOrNull = (v: number | null, digits = 2) => (v === null ? null : round(v, digits));

/** A leakage matrix with nothing measured: 0 on the diagonal, null elsewhere. */
const unmeasuredLeakage = (seats: readonly number[]): (number | null)[][] =>
  seats.map((_, s) => seats.map((_, j) => (s === j ? 0 : null)));

/** One seat's features on the session timeline (`NaN` = no data). */
export interface SeatChannel {
  seat: number;
  energyDb: Float32Array;
  clipped: Uint8Array;
  /** Speech probability, `NaN` where no detector ran or no data. */
  speech: Float32Array;
  floorDb: number;
}

/* ─────────── timeline ─────────── */

/** Clock fits, the timeline and each seat's channel. Where two tracks of a seat overlap, the earlier one wins. */
export function placeTracks(
  tracks: readonly TrackInput[],
  seats: readonly number[],
  opts: AttributionOptions,
  window?: { fromTs: number; toTs: number } | null,
): { alignment: TrackAlignment[]; timeline: Timeline | null; channels: SeatChannel[]; warnings: string[] } {
  const warnings: string[] = [];
  const placed: Array<{ a: TrackAlignment; t: TrackInput }> = [];
  for (const t of tracks) {
    if (t.features.frames === 0) {
      warnings.push(`Seat ${t.seat}: track ${t.trackId.slice(0, 8)} has no audio and was skipped.`);
      continue;
    }
    const sampleRate = t.sampleRate ?? AUDIO_SAMPLE_RATE;
    const fit = fitClock({ ...t, sampleRate }, opts.maxPlausibleDriftPpm);
    if (!fit) continue;
    if (fit.implausible)
      warnings.push(`Seat ${t.seat}: implausible timestamps on a track; its nominal sample rate was used.`);
    placed.push({ t, a: alignTrack(fit, trackSampleEnd(t.chunks) || t.features.frames * HOP_SAMPLES) });
  }
  placed.sort((x, y) => x.a.startTs - y.a.startTs);
  const alignment = placed.map((p) => p.a);
  if (!placed.length) return { alignment, timeline: null, channels: [], warnings };
  const t0 = window?.fromTs ?? Math.min(...alignment.map((a) => a.startTs));
  const end = window?.toTs ?? Math.max(...alignment.map((a) => a.endTs));
  const frames = Math.max(0, Math.ceil((end - t0) / HOP_MS));
  const timeline = frames > 0 ? { t0, hopMs: HOP_MS, frames } : null;
  const channels = seats.map((seat) => {
    const energyDb = new Float32Array(frames).fill(Number.NaN);
    const speech = new Float32Array(frames).fill(Number.NaN);
    const clipped = new Uint8Array(frames);
    for (const { a, t } of placed) {
      if (a.seat !== seat) continue;
      const f = t.features;
      const fa = Math.max(0, Math.floor((a.startTs - t0) / HOP_MS));
      const fb = Math.min(frames, Math.ceil((a.endTs - t0) / HOP_MS));
      for (let i = fa; i < fb; i++) {
        if (!Number.isNaN(energyDb[i]!)) continue; // an earlier track covers it
        const k = Math.floor((t0 + (i + 0.5) * HOP_MS - a.startTs) / a.msPerSample / HOP_SAMPLES);
        if (k < 0 || k >= f.frames || Number.isNaN(f.energyDb[k]!)) continue;
        energyDb[i] = f.energyDb[k]!;
        clipped[i] = f.clipped[k]!;
        speech[i] = f.speech ? f.speech[k]! : Number.NaN;
      }
    }
    return { seat, energyDb, speech, clipped, floorDb: noiseFloor(energyDb, opts.floorPercentile) };
  });
  return { alignment, timeline, channels, warnings };
}

function noiseFloor(energyDb: Float32Array, percentile: number): number {
  const live = Array.from(energyDb).filter((e) => e > DEAD_DB);
  if (!live.length) return Number.NaN;
  live.sort((a, b) => a - b);
  return live[Math.min(live.length - 1, Math.floor(percentile * live.length))]!;
}

/* ─────────── calibration: leakage ─────────── */

/**
 * Measures the leakage matrix from the calibration turns (each seat reads while the others listen)
 * and judges each seat. `L[s][j]` = median over the reader's clearly active frames of
 * `E_j − E_s`. A leak below mic j's noise floor reads as the floor: an upper bound, which only
 * makes the gate stricter.
 */
export function measureCalibration(
  channels: readonly SeatChannel[],
  tl: Timeline,
  turns: readonly CalibrationTurn[],
  opts: AttributionOptions,
): CalibrationReport {
  const n = channels.length;
  const seats = channels.map((c) => c.seat);
  const L = unmeasuredLeakage(seats);
  const rows: Array<Omit<CalibrationSeatQuality, "marginDb" | "ok" | "advice"> | null> = seats.map(
    () => null,
  );
  for (const turn of turns) {
    const s = seats.indexOf(turn.seat);
    if (s < 0) continue;
    const ch = channels[s]!;
    const fa = Math.max(0, Math.floor((turn.startTs - tl.t0) / tl.hopMs));
    const fb = Math.min(tl.frames, Math.ceil((turn.endTs - tl.t0) / tl.hopMs));
    const active: number[] = [];
    let data = 0;
    let clipped = 0;
    for (let f = fa; f < fb; f++) {
      const e = ch.energyDb[f]!;
      if (!(e > DEAD_DB)) continue;
      data++;
      if (e >= ch.floorDb + opts.calibrationActiveDb) {
        active.push(f);
        clipped += ch.clipped[f]!;
      }
    }
    const issues: CalibrationIssue[] = [];
    if (data === 0) issues.push("no_signal");
    else if (active.length < opts.minCalibrationFrames) issues.push("not_enough_speech");
    const ownDb = active.length ? median(active.map((f) => ch.energyDb[f]!)) : null;
    let bestOtherDb: number | null = null;
    let bestOtherSeat: number | null = null;
    if (active.length >= opts.minCalibrationFrames) {
      for (let j = 0; j < n; j++) {
        if (j === s) continue;
        const other = channels[j]!.energyDb;
        const heard = active.filter((f) => other[f]! > DEAD_DB);
        if (heard.length < opts.minCalibrationFrames / 2) continue;
        L[s]![j] = round(median(heard.map((f) => other[f]! - ch.energyDb[f]!)), 1);
        const level = median(heard.map((f) => other[f]!));
        if (bestOtherDb === null || level > bestOtherDb) {
          bestOtherDb = level;
          bestOtherSeat = seats[j]!;
        }
      }
    }
    const snrDb = ownDb !== null && Number.isFinite(ch.floorDb) ? ownDb - ch.floorDb : null;
    if (snrDb !== null && snrDb < opts.minSnrDb) issues.push("too_quiet");
    const clippingShare = active.length ? clipped / active.length : 0;
    if (clippingShare > opts.maxClippingShare) issues.push("clipping");
    rows[s] = {
      seat: turn.seat,
      frames: active.length,
      ownDb: roundOrNull(ownDb, 1),
      snrDb: roundOrNull(snrDb, 1),
      bestOtherDb: roundOrNull(bestOtherDb, 1),
      bestOtherSeat,
      clippingShare: round(clippingShare, 4),
      issues,
    };
  }
  const report: CalibrationSeatQuality[] = [];
  rows.forEach((row, s) => {
    if (!row) return;
    let margin = Number.POSITIVE_INFINITY;
    for (let j = 0; j < n; j++) {
      const out = L[s]![j];
      if (j === s || out === null || out === undefined) continue;
      const back = L[j]![s];
      margin = Math.min(margin, back === null || back === undefined ? -out : -(out + back) / 2);
    }
    const marginDb = Number.isFinite(margin) ? round(margin, 1) : null;
    const issues = [...row.issues];
    if (marginDb !== null && marginDb < opts.minMarginDb) issues.push("low_margin");
    report.push({
      ...row,
      marginDb,
      issues,
      ok: issues.length === 0,
      advice: adviceFor(row.seat, issues, marginDb),
    });
  });
  const measured = report.some((q) => q.frames >= opts.minCalibrationFrames);
  const warnings = report.filter((q) => q.advice).map((q) => q.advice!);
  return {
    ok: report.length > 0 && report.every((q) => q.ok),
    seats: report,
    leakage: { seats, matrixDb: L, source: measured ? "calibration" : "default" },
    warnings,
  };
}

function adviceFor(seat: number, issues: CalibrationIssue[], marginDb: number | null): string | null {
  if (issues.includes("no_signal"))
    return `Seat ${seat}: no audio during its calibration turn; check the headset is plugged in.`;
  if (issues.includes("not_enough_speech"))
    return `Seat ${seat}: too little speech in its calibration turn; redo it.`;
  if (issues.includes("low_margin"))
    return `Seat ${seat}: own voice only +${marginDb} dB over the other mics; check the headset is selected and its mic sits at the corner of the mouth.`;
  if (issues.includes("too_quiet"))
    return `Seat ${seat}: own voice is close to the noise; move the headset mic closer to the mouth.`;
  if (issues.includes("clipping")) return `Seat ${seat}: the voice clips; lower the input level.`;
  return null;
}

/** Calibration check alone, on tracks covering the calibration window (live, in milliseconds). */
export function quickCalibrationCheck(
  tracks: readonly TrackInput[],
  turns: readonly CalibrationTurn[],
  window: { fromTs: number; toTs: number },
  options?: Partial<AttributionOptions>,
): CalibrationReport {
  const opts = resolveOptions(options);
  const seats = [...new Set(turns.map((t) => t.seat))];
  const { timeline, channels } = placeTracks(tracks, seats, opts, window);
  if (!timeline)
    return {
      ok: false,
      seats: [],
      leakage: { seats, matrixDb: unmeasuredLeakage(seats), source: "default" },
      warnings: ["No audio arrived for the calibration."],
    };
  return measureCalibration(channels, timeline, turns, opts);
}

/* ─────────── the gate ─────────── */

/** Sliding maximum over ±`w` frames (frames without data are skipped). */
function slidingMax(x: Float32Array, w: number): Float32Array {
  const out = new Float32Array(x.length).fill(Number.NaN);
  for (let f = 0; f < x.length; f++) {
    let m = Number.NaN;
    for (let k = Math.max(0, f - w); k <= Math.min(x.length - 1, f + w); k++) if (!(x[k]! <= m)) m = x[k]!;
    out[f] = m;
  }
  return out;
}

/**
 * Per frame, seat s speaks when its mic detects speech AND its level beats what every other seat's
 * voice would leak onto it by `gateMarginDb`: `E_s ≥ max E_j + L[j][s] + margin` for all j, where
 * `max E_j` is mic j's peak within ±`alignToleranceMs` (the mics' clocks agree only to a few tens of
 * ms). Leakage alone (another seat speaking) fails the gate; two people speaking at once both pass.
 */
function gate(
  channels: readonly SeatChannel[],
  leak: (number | null)[][],
  frames: number,
  opts: AttributionOptions,
  detector: "silero" | "energy",
) {
  const n = channels.length;
  const voiced = channels.map(() => new Uint8Array(frames));
  const passed = channels.map(() => new Uint8Array(frames));
  const confidence = channels.map(() => new Float32Array(frames));
  let speechFrames = 0;
  let ambiguousFrames = 0;
  const L = leak.map((row) => row.map((v) => v ?? opts.defaultLeakageDb));
  const peak = channels.map((ch) => slidingMax(ch.energyDb, Math.round(opts.alignToleranceMs / HOP_MS)));
  channels.forEach((ch, s) => {
    let on = false;
    for (let f = 0; f < frames; f++) {
      const e = ch.energyDb[f]!;
      if (!(e > DEAD_DB)) {
        on = false;
        continue;
      }
      if (detector === "silero") {
        const p = ch.speech[f]!;
        on = p >= (on ? opts.speechOffProb : opts.speechOnProb);
        confidence[s]![f] = p;
      } else {
        on = e >= ch.floorDb + opts.energyMarginDb;
        confidence[s]![f] = on ? 1 : 0;
      }
      voiced[s]![f] = on ? 1 : 0;
    }
  });
  for (let f = 0; f < frames; f++) {
    let any = false;
    let ambiguous = false;
    for (let s = 0; s < n; s++) {
      if (!voiced[s]![f]) continue;
      any = true;
      const e = channels[s]!.energyDb[f]!;
      let margin = Number.POSITIVE_INFINITY;
      for (let j = 0; j < n; j++) {
        const other = peak[j]![f]!;
        if (j !== s && other > DEAD_DB) margin = Math.min(margin, e - (other + L[j]![s]!));
      }
      if (margin >= opts.gateMarginDb) passed[s]![f] = 1;
      if (Math.abs(margin - opts.gateMarginDb) < opts.ambiguousDb) ambiguous = true;
    }
    if (any) speechFrames++;
    if (ambiguous) ambiguousFrames++;
  }
  return { passed, confidence, ambiguousShare: speechFrames ? ambiguousFrames / speechFrames : 0 };
}

/* ─────────── analyse ─────────── */

/** Coverage, clipping, levels, drift and talk time of each seat (`valid`: frames with data). */
function measureSeats(
  channels: readonly SeatChannel[],
  valid: readonly Uint8Array[],
  masks: readonly Uint8Array[],
  passed: readonly Uint8Array[],
  alignment: readonly TrackAlignment[],
  tl: Timeline,
): SeatQuality[] {
  return channels.map((ch, s) => {
    let data = 0;
    let clipped = 0;
    let talk = 0;
    let overlap = 0;
    const speech: number[] = [];
    for (let f = 0; f < tl.frames; f++) {
      if (valid[s]![f]) {
        data++;
        clipped += ch.clipped[f]!;
      }
      if (!masks[s]![f]) continue;
      talk++;
      if (masks.some((m, k) => k !== s && m[f])) overlap++;
      if (passed[s]![f] && speech.length < 200_000) speech.push(ch.energyDb[f]!);
    }
    const floor = Number.isFinite(ch.floorDb) ? ch.floorDb : null;
    const level = speech.length ? median(speech) : null;
    const seatTracks = alignment.filter((a) => a.seat === ch.seat);
    const longest = [...seatTracks].sort((a, b) => b.samples - a.samples)[0];
    return {
      seat: ch.seat,
      tracks: seatTracks.length,
      coverage: round(tl.frames ? data / tl.frames : 0, 4),
      clippingShare: round(data ? clipped / data : 0, 4),
      noiseFloorDb: roundOrNull(floor, 1),
      speechLevelDb: roundOrNull(level, 1),
      snrDb: roundOrNull(level !== null && floor !== null ? level - floor : null, 1),
      driftPpm: longest ? longest.driftPpm : null,
      talkTimeMs: talk * HOP_MS,
      overlapMs: overlap * HOP_MS,
    };
  });
}

export function analyse(input: AnalysisInput): AttributionResult {
  const opts = resolveOptions(input.options);
  const seats = [...new Set([...(input.seats ?? []), ...input.tracks.map((t) => t.seat)])].sort(
    (a, b) => a - b,
  );
  const placed = placeTracks(input.tracks, seats, opts, input.window);
  const warnings = [...placed.warnings];
  const { alignment, channels } = placed;
  const tl = placed.timeline ?? { t0: 0, hopMs: HOP_MS, frames: 0 };
  const withAudio = input.tracks.filter((t) => t.features.frames > 0);
  const detector = withAudio.length && withAudio.every((t) => t.features.speech) ? "silero" : "energy";
  if (detector === "energy" && withAudio.length)
    warnings.push(
      "No speech detector ran: speech was taken as energy above the noise floor (less robust to noise).",
    );

  // leakage
  const turns = input.calibration?.turns ?? [];
  let calibration: CalibrationSeatQuality[] | null = null;
  let leakage: LeakageReport = { seats, matrixDb: unmeasuredLeakage(seats), source: "default" };
  if (turns.length && tl.frames) {
    const r = measureCalibration(channels, tl, turns, opts);
    calibration = r.seats;
    leakage = r.leakage;
    warnings.push(...r.warnings);
  }
  if (leakage.source === "default")
    warnings.push(
      `No calibration: a default leakage of ${opts.defaultLeakageDb} dB was assumed between mics.`,
    );

  // gate, smoothing, segments
  const g = gate(channels, leakage.matrixDb, tl.frames, opts, detector);
  const frames = (ms: number) => Math.round(ms / HOP_MS);
  const smoothing = {
    minGap: frames(opts.minGapMs),
    minSpeech: frames(opts.minSpeechMs),
    hangover: frames(opts.hangoverMs),
    preRoll: frames(opts.preRollMs),
  };
  const valid = channels.map((ch) => Uint8Array.from(ch.energyDb, (e) => (e > DEAD_DB ? 1 : 0)));
  const masks = channels.map((_, s) => smoothSpeech(g.passed[s]!, valid[s]!, smoothing));
  const segments = segmentsFromMasks(
    seats,
    masks,
    channels.map((c) => c.energyDb),
    g.passed,
    g.confidence,
    tl,
  );
  let overlapFrames = 0;
  for (let f = 0; f < tl.frames; f++) if (masks.reduce((k, m) => k + m[f]!, 0) >= 2) overlapFrames++;

  // quality
  const seatQuality = measureSeats(channels, valid, masks, g.passed, alignment, tl);
  for (const q of seatQuality) {
    if (q.coverage === 0) warnings.push(`Seat ${q.seat}: no audio at all; its speech is not attributed.`);
    else if (q.coverage < 0.95)
      warnings.push(
        `Seat ${q.seat}: no usable audio for ${round((1 - q.coverage) * 100, 1)} % of the session.`,
      );
    if (q.clippingShare > opts.clippingWarnShare)
      warnings.push(
        `Seat ${q.seat}: clipping in ${round(q.clippingShare * 100, 2)} % of frames; lower its input level.`,
      );
  }
  if (g.ambiguousShare > opts.ambiguousWarnShare)
    warnings.push(
      `${round(g.ambiguousShare * 100, 1)} % of speech frames were close to the gate threshold (mics hear each other too similarly).`,
    );
  const meanCoverage = seatQuality.length
    ? seatQuality.reduce((a, q) => a + q.coverage, 0) / seatQuality.length
    : 0;
  const poor =
    meanCoverage < 0.5 ||
    g.ambiguousShare > 0.25 ||
    (calibration ?? []).some((q) => q.marginDb !== null && q.marginDb < opts.minMarginDb / 2);
  if (!tl.frames) warnings.push("No audio to analyse.");

  return {
    engineVersion: ENGINE_VERSION,
    options: opts,
    timeline: { ...tl, endTs: tl.t0 + tl.frames * HOP_MS },
    seats,
    alignment,
    leakage,
    segments,
    talkTimeMs: Object.fromEntries(seatQuality.map((q) => [q.seat, q.talkTimeMs])),
    overlapMs: overlapFrames * HOP_MS,
    masks: masks.map((m, s) => ({ seat: seats[s]!, runs: maskToRuns(m) })),
    quality: {
      grade: poor || !tl.frames ? "poor" : warnings.length ? "fair" : "good",
      detector,
      calibration,
      ambiguousShare: round(g.ambiguousShare, 4),
      seats: seatQuality,
      warnings,
    },
  };
}
