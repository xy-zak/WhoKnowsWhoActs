/**
 * Joins speech segments with the game's phase timeline (round, phase, pause state).
 *
 * The caller derives change points from the event log, e.g. one entry at every `RoundStarted`,
 * phase change, `SessionPaused`/`Resumed` and `RecordingPaused`/`Resumed`, each carrying the full
 * state from that moment on. Each segment gets the state in effect at its start, plus the number of
 * change points that fall inside it (a segment can straddle a round end).
 */

import type { SpeechSegment } from "./types";

export interface PhaseChange {
  /** Server time from which this state holds (ms). */
  ts: number;
  round: number | null;
  phase: string;
  paused: boolean;
  recordingPaused: boolean;
}

export interface AnnotatedSegment extends SpeechSegment {
  round: number | null;
  phase: string | null;
  paused: boolean;
  recordingPaused: boolean;
  /** Change points strictly inside the segment. */
  phaseChangesInside: number;
}

export function annotate(
  segments: readonly SpeechSegment[],
  phaseTimeline: readonly PhaseChange[],
): AnnotatedSegment[] {
  const changes = [...phaseTimeline].sort((a, b) => a.ts - b.ts);
  // Index of the last change at or before ts (−1 = before the first).
  const at = (ts: number): number => {
    let lo = 0;
    let hi = changes.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (changes[mid]!.ts <= ts) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  };
  return segments.map((seg) => {
    const i = at(seg.startTs);
    const state = i >= 0 ? changes[i]! : null;
    const j = at(seg.endTs - 1e-6);
    return {
      ...seg,
      round: state?.round ?? null,
      phase: state?.phase ?? null,
      paused: state?.paused ?? false,
      recordingPaused: state?.recordingPaused ?? false,
      phaseChangesInside: Math.max(0, j - Math.max(i, -1)),
    };
  });
}
