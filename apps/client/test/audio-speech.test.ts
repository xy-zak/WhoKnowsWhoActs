import { mulberry32 } from "@wkwa/shared";
import { describe, expect, it } from "vitest";
import { SpeechDetector } from "../src/audio/speech";

const RATE = 16000;

/** Deterministic Gaussian noise (mulberry32 + Box–Muller). */
function noise(seed: number) {
  const r = mulberry32(seed);
  const u = () => 1 - r(); // (0, 1]: never log(0)
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}

const db = (x: number) => 10 ** (x / 20);

/** Background noise at `floorDb` RMS, with optional speech-like bursts: noise modulated at a syllable rate (4 Hz). */
function signal(
  seconds: number,
  floorDb: number,
  bursts: Array<{ at: number; len: number; db: number }> = [],
) {
  const n = Math.round(seconds * RATE);
  const x = new Float32Array(n);
  const g = noise(42);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    let v = g() * db(floorDb);
    for (const b of bursts) {
      if (t >= b.at && t < b.at + b.len) {
        const env = 0.15 + 0.85 * Math.abs(Math.sin(2 * Math.PI * 2 * (t - b.at))); // 4 bumps per second
        v += g() * db(b.db) * env;
      }
    }
    x[i] = v;
  }
  return x;
}

function feed(det: SpeechDetector, x: Float32Array, block = 640) {
  let r = det.result;
  for (let i = 0; i < x.length; i += block) r = det.push(x.subarray(i, i + block));
  return r;
}

describe("speech detector (mic check)", () => {
  it("does not pass on noise only", () => {
    const r = feed(new SpeechDetector(), signal(6, -50));
    expect(r.passed).toBe(false);
    expect(r.speechMs).toBe(0);
    expect(r.noiseFloorDb).toBeGreaterThan(-53);
    expect(r.noiseFloorDb).toBeLessThan(-49);
    expect(r.analysedMs).toBe(6000);
  });

  it("passes on a ~1.2 s speech-like burst", () => {
    const r = feed(new SpeechDetector(), signal(4, -55, [{ at: 1.5, len: 1.2, db: -22 }]));
    expect(r.passed).toBe(true);
    expect(r.speechMs).toBeGreaterThanOrEqual(1000);
    expect(r.speechMs).toBeLessThanOrEqual(1250);
    expect(r.noiseFloorDb).toBeLessThan(-54);
    expect(r.speechDb).toBeGreaterThan(-30);
    expect(r.speechDb).toBeLessThan(-20);
  });

  it("does not pass on a burst shorter than minSpeechMs, but adds up several", () => {
    expect(feed(new SpeechDetector(), signal(3, -55, [{ at: 1, len: 0.6, db: -22 }])).passed).toBe(false);
    const two = feed(
      new SpeechDetector(),
      signal(5, -55, [
        { at: 1, len: 0.6, db: -22 },
        { at: 3, len: 0.6, db: -22 },
      ]),
    );
    expect(two.passed).toBe(true);
  });

  it("is not fooled by digital silence before the room noise starts", () => {
    const x = signal(5, -50);
    x.fill(0, 0, RATE / 2); // first 500 ms: zeros, as from a fresh stream
    const r = feed(new SpeechDetector(), x);
    expect(r.passed).toBe(false);
    expect(r.speechMs).toBe(0);
  });

  it("does not count quiet sounds below the absolute minimum", () => {
    const r = feed(new SpeechDetector(), signal(4, -90, [{ at: 1, len: 2, db: -70 }]));
    expect(r.passed).toBe(false);
  });

  it("honours minSpeechMs and reset()", () => {
    const det = new SpeechDetector({ minSpeechMs: 400 });
    expect(feed(det, signal(3, -55, [{ at: 1, len: 0.6, db: -22 }])).passed).toBe(true);
    det.reset();
    expect(det.result).toMatchObject({ speechMs: 0, passed: false, analysedMs: 0, noiseFloorDb: -100 });
  });
});
