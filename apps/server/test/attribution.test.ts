import { describe, expect, it } from "vitest";
import {
  analyse,
  annotate,
  type ChunkMeta,
  FeatureBuilder,
  fitClock,
  loadSilero,
  maskToRuns,
  quickCalibrationCheck,
  runsToMask,
  type SpeechSegment,
  type TrackInput,
  type Vad,
} from "../src/audio/attribution";
import { smoothSpeech } from "../src/audio/attribution/smooth";
import {
  encodeWav,
  parseWavHeader,
  WAV_HEADER_BYTES,
  WavWriter,
  wavHeader,
  wavStream,
} from "../src/audio/wav";
import { mulberry32, synthesise, trackInputs } from "./attributionSynth";

/** Wall-clock limits are checked in the normal run only: coverage instrumentation slows the code down. */
const TIMED = !process.env.WKWA_COVERAGE;

const FS = 16_000;

function sine(n: number, amp: number, hz = 400): Int16Array {
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(amp * Math.sin((2 * Math.PI * hz * i) / FS));
  return out;
}

function features(pcm: Int16Array, blocks = pcm.length) {
  const b = new FeatureBuilder();
  for (let i = 0; i < pcm.length; i += blocks) b.push(pcm.subarray(i, i + blocks), i);
  return b.finish();
}

describe("FeatureBuilder", () => {
  it("measures a sine at its true level, independent of block size", () => {
    const pcm = sine(FS, 32767 * 10 ** (-20 / 20)); // peak −20 dBFS ⇒ RMS −23 dBFS
    const whole = features(pcm);
    const blocks = features(pcm, 777);
    expect(whole.frames).toBe(100);
    expect(whole.speech).toBeNull();
    for (let k = 5; k < 95; k++) {
      expect(whole.energyDb[k]!).toBeCloseTo(-23.01, 0);
      expect(blocks.energyDb[k]!).toBeCloseTo(whole.energyDb[k]!, 4);
    }
  });

  it("marks gaps as no data, skips resent overlaps and flags clipping", () => {
    const b = new FeatureBuilder();
    const a = sine(8000, 1000);
    b.push(a, 0);
    b.push(a.subarray(0, 4000), 4000); // re-sent overlap: skipped
    b.push(sine(8000, 32767), 16_000); // after a gap of 8000 samples, clipping
    const f = b.finish();
    expect(f.frames).toBe(150);
    expect(Number.isNaN(f.energyDb[60]!)).toBe(true);
    expect(Number.isNaN(f.energyDb[40]!)).toBe(false);
    expect(f.clipped[120]).toBe(1);
    expect(f.clipped[20]).toBe(0);
  });

  it("removes DC offset and rumble before measuring energy", () => {
    const f = features(new Int16Array(FS).fill(3000));
    expect(f.energyDb[50]!).toBeLessThan(-60);
    expect(features(sine(FS, 10_000, 30)).energyDb[50]!).toBeLessThan(
      features(sine(FS, 10_000, 400)).energyDb[50]! - 9,
    );
  });

  it("gives every frame the probability of the detector window around its centre, restarting after a gap", async () => {
    const calls: number[] = [];
    let resets = 0;
    const vad: Vad = {
      windowSamples: 512,
      reset: () => resets++,
      next: async (w) => {
        calls.push(w.length);
        return w[0]! > 0 ? 0.9 : 0.1;
      },
    };
    const b = new FeatureBuilder(vad);
    b.push(new Int16Array(5120).fill(1000), 0); // 10 windows of "speech"
    await b.drain();
    b.push(new Int16Array(5120).fill(-1000), 10_240); // after a gap: 10 windows of "silence"
    await b.drain();
    const f = b.finish();
    expect(calls).toHaveLength(20);
    expect(resets).toBe(2);
    expect(f.speech![10]).toBeCloseTo(0.9);
    expect(Number.isNaN(f.speech![40]!)).toBe(true); // in the gap
    expect(f.speech![70]).toBeCloseTo(0.1);
  });
});

describe("clock fit", () => {
  function track(seed: number, minutes: number, driftPpm: number, outliers = 0): ChunkMeta[] {
    const r = mulberry32(seed);
    const chunks: ChunkMeta[] = [];
    const start = 1_763_000_000_000;
    const n = (minutes * 60) / 5;
    for (let k = 0; k < n; k++) {
      const startSample = k * 80_000;
      const trueMs = start + (startSample / (FS * (1 + driftPpm * 1e-6))) * 1000;
      let clientTs = trueMs + 35 + (r() * 40 - 20);
      if (k > 0 && k <= outliers) clientTs += 800 * (k % 2 ? 1 : -1); // clock-sync glitches
      chunks.push({ seq: k, startSample, sampleCount: 80_000, clientTs, serverTs: clientTs + 5040 });
    }
    return chunks;
  }

  it("estimates drift within ±5 ppm over a session-length track, despite outliers", () => {
    for (const [seed, drift] of [
      [1, 87],
      [2, -95],
      [3, 12],
      [4, -40],
    ] as const) {
      const f = fitClock({ trackId: "t", seat: 1, sampleRate: FS, chunks: track(seed, 30, drift, 6) })!;
      expect(Math.abs(f.driftPpm - drift)).toBeLessThan(5);
      expect(Math.abs(f.startTs - (1_763_000_000_000 + 35))).toBeLessThan(5);
      expect(f.residualMs).toBeLessThan(15);
    }
  });

  it("keeps the nominal rate on short tracks and on implausible timestamps", () => {
    const short = fitClock({ trackId: "t", seat: 1, sampleRate: FS, chunks: track(5, 0.5, 90) })!;
    expect(short.driftPpm).toBe(0);
    const broken = track(6, 10, 0).map((c, k) => ({ ...c, clientTs: c.clientTs + k * 50 })); // +1 %
    const f = fitClock({ trackId: "t", seat: 1, sampleRate: FS, chunks: broken })!;
    expect(f.implausible).toBe(true);
    expect(f.driftPpm).toBe(0);
  });
});

describe("gate", () => {
  /** Two seats, one track each, from frame levels (10 ms frames, all "speech" to the detector). */
  function session(levels: number[][]): { tracks: TrackInput[]; t0: number } {
    const t0 = 1_763_000_000_000;
    const frames = levels[0]!.length;
    const tracks = levels.map((lv, s) => ({
      trackId: `00000000-0000-4000-8000-00000000000${s}`,
      seat: s + 1,
      chunks: [{ seq: 0, startSample: 0, sampleCount: frames * 160, clientTs: t0, serverTs: t0 }],
      features: {
        frames,
        energyDb: Float32Array.from(lv),
        clipped: new Uint8Array(frames),
        speech: Float32Array.from(lv, (e) => (e > -50 ? 0.95 : 0.05)),
      },
    }));
    return { tracks, t0 };
  }
  const run = (n: number, v: number) => new Array<number>(n).fill(v);

  it("credits the speaker, not the mic that hears the leak, and keeps real overlap", () => {
    // 1 s silence, seat 1 speaks 1 s (leak −20 dB on mic 2), both speak 1 s, silence
    const mic1 = [...run(100, -70), ...run(100, -25), ...run(100, -25), ...run(100, -70)];
    const mic2 = [...run(100, -70), ...run(100, -45), ...run(100, -28), ...run(100, -70)];
    const { tracks, t0 } = session([mic1, mic2]);
    const r = analyse({ tracks, options: { defaultLeakageDb: -15 } });
    expect(r.quality.detector).toBe("silero");
    const seat1 = r.segments.filter((x) => x.seat === 1);
    const seat2 = r.segments.filter((x) => x.seat === 2);
    expect(seat1).toHaveLength(1);
    expect(seat1[0]!.startTs).toBeCloseTo(t0 + 1000 - 20, -1);
    expect(seat2).toHaveLength(1);
    expect(seat2[0]!.startTs).toBeGreaterThanOrEqual(t0 + 1900);
    expect(seat2[0]!.overlapWith).toEqual([1]);
    expect(r.overlapMs).toBeGreaterThan(900);
  });

  it("falls back to energy above the noise floor without a detector, and says so", () => {
    const mic1 = [...run(200, -70), ...run(100, -25), ...run(200, -70)];
    const mic2 = [...run(200, -70), ...run(100, -45), ...run(200, -70)];
    const { tracks } = session([mic1, mic2]);
    for (const t of tracks) (t.features as { speech: Float32Array | null }).speech = null;
    const r = analyse({ tracks });
    expect(r.quality.detector).toBe("energy");
    expect(r.quality.warnings.some((w) => w.startsWith("No speech detector"))).toBe(true);
    expect(r.segments.map((x) => x.seat)).toEqual([1]);
  });
});

describe("Silero VAD", () => {
  it("loads the shipped model (checksum verified) and scores windows quickly", async () => {
    const vad = await loadSilero();
    const r = mulberry32(1);
    const noise = Float32Array.from({ length: 512 }, () => (r() - 0.5) * 0.02);
    vad.reset();
    const t = performance.now();
    let p = 0;
    for (let i = 0; i < 100; i++) p = await vad.next(noise);
    expect(p).toBeGreaterThanOrEqual(0);
    expect(p).toBeLessThan(0.5); // quiet noise is not speech
    if (TIMED) expect((performance.now() - t) / 100).toBeLessThan(5);
  });
});

describe("smoothing and masks", () => {
  const p = { minGap: 20, minSpeech: 25, hangover: 10, preRoll: 2 };
  it("bridges short pauses, drops short blips and adds hangover, but never across gaps", () => {
    const raw = new Uint8Array(400);
    raw.fill(1, 10, 60);
    raw.fill(1, 75, 120); // 15-frame pause: bridged
    raw.fill(1, 200, 210); // 100 ms blip: dropped
    raw.fill(1, 300, 340);
    const valid = new Uint8Array(400).fill(1);
    valid.fill(0, 345, 400); // no data after 345: hangover stops there
    const m = smoothSpeech(raw, valid, p);
    expect(maskToRuns(m)).toEqual([8, 130, 298, 345]);
  });

  it("does not bridge a pause that contains no data", () => {
    const raw = new Uint8Array(200);
    raw.fill(1, 10, 60);
    raw.fill(1, 70, 120);
    const valid = new Uint8Array(200).fill(1);
    valid[65] = 0;
    const m = smoothSpeech(raw, valid, { ...p, hangover: 0, preRoll: 0 });
    expect(maskToRuns(m)).toEqual([10, 60, 70, 120]);
  });

  it("round-trips run-length masks", () => {
    const m = new Uint8Array(50);
    m.fill(1, 3, 9);
    m.fill(1, 40, 50);
    expect(runsToMask(maskToRuns(m), 50)).toEqual(m);
  });
});

describe("annotate", () => {
  it("adds round, phase and pause state from change points", () => {
    const seg = (startTs: number, endTs: number): SpeechSegment => ({
      seat: 1,
      startTs,
      endTs,
      durationMs: endTs - startTs,
      meanDb: -30,
      confidence: 0.9,
      overlap: false,
      overlapMs: 0,
      overlapWith: [],
    });
    const out = annotate(
      [seg(500, 900), seg(1500, 2500), seg(3100, 3200)],
      [
        { ts: 1000, round: 1, phase: "round", paused: false, recordingPaused: false },
        { ts: 2000, round: 1, phase: "round", paused: true, recordingPaused: false },
        { ts: 3000, round: 2, phase: "round", paused: false, recordingPaused: false },
      ],
    );
    expect(out[0]).toMatchObject({ round: null, phase: null, paused: false, phaseChangesInside: 0 });
    expect(out[1]).toMatchObject({ round: 1, paused: false, phaseChangesInside: 1 });
    expect(out[2]).toMatchObject({ round: 2, paused: false, phaseChangesInside: 0 });
  });
});

describe("WAV", () => {
  it("writes a header that parses back, for a known length", () => {
    const samples = sine(16_000, 1000);
    const file = encodeWav(samples, { sampleRate: FS });
    const info = parseWavHeader(file);
    expect(info).toMatchObject({
      sampleRate: FS,
      channels: 1,
      bitsPerSample: 16,
      audioFormat: 1,
      dataOffset: 44,
    });
    expect(info.dataBytes).toBe(32_000);
    expect(info.frames).toBe(16_000);
    expect(info.durationMs).toBe(1000);
    expect(new DataView(file.buffer).getInt16(44 + 2 * 100, true)).toBe(samples[100]);
    expect(wavHeader({ sampleRate: FS }, 0).length).toBe(WAV_HEADER_BYTES);
  });

  it("streams exactly the declared length (padding or truncating)", async () => {
    const collect = async (blocks: Int16Array[], total: number) => {
      const parts: Uint8Array[] = [];
      for await (const p of wavStream(blocks, { sampleRate: FS }, total)) parts.push(p);
      const bytes = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
      let o = 0;
      for (const p of parts) {
        bytes.set(p, o);
        o += p.length;
      }
      return bytes;
    };
    const short = await collect([new Int16Array(100).fill(7)], 50_000);
    expect(short.length).toBe(44 + 100_000);
    expect(parseWavHeader(short).frames).toBe(50_000);
    const long = await collect([new Int16Array(30_000), new Int16Array(30_000)], 40_000);
    expect(long.length).toBe(44 + 80_000);
  });

  it("WavWriter reports the final header", () => {
    const chunks: Uint8Array[] = [];
    const w = new WavWriter((b) => chunks.push(b), { sampleRate: FS });
    w.write(new Int16Array(10));
    w.write(new Int16Array(5));
    const { header, dataBytes } = w.end();
    expect(dataBytes).toBe(30);
    expect(parseWavHeader(header).dataBytes).toBe(30);
    expect(w.length).toBe(15);
    // An unpatched provisional header is clamped to the real size when the file size is known.
    const provisional = parseWavHeader(chunks[0]!, 44 + 30);
    expect(provisional).toMatchObject({ dataBytes: 30, frames: 15, truncated: true });
  });
});

describe("quick calibration check", () => {
  const window = (s: ReturnType<typeof synthesise>) => ({
    fromTs: s.turns[0]!.startTs - 2000,
    toTs: s.turns[3]!.endTs + 1000,
  });

  it("passes headsets, flags laptop mics with advice, and is fast", () => {
    for (const profile of ["headset", "laptop"] as const) {
      const s = synthesise({ seed: 11, durationSec: 36, profile });
      const t = performance.now();
      const report = quickCalibrationCheck(trackInputs(s), s.turns, window(s));
      if (TIMED) expect(performance.now() - t).toBeLessThan(200);
      expect(report.seats).toHaveLength(4);
      if (profile === "headset") {
        expect(report.ok).toBe(true);
        for (const q of report.seats) expect(q.marginDb!).toBeGreaterThan(12);
        // the leakage is measured against the known mix
        for (const [i, row] of report.leakage.matrixDb.entries())
          for (const [j, g] of row.entries()) expect(Math.abs(g! - s.leakageDb[i]![j]!)).toBeLessThan(2);
      } else {
        expect(report.ok).toBe(false);
        const low = report.seats.filter((q) => q.issues.includes("low_margin"));
        expect(low.length).toBeGreaterThan(0);
        expect(low[0]!.advice).toMatch(/headset/);
        expect(report.warnings.length).toBeGreaterThan(0);
      }
    }
  });

  it("reports a seat that stayed silent in its turn", () => {
    const s = synthesise({ seed: 12, durationSec: 36, profile: "headset" });
    const tracks = trackInputs(s).filter((t) => t.seat !== 2);
    const report = quickCalibrationCheck(tracks, s.turns, window(s));
    const q2 = report.seats.find((q) => q.seat === 2)!;
    expect(q2.ok).toBe(false);
    expect(q2.issues).toContain("no_signal");
  });
});
