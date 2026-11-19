import { int16ToLeBytes } from "@wkwa/shared";
import { roundDb, toDb } from "./levels";
import { INT16_FULL_SCALE, isClippedInt16, toInt16 } from "./pcm";

/** A finished chunk before the recorder adds trackId and timing. */
export interface ChunkDraft {
  seq: number;
  /** index of the first sample in the track's timeline; always the previous startSample + sampleCount */
  startSample: number;
  sampleCount: number;
  rmsDb: number;
  peakDb: number;
  clippedSamples: number;
  /** s16le PCM, exactly sampleCount × 2 bytes (its own buffer) */
  pcm: Uint8Array;
}

/**
 * Cuts the 16 kHz float stream of one track into fixed-size Int16 chunks.
 * Converts and measures each sample once (RMS, peak, clipping are computed
 * from the stored Int16 values). flush() emits the partial last chunk.
 */
export class Chunker {
  private readonly buf: Int16Array;
  private fill = 0;
  private seq = 0;
  private start = 0;
  private sumSq = 0;
  private peak = 0;
  private clipped = 0;

  constructor(readonly chunkSamples: number) {
    if (!Number.isInteger(chunkSamples) || chunkSamples <= 0) {
      throw new RangeError("Chunker: chunkSamples must be a positive integer");
    }
    this.buf = new Int16Array(chunkSamples);
  }

  /** Samples taken in so far (complete chunks + the partial one). */
  get totalSamples(): number {
    return this.start + this.fill;
  }

  /** Chunks emitted so far. */
  get chunks(): number {
    return this.seq;
  }

  /** Adds samples; returns the chunks completed by them (oldest first). */
  push(samples: ArrayLike<number>): ChunkDraft[] {
    const out: ChunkDraft[] = [];
    const { buf, chunkSamples } = this;
    for (let i = 0; i < samples.length; i++) {
      const v = toInt16(samples[i]!);
      if (isClippedInt16(v)) this.clipped++;
      buf[this.fill++] = v;
      this.sumSq += v * v;
      const a = v < 0 ? -v : v;
      if (a > this.peak) this.peak = a;
      if (this.fill === chunkSamples) out.push(this.emit());
    }
    return out;
  }

  /** Emits the partial chunk, if any (call once at the end of the track). */
  flush(): ChunkDraft | null {
    return this.fill > 0 ? this.emit() : null;
  }

  private emit(): ChunkDraft {
    const n = this.fill;
    const draft: ChunkDraft = {
      seq: this.seq,
      startSample: this.start,
      sampleCount: n,
      rmsDb: roundDb(toDb(Math.sqrt(this.sumSq / n) / INT16_FULL_SCALE)),
      peakDb: roundDb(toDb(this.peak / INT16_FULL_SCALE)),
      clippedSamples: this.clipped,
      // a copy: the buffer is reused for the next chunk
      pcm: int16ToLeBytes(this.buf.subarray(0, n)).slice(),
    };
    this.seq++;
    this.start += n;
    this.fill = 0;
    this.sumSq = 0;
    this.peak = 0;
    this.clipped = 0;
    return draft;
  }
}
