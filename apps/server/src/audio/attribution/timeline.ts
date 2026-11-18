/**
 * The common session timeline and the per-seat channels on it.
 *
 * The timeline is a grid of 10 ms frames from `t0` (the first aligned sample of any track,
 * rounded down to 10 ms). Each track's envelope is resampled onto it through the track's clock
 * (`startTs + offsetMs + n · msPerSample`), by linear interpolation of the dB values at the
 * fractional frame position. That absorbs drift: a +100 ppm device simply lands one frame earlier
 * every 100 s.
 *
 * A seat's channel holds `NaN` wherever none of its tracks has data (before its first track,
 * between tracks, lost chunks). "No data" is kept apart from silence everywhere downstream: a seat
 * is never attributed speech, and never counted as quiet, where it has no data. If two tracks of a
 * seat overlap in time (timestamp jitter at a reload), the earlier track keeps the frames and the
 * overlap is counted for the quality report.
 */

import { quantileSorted } from "./math";
import { estimateNoiseFloor } from "./noiseFloor";
import { DEAD_DB, type Envelope, type Timeline } from "./types";

/** A track's current mapping onto the server clock (mutable while the alignment is refined). */
export interface Placement {
  trackId: string;
  seat: number;
  seatIndex: number;
  /** Clock group (one device) from the clock fit. */
  group: string;
  sampleRate: number;
  hopSamples: number;
  startTs: number;
  msPerSample: number;
  offsetMs: number;
  /** Length of the track in samples (as covered by its envelope). */
  samples: number;
  envelope: Envelope;
}

export function placementStart(p: Placement): number {
  return p.startTs + p.offsetMs;
}

export function placementEnd(p: Placement): number {
  return p.startTs + p.offsetMs + p.samples * p.msPerSample;
}

/** One seat's data on the timeline. */
export interface SeatChannel {
  seat: number;
  /** Frame energy (dBFS); `NaN` = no data. */
  energyDb: Float32Array;
  clipped: Uint8Array;
  /** Index of the placement that supplied each frame, −1 = none. */
  track: Int16Array;
  /** Adaptive noise floor (dBFS), defined for every frame. */
  floorDb: Float32Array;
  /** Frames where two tracks of this seat overlapped. */
  overlapFrames: number;
}

/**
 * Typical speech level of each channel: the 95th percentile of its frame energies (every 5th frame),
 * which on a mic in front of a participant is that participant's own voice. `NaN` with < 20 frames.
 */
export function typicalLevels(channels: readonly SeatChannel[]): number[] {
  return channels.map((ch) => {
    const v: number[] = [];
    for (let f = 0; f < ch.energyDb.length; f += 5) if (ch.energyDb[f]! > DEAD_DB) v.push(ch.energyDb[f]!);
    v.sort((a, b) => a - b);
    return v.length >= 20 ? quantileSorted(v, 0.95) : Number.NaN;
  });
}

export function makeTimeline(
  placements: readonly Placement[],
  hopMs: number,
  window?: { fromTs: number; toTs: number } | null,
): Timeline | null {
  if (placements.length === 0) return null;
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const p of placements) {
    start = Math.min(start, placementStart(p));
    end = Math.max(end, placementEnd(p));
  }
  if (window) {
    start = Math.max(start, window.fromTs);
    end = Math.min(end, window.toTs);
  }
  if (!(end > start)) return null;
  const t0 = Math.floor(start / hopMs) * hopMs;
  return { t0, hopMs, frames: Math.ceil((end - t0) / hopMs) };
}

/** Writes one placement's envelope into its seat's channel. */
function mapPlacement(p: Placement, index: number, tl: Timeline, ch: SeatChannel): void {
  const env = p.envelope;
  const K = env.frames;
  if (K === 0) return;
  const E = env.energyDb;
  const C = env.clipped;
  const hopS = p.hopSamples;
  const start = placementStart(p);
  // Local frame position (centre-to-centre) of timeline frame f: k(f) = k0 + f·dk.
  const k0 = (tl.t0 + 0.5 * tl.hopMs - start) / p.msPerSample / hopS - 0.5;
  const dk = tl.hopMs / p.msPerSample / hopS;
  const fA = Math.max(0, Math.ceil((-0.5 - k0) / dk));
  const fB = Math.min(tl.frames - 1, Math.floor((K - 0.5 - k0) / dk));
  for (let f = fA; f <= fB; f++) {
    const k = k0 + f * dk;
    const i0 = Math.floor(k);
    let v: number;
    let ci: number;
    if (i0 < 0) {
      v = E[0]!;
      ci = 0;
    } else if (i0 >= K - 1) {
      v = E[K - 1]!;
      ci = K - 1;
    } else {
      const w = k - i0;
      const a = E[i0]!;
      const b = E[i0 + 1]!;
      if (Number.isNaN(a)) v = w >= 0.5 ? b : a;
      else if (Number.isNaN(b)) v = w < 0.5 ? a : b;
      else v = a + w * (b - a);
      ci = w < 0.5 ? i0 : i0 + 1;
    }
    if (Number.isNaN(v)) continue;
    const prev = ch.track[f]!;
    if (prev >= 0 && prev !== index && !Number.isNaN(ch.energyDb[f]!)) {
      ch.overlapFrames++;
      continue;
    }
    ch.energyDb[f] = v;
    ch.clipped[f] = C[ci]!;
    ch.track[f] = index;
  }
}

/**
 * Builds every seat's channel on the timeline and its noise floor. `seats` fixes the order (and
 * includes seats without tracks); placements are mapped in order of their start time.
 */
export function buildChannels(
  seats: readonly number[],
  placements: readonly Placement[],
  tl: Timeline,
  floor: { windowFrames: number; percentile: number },
): SeatChannel[] {
  const channels: SeatChannel[] = seats.map((seat) => ({
    seat,
    energyDb: new Float32Array(tl.frames).fill(Number.NaN),
    clipped: new Uint8Array(tl.frames),
    track: new Int16Array(tl.frames).fill(-1),
    floorDb: new Float32Array(tl.frames),
    overlapFrames: 0,
  }));
  const order = placements
    .map((_, i) => i)
    .sort((a, b) => placementStart(placements[a]!) - placementStart(placements[b]!));
  for (const i of order) {
    const p = placements[i]!;
    const ch = channels[p.seatIndex];
    if (ch) mapPlacement(p, i, tl, ch);
  }
  for (const ch of channels) {
    ch.floorDb = estimateNoiseFloor(ch.energyDb, {
      windowFrames: floor.windowFrames,
      percentile: floor.percentile,
    });
  }
  return channels;
}
