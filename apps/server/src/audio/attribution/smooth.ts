/**
 * Smoothing of the raw per-frame activity into speech segments, and run-length masks.
 *
 * Per seat, independently, in this order:
 * 1. **Bridge** pauses shorter than `minGapMs` (200 ms) between two speech runs, as long as the seat
 *    has data throughout the pause (a gap in the recording is never bridged).
 * 2. **Drop** runs shorter than `minSpeechMs` (250 ms): clicks, coughs, short mis-attributions.
 * 3. **Extend** each run by `hangoverMs` (100 ms) after its end and `preRollMs` (20 ms) before its
 *    start, so word tails and onsets that sit near the noise floor are kept. The extension stops at
 *    frames without data and at frames where another seat is the dominant speaker, so a quick
 *    turn-taking does not create artificial overlap.
 *
 * The result is a 0/1 mask per seat on the session timeline. Segments are its runs, with the
 * mean own-mic level, the mean frame confidence of the raw speech frames inside, and the time
 * shared with other seats' masks (`overlapMs`, `overlapWith`).
 */

import { dbToPow, powToDb } from "./math";
import type { SeatChannel } from "./timeline";
import { SILENCE_DB, type SpeechSegment, type Timeline } from "./types";

export interface SmoothingFrames {
  minGap: number;
  minSpeech: number;
  hangover: number;
  preRoll: number;
}

/** Smooths raw activity (any non-zero = speech) into a 0/1 mask. */
export function smoothActivity(
  raw: Uint8Array,
  valid: Uint8Array,
  blocked: Uint8Array | null,
  p: SmoothingFrames,
): Uint8Array {
  const n = raw.length;
  const m = new Uint8Array(n);
  for (let f = 0; f < n; f++) m[f] = raw[f]! && valid[f]! ? 1 : 0;
  // 1. Bridge short pauses with data.
  let lastEnd = -1;
  for (let f = 0; f < n; ) {
    if (!m[f]) {
      f++;
      continue;
    }
    const start = f;
    while (f < n && m[f]) f++;
    if (lastEnd >= 0 && start - lastEnd < p.minGap) {
      let ok = true;
      for (let g = lastEnd; g < start; g++) {
        if (!valid[g]) {
          ok = false;
          break;
        }
      }
      if (ok) m.fill(1, lastEnd, start);
    }
    lastEnd = f;
  }
  // 2. Drop short runs.
  for (let f = 0; f < n; ) {
    if (!m[f]) {
      f++;
      continue;
    }
    const start = f;
    while (f < n && m[f]) f++;
    if (f - start < p.minSpeech) m.fill(0, start, f);
  }
  // 3. Hangover and pre-roll (on a copy, so extensions do not chain).
  if (p.hangover > 0 || p.preRoll > 0) {
    const out = Uint8Array.from(m);
    for (let f = 0; f < n; ) {
      if (!m[f]) {
        f++;
        continue;
      }
      const start = f;
      while (f < n && m[f]) f++;
      for (let g = f; g < Math.min(n, f + p.hangover); g++) {
        if (!valid[g] || blocked?.[g]) break;
        out[g] = 1;
      }
      for (let g = start - 1; g >= Math.max(0, start - p.preRoll); g--) {
        if (!valid[g] || blocked?.[g]) break;
        out[g] = 1;
      }
    }
    return out;
  }
  return m;
}

/** Run-length encodes a 0/1 mask as `[start0, end0, start1, end1, …]` (end exclusive). */
export function maskToRuns(mask: Uint8Array): number[] {
  const runs: number[] = [];
  for (let f = 0; f < mask.length; ) {
    if (!mask[f]) {
      f++;
      continue;
    }
    const start = f;
    while (f < mask.length && mask[f]) f++;
    runs.push(start, f);
  }
  return runs;
}

/** Expands run-length `runs` back into a 0/1 mask of `frames` frames. */
export function runsToMask(runs: readonly number[], frames: number): Uint8Array {
  const m = new Uint8Array(frames);
  for (let i = 0; i + 1 < runs.length; i += 2) {
    const a = Math.max(0, runs[i]!);
    const b = Math.min(frames, runs[i + 1]!);
    if (b > a) m.fill(1, a, b);
  }
  return m;
}

/** Speech segments of every seat from the smoothed masks. */
export function segmentsFromMasks(
  masks: readonly Uint8Array[],
  channels: readonly SeatChannel[],
  raw: readonly Uint8Array[],
  confidence: readonly Float32Array[],
  tl: Timeline,
): SpeechSegment[] {
  const n = masks.length;
  const segments: SpeechSegment[] = [];
  for (let s = 0; s < n; s++) {
    const mask = masks[s]!;
    const ch = channels[s]!;
    const runs = maskToRuns(mask);
    for (let i = 0; i < runs.length; i += 2) {
      const a = runs[i]!;
      const b = runs[i + 1]!;
      let pow = 0;
      let confSum = 0;
      let speech = 0;
      let overlap = 0;
      const withSet = new Set<number>();
      for (let f = a; f < b; f++) {
        if (raw[s]![f]) {
          pow += dbToPow(ch.energyDb[f]!);
          confSum += confidence[s]![f]!;
          speech++;
        }
        let shared = false;
        for (let k = 0; k < n; k++) {
          if (k !== s && masks[k]![f]) {
            shared = true;
            withSet.add(channels[k]!.seat);
          }
        }
        if (shared) overlap++;
      }
      segments.push({
        seat: ch.seat,
        startTs: tl.t0 + a * tl.hopMs,
        endTs: tl.t0 + b * tl.hopMs,
        durationMs: (b - a) * tl.hopMs,
        meanDb: speech ? Math.round(powToDb(pow / speech) * 10) / 10 : SILENCE_DB,
        confidence: speech ? Math.round((confSum / speech) * 1000) / 1000 : 0,
        overlap: overlap > 0,
        overlapMs: overlap * tl.hopMs,
        overlapWith: [...withSet].sort((x, y) => x - y),
      });
    }
  }
  segments.sort((x, y) => x.startTs - y.startTs || x.seat - y.seat);
  return segments;
}
