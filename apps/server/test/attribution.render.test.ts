import { describe, expect, it } from "vitest";
import {
  analyse,
  renderAligned,
  renderClean,
  renderedSampleCount,
  runsToMask,
} from "../src/audio/attribution";
import type { TrackSource } from "../src/audio/attribution/render";
import { parseWavHeader, wavStream } from "../src/audio/wav";
import { deliveredChunks, synthesise, trackInputs } from "./attributionSynth";

async function collect(gen: AsyncIterable<Int16Array>): Promise<Int16Array> {
  const parts: Int16Array[] = [];
  for await (const p of gen) parts.push(p);
  const out = new Int16Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe("renderers", () => {
  const s = synthesise({
    seed: 21,
    durationSec: 75,
    profile: "headset",
    gaps: [{ seat: 1, fromSec: 50, toSec: 55 }],
  });
  const r = analyse({ tracks: trackInputs(s), seats: [1, 2, 3, 4], calibration: { turns: s.turns } });
  // Chunks are served lazily (async), the way the encrypted store will deliver them.
  const sources = (): TrackSource[] =>
    s.tracks.map((t) => ({
      trackId: t.trackId,
      samples: t.pcm.length,
      chunks: (async function* () {
        for (const c of deliveredChunks(t)) yield c;
      })(),
    }));

  it("renders aligned audio on the common timeline, silent in gaps", async () => {
    const aligned = await collect(renderAligned(1, sources(), r, { blockSamples: 7000 }));
    expect(aligned.length).toBe(renderedSampleCount(r.timeline));
    expect(aligned.length).toBe(r.timeline.frames * 160);
    const at = (ms: number) => Math.round(((ms - r.timeline.t0) * 16_000) / 1000);
    // Inside seat 1's 5 s dropout: digital silence.
    const gap = aligned.subarray(at(s.t0 + 51_000), at(s.t0 + 54_000));
    expect(gap.every((v) => v === 0)).toBe(true);
    // Outside it: the mic's noise floor at least.
    const live = aligned.subarray(at(s.t0 + 40_000), at(s.t0 + 41_000));
    expect(live.some((v) => v !== 0)).toBe(true);
  }, 60_000);

  it("attenuates frames outside the mask by ≈ 30 dB and keeps the mask untouched", async () => {
    const seat = 2;
    const mask = r.masks.find((m) => m.seat === seat)!;
    const aligned = await collect(renderAligned(seat, sources(), r));
    const clean = await collect(renderClean(seat, sources(), r, mask, { attenuationDb: -30, fadeMs: 10 }));
    expect(clean.length).toBe(aligned.length);
    const frameMask = runsToMask(mask.runs, r.timeline.frames);
    let inEqual = true;
    let outA = 0;
    let outC = 0;
    for (let f = 2; f < r.timeline.frames - 2; f++) {
      // Skip frames within 20 ms of a mask edge (fades).
      if (frameMask[f - 2] !== frameMask[f] || frameMask[f + 2] !== frameMask[f]) continue;
      for (let k = f * 160; k < (f + 1) * 160; k++) {
        if (frameMask[f]) {
          if (clean[k] !== aligned[k]) inEqual = false;
        } else {
          outA += aligned[k]! * aligned[k]!;
          outC += clean[k]! * clean[k]!;
        }
      }
    }
    expect(inEqual).toBe(true);
    const ratioDb = 10 * Math.log10(outC / outA);
    expect(ratioDb).toBeGreaterThan(-31);
    expect(ratioDb).toBeLessThan(-29);
  }, 60_000);

  it("streams a valid WAV of the announced length", async () => {
    const total = renderedSampleCount(r.timeline);
    const mask = r.masks.find((m) => m.seat === 3)!;
    let bytes = 0;
    let head: Uint8Array | null = null;
    for await (const chunk of wavStream(renderClean(3, sources(), r, mask), { sampleRate: 16_000 }, total)) {
      head ??= chunk.slice();
      bytes += chunk.length;
    }
    const info = parseWavHeader(head!);
    expect(info.frames).toBe(total);
    expect(bytes).toBe(44 + total * 2);
  }, 60_000);

  it("closes every chunk stream, also when the consumer stops early", async () => {
    let open = 0;
    const tracked = (): TrackSource[] =>
      s.tracks
        .filter((t) => t.seat === 1)
        .map((t) => ({
          trackId: t.trackId,
          samples: t.pcm.length,
          chunks: (async function* () {
            open++;
            try {
              for (const c of deliveredChunks(t)) yield c;
            } finally {
              open--;
            }
          })(),
        }));
    // Full render: each track's stream is released once it is done.
    for await (const _ of renderAligned(1, tracked(), r)) void _;
    expect(open).toBe(0);
    // Early stop in the middle of the first track.
    let blocks = 0;
    for await (const _ of renderAligned(1, tracked(), r)) {
      void _;
      if (++blocks === 5) break;
    }
    expect(open).toBe(0);
  }, 60_000);

  it("plays the earlier track where two tracks of a seat overlap (as the analysis does)", async () => {
    const t0 = r.timeline.t0;
    const timeline = { t0, hopMs: 10, frames: 300 };
    const mk = (trackId: string, startMs: number, value: number, n: number) => ({
      alignment: {
        trackId,
        seat: 9,
        startTs: t0 + startMs,
        msPerSample: 1000 / 16_000,
        driftPpm: 0,
        samples: n,
        endTs: t0 + startMs + n / 16,
        residualMs: 0,
      },
      source: { trackId, samples: n, chunks: [{ startSample: 0, samples: new Int16Array(n).fill(value) }] },
    });
    const a = mk("a", 0, 1000, 32_000); // 0–2 s
    const b = mk("b", 1500, -1000, 16_000); // 1.5–2.5 s
    const out = await collect(
      renderAligned(9, [a.source, b.source], { timeline, alignment: [a.alignment, b.alignment] }),
    );
    expect(out[16_000 * 1.75]).toBe(1000); // overlap: track a
    expect(out[16_000 * 2.25]).toBe(-1000); // after a ends: track b
    expect(out[16_000 * 2.75]).toBe(0); // after both: silence
  });
});
