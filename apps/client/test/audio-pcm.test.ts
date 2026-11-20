import { int16FromLeBytes, int16ToLeBytes } from "@wkwa/shared";
import { describe, expect, it } from "vitest";
import { Chunker, isClippedInt16, toInt16 } from "../src/audio/chunker";
import { LevelMeter, MIN_DB, roundDb, toDb } from "../src/audio/levels";
import { TrackPipeline } from "../src/audio/pipeline";
import { resampledLength } from "../src/audio/resampler";

describe("Int16 conversion", () => {
  it("scales symmetrically, rounds and clamps", () => {
    expect(toInt16(0)).toBe(0);
    expect(toInt16(0.5)).toBe(16384);
    expect(toInt16(-0.5)).toBe(-16384);
    expect(toInt16(-1)).toBe(-32768);
    expect(toInt16(1)).toBe(32767);
    expect(toInt16(3)).toBe(32767);
    expect(toInt16(-3)).toBe(-32768);
    expect(toInt16(1 / 65536)).toBe(1); // rounds half up
    expect(toInt16(Number.NaN)).toBe(0);
  });

  it("counts samples at or beyond full scale as clipped", () => {
    const samples = [0, 0.25, 0.9999, 1, 1.5, -1, -0.99, -2].map(toInt16);
    expect(samples).toEqual([0, 8192, 32765, 32767, 32767, -32768, -32440, -32768]);
    expect(samples.filter(isClippedInt16)).toHaveLength(4);
  });

  it("writes and reads little-endian s16 bytes", () => {
    const big = new Int16Array([9, 1, -2, 0x1234, -32768, 32767, 9]);
    const bytes = int16ToLeBytes(big.subarray(1, 6));
    expect(bytes.byteLength).toBe(10);
    expect(Array.from(bytes.subarray(0, 8))).toEqual([1, 0, 0xfe, 0xff, 0x34, 0x12, 0x00, 0x80]);
    expect(Array.from(int16FromLeBytes(bytes))).toEqual([1, -2, 0x1234, -32768, 32767]);
    // unaligned bytes are copied
    const odd = new Uint8Array(11);
    odd.set(bytes, 1);
    expect(Array.from(int16FromLeBytes(odd.subarray(1)))).toEqual([1, -2, 0x1234, -32768, 32767]);
  });
});

describe("levels", () => {
  it("measures dBFS", () => {
    expect(toDb(1)).toBe(0);
    expect(toDb(0.5)).toBeCloseTo(-6.0206, 3);
    expect(toDb(0)).toBe(MIN_DB);
    expect(toDb(1e-9)).toBe(MIN_DB);
    expect(roundDb(-6.0206)).toBe(-6);
  });

  it("reports a level every 250 ms of samples", () => {
    const levels: Array<{ rmsDb: number; peakDb: number; ms: number }> = [];
    const m = new LevelMeter({ sampleRate: 16000, onLevel: (l, ms) => levels.push({ ...l, ms }) });
    const x = new Float32Array(16000 + 100).map((_, i) => (i < 4000 ? 0 : 0.5 * Math.sin(i)));
    for (let i = 0; i < x.length; i += 333) m.push(x.subarray(i, i + 333));
    expect(levels).toHaveLength(4);
    expect(levels[0]).toEqual({ rmsDb: MIN_DB, peakDb: MIN_DB, ms: 250 });
    expect(levels[1]!.rmsDb).toBeCloseTo(-9, 0);
    expect(levels[1]!.peakDb).toBeCloseTo(-6, 0);
  });
});

describe("chunker", () => {
  it("cuts contiguous chunks and flushes the partial last one", () => {
    const c = new Chunker(1000);
    const drafts = [];
    let fed = 0;
    for (const n of [1, 999, 1500, 7, 493, 2500, 10]) {
      drafts.push(...c.push(new Float32Array(n).fill(0.25)));
      fed += n;
    }
    expect(drafts.map((d) => d.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(c.totalSamples).toBe(fed);
    const last = c.flush();
    expect(last).not.toBeNull();
    drafts.push(last!);
    expect(c.flush()).toBeNull();
    let next = 0;
    for (const [i, d] of drafts.entries()) {
      expect(d.seq).toBe(i);
      expect(d.startSample).toBe(next);
      expect(d.pcm.byteLength).toBe(d.sampleCount * 2);
      next += d.sampleCount;
    }
    expect(next).toBe(fed);
    expect(drafts.at(-1)!.sampleCount).toBe(fed % 1000);
    expect(drafts.slice(0, -1).every((d) => d.sampleCount === 1000)).toBe(true);
    expect(c.chunks).toBe(drafts.length);
  });

  it("measures each chunk from its Int16 samples", () => {
    const c = new Chunker(4);
    const [a, b] = c.push([0.5, -0.5, 0.5, -0.5, 1, 0, -1.2, 0]);
    expect(a).toMatchObject({ rmsDb: -6, peakDb: -6, clippedSamples: 0, sampleCount: 4 });
    expect(b).toMatchObject({ peakDb: 0, clippedSamples: 2, startSample: 4 });
    expect(Array.from(int16FromLeBytes(b!.pcm))).toEqual([32767, 0, -32768, 0]);
    expect(b!.pcm.buffer.byteLength).toBe(8); // its own exact-size buffer
    // chunks own their bytes: later pushes do not change them
    c.push([0, 0, 0, 0]);
    expect(Array.from(int16FromLeBytes(a!.pcm))).toEqual([16384, -16384, 16384, -16384]);
  });

  it("rejects a bad chunk size", () => {
    expect(() => new Chunker(0)).toThrow(RangeError);
    expect(() => new Chunker(2.5)).toThrow(RangeError);
  });
});

describe("track pipeline", () => {
  it("turns native-rate blocks into 5 s chunks of 16 kHz with an exact total", () => {
    for (const rate of [48000, 44100]) {
      const drafts: Array<{ startSample: number; sampleCount: number }> = [];
      let outputs = 0;
      const p = new TrackPipeline({
        inputRate: rate,
        chunkSamples: 80000,
        onChunk: (d) => drafts.push(d),
        onOutput: (s) => {
          outputs += s.length;
        },
      });
      const frames = Math.round(rate * 11.3);
      for (let i = 0; i < frames; i += 1920) p.push(new Float32Array(Math.min(1920, frames - i)).fill(0.1));
      p.finish();
      p.finish();
      expect(drafts.map((d) => d.sampleCount)).toEqual([
        80000,
        80000,
        resampledLength(frames, rate) - 160000,
      ]);
      expect(drafts.map((d) => d.startSample)).toEqual([0, 80000, 160000]);
      expect(outputs).toBe(resampledLength(frames, rate));
      expect(p.outputSamples).toBe(outputs);
      expect(p.inputFrames).toBe(frames);
    }
  });
});
