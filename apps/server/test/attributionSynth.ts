/**
 * Synthetic four-seat sessions for the attribution engine tests (deterministic, seeded).
 *
 * Speech-like sources: band-limited noise (a band-pass whose centre moves per syllable between
 * 250 Hz and 2.5 kHz) with a syllabic envelope (syllables 150–280 ms ≈ 3.5–6.5 Hz, troughs
 * 16 dB down), grouped into words with 30–120 ms pauses, utterances of 1–5 s, turn gaps of
 * 0.25–1.2 s (sometimes 2–3 s) and interjections that overlap the current speaker (≈ 10 % of
 * speech). A calibration block (each seat reads ≈ 5 s in a 6 s turn, 1 s gaps) opens the session.
 *
 * Every mic hears every seat through a path with a known acoustic leakage, a 0–3 ms delay, a
 * slight spectral tilt (so the level ratio varies per syllable) and a slow ±0.75 dB level wobble
 * (head movement), plus its own white noise floor and device gain. Each device then samples the
 * room at its own drifting clock (±100 ppm) and reports `clientTs` with a constant input latency
 * (0–50 ms) and ±20 ms of jitter, in 5 s chunks. Gaps (new track after a reload) and lost chunks can
 * be added.
 */

import { AUDIO_SAMPLE_RATE } from "@wkwa/shared";
import {
  type CalibrationTurn,
  type ChunkMeta,
  EnvelopeBuilder,
  type TrackInput,
} from "../src/audio/attribution";
import type { AttributionResult, TrackAlignment } from "../src/audio/attribution/types";
import { sampleTime } from "../src/audio/attribution/types";

export const FS = AUDIO_SAMPLE_RATE;
const CHUNK = 80_000;

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const uni = (r: () => number, a: number, b: number) => a + (b - a) * r();

export type Profile = "headset" | "laptop";

export interface SynthConfig {
  seed: number;
  durationSec: number;
  profile: Profile;
  calibration?: boolean;
  /** Seat records nothing in `[fromSec, toSec)`; recording resumes as a new track. */
  gaps?: Array<{ seat: number; fromSec: number; toSec: number }>;
  /** Chunks (by index within the seat's first track) that never reach the server. */
  lostChunks?: Array<{ seat: number; chunk: number }>;
  /** Utterances placed at fixed times (the planner works around them). */
  forced?: Array<{ seat: number; atSec: number; durSec: number }>;
  /** This seat's mic gain is raised by 18 dB (clipping). */
  hotSeat?: number;
  overlapProb?: number;
}

export interface SynthTrack {
  trackId: string;
  seat: number;
  pcm: Int16Array;
  chunks: ChunkMeta[];
  /** Chunks lost in transit (their PCM is never delivered). */
  lost: Set<number>;
  /** True capture time of sample 0 (epoch ms) and the device's clock error. */
  trueStartMs: number;
  driftPpm: number;
  latencyMs: number;
}

export interface SynthSession {
  t0: number;
  durationSec: number;
  seats: number[];
  tracks: SynthTrack[];
  /** True speech intervals (epoch ms). */
  speech: Array<{ seat: number; start: number; end: number }>;
  turns: CalibrationTurn[];
  /** True leakage G[s][j] (dB), seat index order. */
  leakageDb: number[][];
  driftPpm: number[];
  latencyMs: number[];
}

interface Word {
  start: number; // seconds
  syl: Array<{ len: number; fc: number; amp: number }>;
}
interface Utterance {
  seat: number;
  start: number;
  end: number;
  words: Word[];
}

function makeUtterance(r: () => number, seat: number, start: number, dur: number): Utterance {
  const words: Word[] = [];
  let t = start;
  let end = start;
  while (t < start + dur) {
    const n = 1 + Math.floor(r() * 4);
    const syl = [];
    let len = 0;
    for (let i = 0; i < n; i++) {
      const l = uni(r, 0.15, 0.28);
      syl.push({ len: l, fc: 250 * 10 ** (r() * 1), amp: uni(r, 0.7, 1) });
      len += l;
    }
    words.push({ start: t, syl });
    end = t + len;
    t = end + uni(r, 0.03, 0.12);
  }
  return { seat, start, end, words };
}

function plan(
  cfg: SynthConfig,
  r: () => number,
): { utts: Utterance[]; turns: Array<{ seat: number; a: number; b: number }> } {
  const utts: Utterance[] = [];
  const turns: Array<{ seat: number; a: number; b: number }> = [];
  let cursor = 2;
  if (cfg.calibration !== false) {
    for (let s = 1; s <= 4; s++) {
      const a = 2.5 + (s - 1) * 7;
      turns.push({ seat: s, a, b: a + 6 });
      utts.push(makeUtterance(r, s, a + uni(r, 0.3, 0.7), 4.8));
    }
    cursor = 2.5 + 28 + 1.5;
  }
  const forced = [...(cfg.forced ?? [])].sort((x, y) => x.atSec - y.atSec);
  let last = 0;
  const pOverlap = cfg.overlapProb ?? 0.35;
  while (cursor < cfg.durationSec - 6) {
    const f = forced[0];
    if (f && cursor + 6 >= f.atSec) {
      forced.shift();
      const u = makeUtterance(r, f.seat, Math.max(cursor, f.atSec), f.durSec);
      utts.push(u);
      last = f.seat;
      cursor = u.end + uni(r, 0.4, 1);
      continue;
    }
    let seat = 1 + Math.floor(r() * 4);
    if (seat === last) seat = (seat % 4) + 1;
    const u = makeUtterance(r, seat, cursor, uni(r, 1, 5));
    utts.push(u);
    let end = u.end;
    if (r() < pOverlap && u.end - u.start > 1.2) {
      let other = 1 + Math.floor(r() * 4);
      if (other === seat) other = (other % 4) + 1;
      const at = u.start + uni(r, 0.25, 0.75) * (u.end - u.start);
      const i = makeUtterance(r, other, at, uni(r, 0.5, 1.5));
      utts.push(i);
      end = Math.max(end, i.end);
    }
    last = seat;
    cursor = end + (r() < 0.1 ? uni(r, 2, 3) : uni(r, 0.25, 1.2));
  }
  return { utts, turns };
}

/** Unit-RMS-ish source of one seat on the true 16 kHz grid. */
function renderSource(utts: readonly Utterance[], seat: number, N: number, r: () => number): Float32Array {
  const out = new Float32Array(N);
  let tmp = new Float32Array(0);
  for (const u of utts) {
    if (u.seat !== seat) continue;
    for (const w of u.words) {
      const w0 = Math.round(w.start * FS);
      const wordLen = Math.round(w.syl.reduce((a, s) => a + s.len, 0) * FS);
      const ramp = Math.round(0.02 * FS);
      let x1 = 0;
      let x2 = 0;
      let y1 = 0;
      let y2 = 0;
      let pos = 0;
      for (const s of w.syl) {
        const len = Math.round(s.len * FS);
        if (tmp.length < len) tmp = new Float32Array(len);
        const wc = (2 * Math.PI * s.fc) / FS;
        const alpha = Math.sin(wc) / (2 * 1.5);
        const a0 = 1 + alpha;
        const b0 = alpha / a0;
        const b2 = -alpha / a0;
        const a1 = (-2 * Math.cos(wc)) / a0;
        const a2 = (1 - alpha) / a0;
        let ss = 0;
        for (let k = 0; k < len; k++) {
          const x = (r() + r() + r() + r() - 2) * 1.732;
          const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2;
          x2 = x1;
          x1 = x;
          y2 = y1;
          y1 = y;
          tmp[k] = y;
          ss += y * y;
        }
        const norm = s.amp / Math.sqrt(ss / len || 1);
        for (let k = 0; k < len; k++) {
          const u2 = k / len;
          const sh = Math.sin(Math.PI * u2);
          let env = 0.15 + 0.85 * sh * sh;
          const p = pos + k;
          if (p < ramp) env *= 0.5 - 0.5 * Math.cos((Math.PI * p) / ramp);
          if (wordLen - p < ramp) env *= 0.5 - 0.5 * Math.cos((Math.PI * (wordLen - p)) / ramp);
          const n = w0 + p;
          if (n >= 0 && n < N) out[n] = out[n]! + tmp[k]! * norm * env * 1.6;
        }
        pos += len;
      }
    }
  }
  return out;
}

export function synthesise(cfg: SynthConfig): SynthSession {
  const r = mulberry32(cfg.seed);
  const N = Math.round(cfg.durationSec * FS);
  const t0 = 1_763_000_000_000 + cfg.seed * 1000;
  const seats = [1, 2, 3, 4];
  const headset = cfg.profile === "headset";
  const talker = seats.map(() => -24 + uni(r, -3, 3));
  const gain = seats.map((s) => (headset ? uni(r, -4, 4) : uni(r, -6, 6)) + (cfg.hotSeat === s ? 18 : 0));
  const floor = seats.map(() => (headset ? uni(r, -66, -58) : uni(r, -52, -44)));
  const A = seats.map((_, s) =>
    seats.map((_, j) => (s === j ? 0 : headset ? uni(r, -25, -15) : uni(r, -10, -4))),
  );
  const leakageDb = seats.map((_, s) => seats.map((_, j) => A[s]![j]! + gain[j]! - gain[s]!));
  const drift = seats.map(() => uni(r, -100, 100));
  const latency = seats.map(() => uni(r, 0, 50));
  const { utts, turns } = plan(cfg, r);
  const sources = seats.map((s) => renderSource(utts, s, N, mulberry32(cfg.seed * 7919 + s)));
  const tracks: SynthTrack[] = [];
  for (let j = 0; j < 4; j++) {
    const seat = j + 1;
    const acc = new Float32Array(N);
    for (let s = 0; s < 4; s++) {
      const src = sources[s]!;
      const g = 32768 * 10 ** ((talker[s]! + gain[j]! + A[s]![j]!) / 20);
      const own = s === j;
      const delay = own ? 0 : Math.floor(r() * 48);
      const beta = own ? 0 : uni(r, -0.3, 0.3);
      const wobAmp = own ? 0 : 0.75;
      const wobPeriod = uni(r, 5, 15) * FS;
      const wobPhase = r() * 2 * Math.PI;
      const hpA = 1 / (1 + (2 * Math.PI * 2000) / FS);
      let hp = 0;
      let xp = 0;
      let w = 1;
      for (let n = 0; n + delay < N; n++) {
        if (n % 160 === 0) w = 10 ** ((wobAmp * Math.sin((2 * Math.PI * n) / wobPeriod + wobPhase)) / 20);
        const x = src[n]!;
        hp = hpA * (hp + x - xp);
        xp = x;
        if (x === 0 && hp === 0) continue;
        acc[n + delay] = acc[n + delay]! + g * w * (x + beta * hp);
      }
    }
    const nr = mulberry32(cfg.seed * 104729 + seat);
    const na = 32768 * 10 ** (floor[j]! / 20) * 1.732;
    for (let n = 0; n < N; n++) acc[n] = acc[n]! + (nr() + nr() + nr() + nr() - 2) * na;
    // Recording segments of this seat (true seconds).
    const segs: Array<[number, number]> = [];
    let a = uni(r, 0.2, 1);
    for (const g of (cfg.gaps ?? []).filter((x) => x.seat === seat).sort((x, y) => x.fromSec - y.fromSec)) {
      segs.push([a, g.fromSec]);
      a = g.toSec;
    }
    segs.push([a, cfg.durationSec - 0.2]);
    const d = drift[j]! * 1e-6;
    segs.forEach(([sa, sb], ti) => {
      const n = Math.floor((sb - sa) * FS * (1 + d));
      const pcm = new Int16Array(n);
      const base = sa * FS;
      for (let k = 0; k < n; k++) {
        const p = base + k / (1 + d);
        const i = Math.floor(p);
        const f = p - i;
        const v = acc[i]! * (1 - f) + (acc[i + 1] ?? 0) * f;
        const q = Math.round(v);
        pcm[k] = q > 32767 ? 32767 : Math.max(q, -32768);
      }
      const chunks: ChunkMeta[] = [];
      const lost = new Set<number>();
      const jr = mulberry32(cfg.seed * 31 + seat * 7 + ti);
      for (let c = 0, seq = 0; c < n; c += CHUNK, seq++) {
        const cnt = Math.min(CHUNK, n - c);
        const trueMs = t0 + (sa + c / (FS * (1 + d))) * 1000;
        const clientTs = trueMs + latency[j]! + uni(jr, -20, 20);
        if (ti === 0 && cfg.lostChunks?.some((x) => x.seat === seat && x.chunk === seq)) {
          lost.add(seq);
          continue;
        }
        chunks.push({
          seq,
          startSample: c,
          sampleCount: cnt,
          clientTs,
          serverTs: clientTs + 5030 + uni(jr, 0, 50),
        });
      }
      tracks.push({
        trackId: `track-${seat}-${ti}-${cfg.seed}`,
        seat,
        pcm,
        chunks,
        lost,
        trueStartMs: t0 + sa * 1000,
        driftPpm: drift[j]!,
        latencyMs: latency[j]!,
      });
    });
  }
  return {
    t0,
    durationSec: cfg.durationSec,
    seats,
    tracks,
    speech: utts.map((u) => ({ seat: u.seat, start: t0 + u.start * 1000, end: t0 + u.end * 1000 })),
    turns: turns.map((t) => ({ seat: t.seat, startTs: t0 + t.a * 1000, endTs: t0 + t.b * 1000 })),
    leakageDb,
    driftPpm: drift,
    latencyMs: latency,
  };
}

/** Delivered chunks of a track (lost ones skipped) as PCM blocks. */
export function deliveredChunks(t: SynthTrack): Array<{ startSample: number; samples: Int16Array }> {
  return t.chunks.map((c) => ({
    startSample: c.startSample,
    samples: t.pcm.subarray(c.startSample, c.startSample + c.sampleCount),
  }));
}

export function trackInputs(s: SynthSession): TrackInput[] {
  return s.tracks.map((t) => {
    const b = new EnvelopeBuilder();
    for (const c of deliveredChunks(t)) b.push(c.samples, c.startSample);
    return { trackId: t.trackId, seat: t.seat, chunks: t.chunks, envelope: b.finish() };
  });
}

/** True capture time of sample n of a synthetic track (epoch ms). */
export function trueSampleTime(t: SynthTrack, n: number): number {
  return t.trueStartMs + (n / (FS * (1 + t.driftPpm * 1e-6))) * 1000;
}

/** Offset of the engine's clock from true time, taken at the anchor track's midpoint (ms). */
export function anchorBias(result: AttributionResult, s: SynthSession): number {
  const a = result.alignment.find((x) => x.anchor)!;
  const t = s.tracks.find((x) => x.trackId === a.trackId)!;
  const n = t.pcm.length / 2;
  return sampleTime(a, n) - trueSampleTime(t, n);
}

/** Largest relative alignment error of a track (vs the anchor's bias), at its start, middle and end (ms). */
export function alignmentError(a: TrackAlignment, t: SynthTrack, bias: number): number {
  let worst = 0;
  for (const n of [0, t.pcm.length / 2, t.pcm.length - 1]) {
    worst = Math.max(worst, Math.abs(sampleTime(a, n) - trueSampleTime(t, n) - bias));
  }
  return worst;
}

export interface Evaluation {
  singleFrames: number;
  singleAccuracy: number;
  overlapFrames: number;
  overlapRecall: number;
  falseTalk: number;
  /** Frames where a seat had no data but was marked as speaking. */
  speechInGaps: number;
  /** Frames where only a seat without data spoke, and another seat was credited. */
  absentCredited: number;
  absentFrames: number;
}

/** Frame-level comparison with the ground truth, ignoring `collarMs` around every true boundary. */
export function evaluate(result: AttributionResult, s: SynthSession, collarMs = 100): Evaluation {
  const tl = result.timeline;
  const bias = anchorBias(result, s);
  const masks = result.masks.map((m) => {
    const arr = new Uint8Array(tl.frames);
    for (let i = 0; i < m.runs.length; i += 2) arr.fill(1, m.runs[i]!, m.runs[i + 1]!);
    return arr;
  });
  // Coverage of each seat in true time (ms ranges), excluding lost chunks.
  const coverage = s.seats.map((seat) =>
    s.tracks
      .filter((t) => t.seat === seat)
      .flatMap((t) => {
        const r: Array<[number, number]> = [];
        for (const c of t.chunks) {
          const a = trueSampleTime(t, c.startSample);
          const b = trueSampleTime(t, c.startSample + c.sampleCount);
          const prev = r[r.length - 1];
          if (prev && a <= prev[1] + 1) prev[1] = b;
          else r.push([a, b]);
        }
        return r;
      }),
  );
  const covered = (si: number, tau: number) => coverage[si]!.some(([a, b]) => tau >= a + 15 && tau < b - 15);
  let local = s.speech;
  const speaking = (si: number, tau: number) =>
    local.some((u) => u.seat === si + 1 && tau >= u.start && tau < u.end);
  const nearBoundary = (tau: number, seatIdx?: number) =>
    local.some(
      (u) =>
        (seatIdx === undefined || u.seat === seatIdx + 1) &&
        (Math.abs(tau - u.start) < collarMs || Math.abs(tau - u.end) < collarMs),
    );
  let single = 0;
  let singleOk = 0;
  let over = 0;
  let overOk = 0;
  let silentTotal = 0;
  let silentFalse = 0;
  let gaps = 0;
  let absentCredited = 0;
  let absentFrames = 0;
  const buckets = new Map<number, typeof s.speech>();
  for (const u of s.speech) {
    for (let b = Math.floor((u.start - collarMs) / 1000); b <= Math.floor((u.end + collarMs) / 1000); b++) {
      const l = buckets.get(b) ?? [];
      l.push(u);
      buckets.set(b, l);
    }
  }
  for (let f = 0; f < tl.frames; f++) {
    const tau = tl.t0 + (f + 0.5) * tl.hopMs - bias;
    if (tau < s.t0 || tau > s.t0 + s.durationSec * 1000) continue;
    local = buckets.get(Math.floor(tau / 1000)) ?? [];
    const truth: number[] = [];
    const cov: boolean[] = [];
    for (let si = 0; si < 4; si++) {
      if (speaking(si, tau)) truth.push(si);
      cov.push(covered(si, tau));
    }
    for (let si = 0; si < 4; si++) {
      if (!cov[si] && masks[si]![f]) gaps++;
    }
    const near = nearBoundary(tau);
    if (!near && truth.length === 1 && !cov[truth[0]!]) {
      absentFrames++;
      if (masks.some((m, k) => m[f] && k !== truth[0])) absentCredited++;
    }
    if (!near && truth.length >= 1 && truth.every((si) => cov[si])) {
      if (truth.length === 1) {
        single++;
        const t = truth[0]!;
        if (masks.every((m, k) => (m[f] ? k === t : k !== t))) singleOk++;
      } else {
        over++;
        if (truth.every((si) => masks[si]![f])) overOk++;
      }
    }
    for (let si = 0; si < 4; si++) {
      if (!cov[si] || truth.includes(si) || nearBoundary(tau, si)) continue;
      silentTotal++;
      if (masks[si]![f]) silentFalse++;
    }
  }
  return {
    singleFrames: single,
    singleAccuracy: single ? singleOk / single : 0,
    overlapFrames: over,
    overlapRecall: over ? overOk / over : 0,
    falseTalk: silentTotal ? silentFalse / silentTotal : 0,
    speechInGaps: gaps,
    absentCredited,
    absentFrames,
  };
}
