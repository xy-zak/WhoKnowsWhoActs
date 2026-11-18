import { describe, expect, it } from "vitest";
import {
  annotate,
  buildEnvelope,
  type ChunkMeta,
  EnvelopeBuilder,
  fitClocks,
  maskToRuns,
  quickCalibrationCheck,
  runsToMask,
  type SpeechSegment,
} from "../src/audio/attribution";
import { calibrationChannelsFromTracks } from "../src/audio/attribution/leakage";
import { estimateNoiseFloor } from "../src/audio/attribution/noiseFloor";
import { smoothActivity } from "../src/audio/attribution/smooth";
import {
  encodeWav,
  parseWavHeader,
  WAV_HEADER_BYTES,
  WavWriter,
  wavHeader,
  wavStream,
} from "../src/audio/wav";
import { mulberry32, synthesise, trackInputs } from "./attributionSynth";

const FS = 16_000;

function sine(n: number, amp: number, hz = 400): Int16Array {
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(amp * Math.sin((2 * Math.PI * hz * i) / FS));
  return out;
}

describe("EnvelopeBuilder", () => {
  it("measures a sine at its true level and is independent of block size", () => {
    const pcm = sine(FS, 32767 * 10 ** (-20 / 20)); // peak −20 dBFS ⇒ RMS −23 dBFS
    const whole = buildEnvelope(pcm);
    const b = new EnvelopeBuilder();
    for (let i = 0; i < pcm.length; i += 777) b.push(pcm.subarray(i, i + 777));
    const blocks = b.finish();
    expect(whole.frames).toBe(100);
    for (let k = 2; k < 98; k++) {
      expect(whole.energyDb[k]!).toBeCloseTo(-23.01, 1);
      expect(blocks.energyDb[k]!).toBeCloseTo(whole.energyDb[k]!, 4);
      expect(whole.peakDb[k]!).toBeCloseTo(-20, 1);
    }
  });

  it("marks lost chunks as no data, ignores duplicates and flags clipping", () => {
    const b = new EnvelopeBuilder();
    const a = sine(8000, 1000);
    b.push(a, 0);
    b.push(a.subarray(0, 4000), 4000); // re-sent overlap: ignored
    b.push(sine(8000, 32767), 16_000); // after a gap of 8000 samples, clipping
    const env = b.finish();
    expect(env.frames).toBe(150);
    expect(Number.isNaN(env.energyDb[60]!)).toBe(true); // inside the gap
    expect(Number.isNaN(env.energyDb[40]!)).toBe(false);
    expect(env.clipped[120]).toBe(1);
    expect(env.clipped[20]).toBe(0);
    // No step transient after the gap (the filter restarts in steady state).
    expect(env.energyDb[101]!).toBeLessThan(env.energyDb[120]! + 1);
  });

  it("removes DC offset before measuring energy", () => {
    const pcm = new Int16Array(FS).fill(3000);
    const env = buildEnvelope(pcm);
    expect(env.energyDb[50]!).toBeLessThan(-100);
  });

  it("fills a gap when the missing chunk arrives late, matching in-order delivery", () => {
    const pcm = sine(3 * 8000, 2000);
    const inOrder = buildEnvelope(pcm);
    const b = new EnvelopeBuilder();
    b.push(pcm.subarray(0, 8000), 0);
    b.push(pcm.subarray(16_000), 16_000); // chunk 2 before chunk 1
    b.push(pcm.subarray(8000, 16_000), 8000); // the late chunk
    b.push(pcm.subarray(8000, 16_000), 8000); // and a duplicate of it
    const late = b.finish();
    expect(late.frames).toBe(inOrder.frames);
    for (let k = 2; k < late.frames - 2; k++) {
      expect(Number.isNaN(late.energyDb[k]!)).toBe(false);
      expect(Math.abs(late.energyDb[k]! - inOrder.energyDb[k]!)).toBeLessThan(0.5);
    }
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
      const { fits } = fitClocks([
        { trackId: `t${seed}`, seat: 1, sampleRate: FS, chunks: track(seed, 30, drift, 6) },
      ]);
      const f = fits[0]!;
      expect(Math.abs(f.driftPpm - drift)).toBeLessThan(5);
      expect(f.outliers).toBeGreaterThanOrEqual(6);
      expect(Math.abs(f.startTs - (1_763_000_000_000 + 35))).toBeLessThan(5);
    }
  });

  it("shares one drift across a seat's tracks and isolates a track on a different clock", () => {
    const a = track(5, 20, 60);
    const b = track(6, 3, 60).map((c) => ({ ...c, clientTs: c.clientTs + 1_500_000 }));
    const c = track(7, 20, -80).map((x) => ({ ...x, clientTs: x.clientTs + 2_000_000 }));
    const { fits, warnings } = fitClocks([
      { trackId: "a", seat: 2, sampleRate: FS, chunks: a },
      { trackId: "b", seat: 2, sampleRate: FS, chunks: b },
      { trackId: "c", seat: 2, sampleRate: FS, chunks: c },
    ]);
    const fa = fits.find((f) => f.trackId === "a")!;
    const fb = fits.find((f) => f.trackId === "b")!;
    const fc = fits.find((f) => f.trackId === "c")!;
    expect(fa.group).toBe(fb.group);
    expect(fb.driftPpm).toBe(fa.driftPpm);
    expect(Math.abs(fa.driftPpm - 60)).toBeLessThan(5);
    expect(fc.group).not.toBe(fa.group);
    expect(Math.abs(fc.driftPpm + 80)).toBeLessThan(5);
    expect(warnings.some((w) => w.includes("different clock"))).toBe(true);
  });
});

describe("noise floor", () => {
  it("tracks the quiet frames of a busy channel and follows a step", () => {
    const r = mulberry32(3);
    const e = new Float32Array(12_000);
    for (let f = 0; f < e.length; f++) {
      const base = f < 6000 ? -60 : -45;
      e[f] = r() < 0.7 ? -25 + r() * 10 : base + r();
    }
    e.fill(Number.NaN, 2000, 2500); // a gap does not disturb it
    const fl = estimateNoiseFloor(e, { windowFrames: 3000, percentile: 0.05 });
    expect(fl[1000]!).toBeGreaterThan(-61);
    expect(fl[1000]!).toBeLessThan(-58);
    expect(fl[11_000]!).toBeGreaterThan(-46);
    expect(fl[11_000]!).toBeLessThan(-43);
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
    const m = smoothActivity(raw, valid, null, p);
    expect(maskToRuns(m)).toEqual([8, 130, 298, 345]);
  });

  it("does not bridge a pause that contains no data", () => {
    const raw = new Uint8Array(200);
    raw.fill(1, 10, 60);
    raw.fill(1, 70, 120);
    const valid = new Uint8Array(200).fill(1);
    valid[65] = 0;
    const m = smoothActivity(raw, valid, null, { ...p, hangover: 0, preRoll: 0 });
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
  it("passes headsets, flags laptop mics with advice, and is fast", () => {
    for (const profile of ["headset", "laptop"] as const) {
      const s = synthesise({ seed: 11, durationSec: 36, profile });
      const tracks = trackInputs(s);
      const from = s.turns[0]!.startTs - 2000;
      const to = s.turns[3]!.endTs + 1000;
      const channels = calibrationChannelsFromTracks(tracks, from, to);
      const report = quickCalibrationCheck(channels, s.turns);
      expect(report.seats).toHaveLength(4);
      expect(report.elapsedMs).toBeLessThan(200);
      if (profile === "headset") {
        expect(report.ok).toBe(true);
        for (const q of report.seats) expect(q.marginDb!).toBeGreaterThan(12);
      } else {
        expect(report.ok).toBe(false);
        const low = report.seats.filter((q) => q.issues.includes("low_margin"));
        expect(low.length).toBeGreaterThan(0);
        expect(low[0]!.advice).toMatch(/headset/);
        expect(report.warnings.length).toBeGreaterThan(0);
      }
      // Leakage rows are measured against the known mix.
      report.leakage.matrixDb.forEach((row, i) => {
        row.forEach((g, j) => {
          if (g !== null && !report.leakage.belowFloor[i]![j])
            expect(Math.abs(g - s.leakageDb[i]![j]!)).toBeLessThan(1.5);
        });
      });
    }
  });

  it("reports a seat that stayed silent in its turn", () => {
    const s = synthesise({ seed: 12, durationSec: 36, profile: "headset" });
    const tracks = trackInputs(s).filter((t) => t.seat !== 2);
    const channels = calibrationChannelsFromTracks(tracks, s.turns[0]!.startTs - 2000, s.turns[3]!.endTs);
    const report = quickCalibrationCheck(channels, s.turns);
    const q2 = report.seats.find((q) => q.seat === 2)!;
    expect(q2.ok).toBe(false);
    expect(q2.issues).toContain("no_signal");
  });
});
