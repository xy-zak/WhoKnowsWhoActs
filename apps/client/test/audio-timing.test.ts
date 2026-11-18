import { describe, expect, it } from "vitest";
import { ClockMapper, renderOrigin, roundTs } from "../src/audio/timing";

const RATE = 48000;
/** true render origin: context frame 0 was rendered at performance time 1000 ms */
const ORIGIN = 1000;

/** A sample as the main thread would read it at context time t (s), with a delay of `lagMs` since the last render. */
function sample(t: number, lagMs: number, withOutputTimestamp = true) {
  const perfNow = ORIGIN + t * 1000 + lagMs;
  const base = 0.01;
  const output = 0.02;
  return {
    currentTime: t,
    perfNow,
    baseLatency: base,
    outputLatency: output,
    // the frame now at the speakers was rendered (base + output) ago
    ...(withOutputTimestamp
      ? { contextTime: t - base - output, performanceTime: ORIGIN + t * 1000 }
      : { contextTime: 0, performanceTime: 0 }),
  };
}

describe("clock mapping", () => {
  it("derives the render origin from both methods", () => {
    const s = sample(10, 7);
    expect(renderOrigin(s, "current-time")).toBeCloseTo(ORIGIN + 7, 6);
    expect(renderOrigin(s, "output-timestamp")).toBeCloseTo(ORIGIN, 6);
    expect(renderOrigin(sample(10, 7, false), "output-timestamp")).toBeNull();
  });

  it("uses the minimum of current-time samples (one-sided jitter), for the whole track", () => {
    const m = new ClockMapper(RATE);
    for (const [t, lag] of [
      [1, 9],
      [1.04, 3],
      [1.08, 12],
    ] as const)
      expect(m.observe(sample(t, lag, false))).toBe(true);
    expect(m.method).toBe("current-time");
    expect(m.origin()).toBeCloseTo(ORIGIN + 3, 6);
    // output timestamps that appear later do not switch the method mid-track
    for (let i = 0; i < 3; i++) m.observe(sample(1.2 + i * 0.04, 5));
    expect(m.method).toBe("current-time");
    expect(m.origin()).toBeCloseTo(ORIGIN + 3, 6);
  });

  it("uses the median of output timestamps when the track's first sample has one", () => {
    const m = new ClockMapper(RATE);
    for (let i = 0; i < 5; i++) m.observe(sample(1 + i * 0.04, 3 + i));
    expect(m.method).toBe("output-timestamp");
    expect(m.origin()).toBeCloseTo(ORIGIN, 6);
    m.observe(sample(1.3, 4, false)); // a sample without one is ignored by this method
    expect(m.origin()).toBeCloseTo(ORIGIN, 6);
  });

  it("maps a frame to the server epoch", () => {
    const m = new ClockMapper(RATE);
    for (let i = 0; i < 5; i++) m.observe(sample(2 + i * 0.04, 4));
    // frame 96 000 = context time 2 s → rendered at 3000 ms; 5 ms input latency; epoch = perf + 1.7e12
    expect(m.renderPerfMs(96_000)).toBeCloseTo(3000, 6);
    expect(m.captureEpochMs(96_000, 5, 1.7e12)).toBeCloseTo(1.7e12 + 2995, 3);
  });

  it("reports a jump of the audio clock against the performance clock", () => {
    const m = new ClockMapper(RATE);
    for (let i = 0; i < 10; i++) expect(m.observe(sample(1 + i * 0.04, 10))).toBe(true);
    expect(m.observe(sample(1.5, 200))).toBe(true); // within 250 ms of jitter
    // the context stalled for 2 s: same context time, much later performance time
    expect(m.observe(sample(1.54, 2010))).toBe(false);
    expect(m.origin()).toBeCloseTo(ORIGIN, 6); // the rejected sample was not added
  });

  it("rounds timestamps to 1 µs", () => {
    expect(roundTs(1.23456789)).toBe(1.235);
  });
});
