/**
 * Smoothing of per-frame speech into segments, and run-length masks.
 *
 * Per seat, independently:
 * 1. **Bridge** pauses shorter than `minGapMs` (200 ms) between two speech runs, when the seat has
 *    data throughout the pause (a gap in the recording is never bridged).
 * 2. **Drop** runs shorter than `minSpeechMs` (250 ms): clicks, coughs, short leaks.
 * 3. **Extend** each run by `hangoverMs` (100 ms) after its end and `preRollMs` (20 ms) before its
 *    start, so soft word tails and onsets are kept; never into frames without data.
 */

import { SILENCE_DB, type SpeechSegment, type Timeline } from "./types";

export interface SmoothingFrames {
  minGap: number;
  minSpeech: number;
  hangover: number;
  preRoll: number;
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

/** Smooths raw speech (1 = speech) into a 0/1 mask; `valid` marks frames with data. */
export function smoothSpeech(raw: Uint8Array, valid: Uint8Array, p: SmoothingFrames): Uint8Array {
  const n = raw.length;
  const m = new Uint8Array(n);
  for (let f = 0; f < n; f++) m[f] = raw[f]! & valid[f]!;
  let runs = maskToRuns(m);
  for (let i = 2; i < runs.length; i += 2) {
    const a = runs[i - 1]!;
    const b = runs[i]!;
    if (b - a < p.minGap && valid.subarray(a, b).every((v) => v === 1)) m.fill(1, a, b);
  }
  runs = maskToRuns(m);
  const out = new Uint8Array(n);
  for (let i = 0; i < runs.length; i += 2) {
    let a = runs[i]!;
    let b = runs[i + 1]!;
    if (b - a < p.minSpeech) continue;
    for (let k = 0; k < p.preRoll && a > 0 && valid[a - 1]; k++) a--;
    for (let k = 0; k < p.hangover && b < n && valid[b]; k++) b++;
    out.fill(1, a, b);
  }
  return out;
}

/** Speech segments of every seat from the smoothed masks. */
export function segmentsFromMasks(
  seats: readonly number[],
  masks: readonly Uint8Array[],
  energyDb: readonly Float32Array[],
  speech: readonly Uint8Array[],
  confidence: readonly Float32Array[],
  tl: Timeline,
): SpeechSegment[] {
  const segments: SpeechSegment[] = [];
  masks.forEach((mask, s) => {
    const runs = maskToRuns(mask);
    for (let i = 0; i < runs.length; i += 2) {
      const a = runs[i]!;
      const b = runs[i + 1]!;
      let pow = 0;
      let conf = 0;
      let speechFrames = 0;
      let overlap = 0;
      const withSet = new Set<number>();
      for (let f = a; f < b; f++) {
        conf += confidence[s]![f]!;
        if (speech[s]![f]) {
          pow += 10 ** (energyDb[s]![f]! / 10);
          speechFrames++;
        }
        let shared = false;
        masks.forEach((other, k) => {
          if (k !== s && other[f]) {
            shared = true;
            withSet.add(seats[k]!);
          }
        });
        if (shared) overlap++;
      }
      segments.push({
        seat: seats[s]!,
        startTs: tl.t0 + a * tl.hopMs,
        endTs: tl.t0 + b * tl.hopMs,
        durationMs: (b - a) * tl.hopMs,
        meanDb: speechFrames ? Math.round(100 * Math.log10(pow / speechFrames)) / 10 : SILENCE_DB,
        confidence: Math.round((conf / (b - a)) * 1000) / 1000,
        overlap: overlap > 0,
        overlapMs: overlap * tl.hopMs,
        overlapWith: [...withSet].sort((x, y) => x - y),
      });
    }
  });
  return segments.sort((x, y) => x.startTs - y.startTs || x.seat - y.seat);
}
