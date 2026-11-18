import { describe, expect, it } from "vitest";
import { type AttributionResult, analyse } from "../src/audio/attribution";
import {
  alignmentError,
  anchorBias,
  evaluate,
  type Profile,
  type SynthSession,
  synthesise,
  trackInputs,
} from "./attributionSynth";

/**
 * Accuracy on synthetic 4-minute, four-seat sessions with calibration, ±100 ppm drift, 0–50 ms
 * device latency, ±20 ms timestamp jitter, ≈ 10 % overlapping speech, a 20 s dropout of seat 3
 * (two tracks; seat 3 talks during the dropout) and one lost chunk of seat 2.
 */
function run(profile: Profile, seed: number, calibration = true): { s: SynthSession; r: AttributionResult } {
  const s = synthesise({
    seed,
    durationSec: 240,
    profile,
    gaps: [{ seat: 3, fromSec: 120, toSec: 140 }],
    forced: [{ seat: 3, atSec: 125, durSec: 4 }],
    lostChunks: [{ seat: 2, chunk: 30 }],
  });
  const r = analyse({
    tracks: trackInputs(s),
    seats: [1, 2, 3, 4],
    calibration: calibration ? { turns: s.turns } : null,
  });
  return { s, r };
}

function checkAlignmentAndLeakage(s: SynthSession, r: AttributionResult): void {
  const bias = anchorBias(r, s);
  expect(r.alignment).toHaveLength(5);
  for (const a of r.alignment) {
    const t = s.tracks.find((x) => x.trackId === a.trackId)!;
    // Relative alignment (what the audio can tell) within ±10 ms everywhere in the track.
    expect(alignmentError(a, t, bias)).toBeLessThan(10);
    expect(a.confidence).toBeGreaterThan(0.5);
  }
  expect(r.leakage.source).toBe("calibration");
  r.leakage.matrixDb.forEach((row, i) => {
    row.forEach((g, j) => {
      expect(g).not.toBeNull();
      if (!r.leakage.belowFloor[i]![j]) expect(Math.abs(g! - s.leakageDb[i]![j]!)).toBeLessThan(1.5);
    });
  });
}

function checkGap(s: SynthSession, r: AttributionResult): void {
  // No seat-3 speech inside its dropout (allow the track edges themselves).
  const gapFrom = s.t0 + 120_000 + 50;
  const gapTo = s.t0 + 140_000 - 50;
  for (const seg of r.segments) {
    if (seg.seat !== 3) continue;
    expect(seg.endTs <= gapFrom || seg.startTs >= gapTo).toBe(true);
  }
}

describe("attribution accuracy (synthetic mixes)", () => {
  it("headset-like mics: ≥ 97 % single-speaker accuracy, ≥ 80 % overlap recall, < 2 % false talk", () => {
    const { s, r } = run("headset", 1);
    const ev = evaluate(r, s);
    expect(ev.singleFrames).toBeGreaterThan(10_000);
    expect(ev.overlapFrames).toBeGreaterThan(800);
    expect(ev.singleAccuracy).toBeGreaterThanOrEqual(0.97);
    expect(ev.overlapRecall).toBeGreaterThanOrEqual(0.8);
    expect(ev.falseTalk).toBeLessThan(0.02);
    expect(ev.speechInGaps).toBeLessThanOrEqual(5);
    // Seat 3 speaks during its own dropout: nobody else gets the credit.
    expect(ev.absentFrames).toBeGreaterThan(200);
    expect(ev.absentCredited / ev.absentFrames).toBeLessThan(0.05);
    checkAlignmentAndLeakage(s, r);
    checkGap(s, r);
    expect(r.quality.calibration?.every((q) => q.ok)).toBe(true);
    expect(r.quality.grade).not.toBe("poor");
    expect(r.quality.warnings.some((w) => w.startsWith("Seat 3: no usable audio"))).toBe(true);
    expect(r.quality.seats.find((q) => q.seat === 2)!.noDataShare).toBeGreaterThan(0.015);
    // Talk time is consistent with the segments.
    for (const seat of [1, 2, 3, 4]) {
      const sum = r.segments.filter((x) => x.seat === seat).reduce((a, x) => a + x.durationMs, 0);
      expect(r.talkTimeMs[seat]).toBe(sum);
    }
    expect(r.overlapMs).toBeGreaterThan(0);
  }, 60_000);

  it("laptop-like mics: ≥ 90 % single-speaker accuracy and low-margin warnings", () => {
    const { s, r } = run("laptop", 1);
    const ev = evaluate(r, s);
    expect(ev.singleAccuracy).toBeGreaterThanOrEqual(0.9);
    expect(ev.falseTalk).toBeLessThan(0.05);
    expect(ev.speechInGaps).toBeLessThanOrEqual(5);
    checkAlignmentAndLeakage(s, r);
    checkGap(s, r);
    const cal = r.quality.calibration!;
    const low = cal.filter((q) => q.issues.includes("low_margin"));
    expect(low.length).toBeGreaterThan(0);
    for (const q of low) {
      expect(q.ok).toBe(false);
      expect(q.marginDb!).toBeLessThan(10);
      expect(r.quality.warnings.some((w) => w.startsWith(`Seat ${q.seat} calibration: own voice only`))).toBe(
        true,
      );
    }
    expect(r.quality.grade).not.toBe("good");
  }, 60_000);

  it("without calibration, estimates the leakage from the session (headset ≥ 95 %)", () => {
    const { s, r } = run("headset", 2, false);
    const ev = evaluate(r, s);
    expect(r.leakage.source).toBe("estimated");
    expect(r.quality.calibration).toBeNull();
    expect(r.quality.warnings.some((w) => w.startsWith("No calibration"))).toBe(true);
    expect(ev.singleAccuracy).toBeGreaterThanOrEqual(0.95);
    expect(ev.falseTalk).toBeLessThan(0.02);
  }, 60_000);

  it("is deterministic", () => {
    const a = run("headset", 3);
    const b = run("headset", 3);
    expect(b.r.segments).toEqual(a.r.segments);
    expect(b.r.leakage.matrixDb).toEqual(a.r.leakage.matrixDb);
  }, 60_000);
});
