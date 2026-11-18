import { describe, expect, it } from "vitest";
import { analyse, EnvelopeBuilder, type TrackInput } from "../src/audio/attribution";
import { deliveredChunks, evaluate, synthesise } from "./attributionSynth";

describe("attribution performance", () => {
  it("analyses 10 minutes of 4-channel audio (envelopes + analysis) in under 10 s", () => {
    const s = synthesise({ seed: 31, durationSec: 600, profile: "headset" });
    const started = performance.now();
    const tracks: TrackInput[] = s.tracks.map((t) => {
      const b = new EnvelopeBuilder();
      for (const c of deliveredChunks(t)) b.push(c.samples, c.startSample);
      return { trackId: t.trackId, seat: t.seat, chunks: t.chunks, envelope: b.finish() };
    });
    const envMs = performance.now() - started;
    const r = analyse({ tracks, seats: [1, 2, 3, 4], calibration: { turns: s.turns } });
    const totalMs = performance.now() - started;
    console.log(
      `10 min × 4 seats: envelopes ${envMs.toFixed(0)} ms, analysis ${(totalMs - envMs).toFixed(0)} ms`,
      JSON.stringify(r.timingsMs),
    );
    expect(totalMs).toBeLessThan(10_000);
    expect(evaluate(r, s).singleAccuracy).toBeGreaterThanOrEqual(0.97);
    // Drift: relative to the anchor, every device's drift is recovered within ±5 ppm over 10 min.
    const anchor = r.alignment.find((a) => a.anchor)!;
    const trueAnchor = s.tracks.find((t) => t.trackId === anchor.trackId)!.driftPpm;
    for (const a of r.alignment) {
      const t = s.tracks.find((x) => x.trackId === a.trackId)!;
      expect(Math.abs(a.driftPpm - anchor.driftPpm - (t.driftPpm - trueAnchor))).toBeLessThan(5);
    }
  }, 120_000);
});
