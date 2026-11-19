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
 * (two tracks) and one lost chunk of seat 2. The sources are speech-like noise, so speech is
 * detected by energy here (the Silero model only fires on real voices).
 */
function run(profile: Profile, seed: number, calibration = true): { s: SynthSession; r: AttributionResult } {
  const s = synthesise({
    seed,
    durationSec: 240,
    profile,
    gaps: [{ seat: 3, fromSec: 120, toSec: 140 }],
    lostChunks: [{ seat: 2, chunk: 30 }],
  });
  const r = analyse({
    tracks: trackInputs(s),
    seats: [1, 2, 3, 4],
    calibration: calibration ? { turns: s.turns } : null,
  });
  return { s, r };
}

describe("attribution accuracy (synthetic mixes)", () => {
  it("headsets: ≥ 98 % single-speaker accuracy, ≥ 90 % overlap recall, < 3 % false talk", () => {
    const { s, r } = run("headset", 1);
    const ev = evaluate(r, s);
    expect(ev.singleFrames).toBeGreaterThan(10_000);
    expect(ev.overlapFrames).toBeGreaterThan(800);
    expect(ev.singleAccuracy).toBeGreaterThanOrEqual(0.98);
    expect(ev.overlapRecall).toBeGreaterThanOrEqual(0.9);
    expect(ev.falseTalk).toBeLessThan(0.03);
    expect(ev.speechInGaps).toBeLessThanOrEqual(5);
    // the clock fit alone places every track within the devices' latency spread (0–50 ms)
    const bias = anchorBias(r, s);
    expect(r.alignment).toHaveLength(5);
    for (const a of r.alignment) {
      const t = s.tracks.find((x) => x.trackId === a.trackId)!;
      expect(alignmentError(a, t, bias)).toBeLessThan(60);
    }
    // calibration: every seat passes, leakage measured against the known mix
    expect(r.leakage.source).toBe("calibration");
    expect(r.quality.calibration?.every((q) => q.ok)).toBe(true);
    for (const [i, row] of r.leakage.matrixDb.entries())
      for (const [j, g] of row.entries()) expect(Math.abs(g! - s.leakageDb[i]![j]!)).toBeLessThan(2);
    // no seat-3 speech inside its dropout
    for (const seg of r.segments.filter((x) => x.seat === 3))
      expect(seg.endTs <= s.t0 + 120_050 || seg.startTs >= s.t0 + 139_950).toBe(true);
    expect(r.quality.grade).not.toBe("poor");
    expect(r.quality.warnings.some((w) => w.startsWith("Seat 3: no usable audio"))).toBe(true);
    expect(r.quality.seats.find((q) => q.seat === 2)!.coverage).toBeLessThan(0.985);
    for (const seat of [1, 2, 3, 4]) {
      const sum = r.segments.filter((x) => x.seat === seat).reduce((a, x) => a + x.durationMs, 0);
      expect(r.talkTimeMs[seat]).toBe(sum);
    }
    expect(r.overlapMs).toBeGreaterThan(0);
  }, 60_000);

  it("headsets without calibration: the conservative default keeps single speakers right", () => {
    const { s, r } = run("headset", 2, false);
    const ev = evaluate(r, s);
    expect(r.leakage.source).toBe("default");
    expect(r.quality.calibration).toBeNull();
    expect(r.quality.warnings.some((w) => w.startsWith("No calibration"))).toBe(true);
    expect(ev.singleAccuracy).toBeGreaterThanOrEqual(0.97);
    expect(ev.falseTalk).toBeLessThan(0.03);
  }, 60_000);

  it("laptop mics: single speakers still mostly right, but low margins are flagged", () => {
    const { s, r } = run("laptop", 1);
    const ev = evaluate(r, s);
    expect(ev.singleAccuracy).toBeGreaterThanOrEqual(0.93);
    expect(ev.falseTalk).toBeLessThan(0.03);
    const low = r.quality.calibration!.filter((q) => q.issues.includes("low_margin"));
    expect(low.length).toBeGreaterThan(0);
    for (const q of low) {
      expect(q.ok).toBe(false);
      expect(r.quality.warnings.some((w) => w.startsWith(`Seat ${q.seat}: own voice only`))).toBe(true);
    }
    expect(r.quality.grade).not.toBe("good");
  }, 60_000);

  it("is deterministic and fast (4 seats × 4 min well under a second)", () => {
    const a = run("headset", 3);
    const tracks = trackInputs(a.s);
    const t = performance.now();
    const b = analyse({ tracks, seats: [1, 2, 3, 4], calibration: { turns: a.s.turns } });
    expect(performance.now() - t).toBeLessThan(2000);
    expect(b.segments).toEqual(a.r.segments);
    expect(b.leakage.matrixDb).toEqual(a.r.leakage.matrixDb);
  }, 60_000);
});
