import { mulberry32 as rng } from "@wkwa/shared";
import { describe, expect, it } from "vitest";
import { Resampler, resampledLength } from "../src/audio/resampler";

function sine(freq: number, rate: number, seconds: number, amp = 0.5): Float32Array {
  const n = Math.round(rate * seconds);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return x;
}

function concat(parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function rmsDb(x: Float32Array, from: number, to: number): number {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i]! * x[i]!;
  return 10 * Math.log10(s / (to - from));
}

function resampleAll(rate: number, x: Float32Array, blocks?: () => number): Float32Array {
  const r = new Resampler({ inputRate: rate });
  const parts: Float32Array[] = [];
  let i = 0;
  while (i < x.length) {
    const n = blocks ? Math.min(x.length - i, blocks()) : x.length;
    parts.push(r.process(x.subarray(i, i + n)));
    i += n;
  }
  parts.push(r.flush());
  return concat(parts);
}

describe("resampler", () => {
  for (const rate of [48000, 44100]) {
    it(`keeps a 1 kHz sine from ${rate} Hz: amplitude and timing`, () => {
      const x = sine(1000, rate, 1);
      const out = resampleAll(rate, x);
      expect(out.length).toBe(16000);
      // skip the first/last 10 ms (zero padding at the ends)
      const inDb = rmsDb(x, rate / 100, x.length - rate / 100);
      expect(Math.abs(rmsDb(out, 160, out.length - 160) - inDb)).toBeLessThan(0.05);
      // output sample k is the input at time k / 16 000 s: no delay, no phase shift
      let maxErr = 0;
      for (let k = 160; k < out.length - 160; k++) {
        maxErr = Math.max(maxErr, Math.abs(out[k]! - 0.5 * Math.sin((2 * Math.PI * 1000 * k) / 16000)));
      }
      expect(maxErr).toBeLessThan(1e-3);
    });

    it(`attenuates 10 kHz from ${rate} Hz by more than 40 dB (anti-aliasing)`, () => {
      const ref = rmsDb(sine(1000, rate, 1), 0, rate);
      for (const f of [8500, 10000, 15000, 20000]) {
        const out = resampleAll(rate, sine(f, rate, 1));
        const attenuation = ref - rmsDb(out, 160, out.length - 160);
        expect(attenuation, `${f} Hz`).toBeGreaterThan(f === 10000 ? 40 : 60);
      }
    });

    it(`gives the same output from ${rate} Hz whatever the block sizes`, () => {
      const r = rng(7);
      const x = new Float32Array(rate * 3).map(() => r() - 0.5);
      const whole = resampleAll(rate, x);
      const blocks = rng(rate);
      const split = resampleAll(rate, x, () => 1 + Math.floor(blocks() * 5000));
      expect(split.length).toBe(whole.length);
      expect(Buffer.from(split.buffer).equals(Buffer.from(whole.buffer))).toBe(true);
    });
  }

  it("produces the exact sample count over 10 minutes of 44.1 kHz input in random block sizes", () => {
    const rate = 44100; // a non-integer ratio to 16 kHz: rounding errors would accumulate
    const noise = new Float32Array(8192).map(rng(rate));
    const r = new Resampler({ inputRate: rate });
    const blocks = rng(rate + 1);
    const total = rate * 600 + 77; // not a whole number of output periods
    let fed = 0;
    let produced = 0;
    while (fed < total) {
      const n = Math.min(total - fed, 1 + Math.floor(blocks() * 8191));
      produced += r.process(noise.subarray(0, n)).length;
      fed += n;
      // never ahead of the input: output k needs input position k·rate/16000
      expect(produced * rate).toBeLessThanOrEqual(fed * 16000);
    }
    produced += r.flush().length;
    expect(produced).toBe(resampledLength(total, rate));
    expect(produced).toBe(Math.ceil((total * 16000) / rate));
    expect(r.outputSamples).toBe(produced);
    expect(r.inputSamples).toBe(total);
  }, 60_000);

  it("handles other device rates, including upsampling and an odd rate", () => {
    for (const rate of [8000, 22050, 32000, 96000, 44056]) {
      const x = sine(1000, rate, 1);
      const out = resampleAll(rate, x, () => 1000);
      expect(out.length, `${rate}`).toBe(resampledLength(x.length, rate));
      const inDb = rmsDb(x, 0, x.length);
      expect(Math.abs(rmsDb(out, 400, out.length - 400) - inDb), `${rate}`).toBeLessThan(0.1);
    }
  });

  it("rejects bad rates and use after flush", () => {
    expect(() => new Resampler({ inputRate: 0 })).toThrow(RangeError);
    expect(() => new Resampler({ inputRate: 44100.5 })).toThrow(RangeError);
    const r = new Resampler({ inputRate: 48000 });
    r.flush();
    expect(r.flush().length).toBe(0);
    expect(() => r.process(new Float32Array(10))).toThrow();
  });
});
