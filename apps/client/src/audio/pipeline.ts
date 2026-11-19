import { AUDIO_SAMPLE_RATE } from "@wkwa/shared";
import { type ChunkDraft, Chunker } from "./chunker";
import { Resampler, type ResamplerOptions } from "./resampler";

export interface TrackPipelineOptions {
  /** native rate of the captured blocks */
  inputRate: number;
  /** samples per full chunk at 16 kHz */
  chunkSamples: number;
  onChunk(draft: ChunkDraft): void;
  /** every 16 kHz block, before chunking (levels, speech detector) */
  onOutput?(samples: Float32Array): void;
  resampler?: Omit<ResamplerOptions, "inputRate" | "outputRate">;
}

/**
 * One track's signal path, independent of Web Audio: native-rate float
 * blocks → 16 kHz (anti-aliased) → Int16 chunks. finish() flushes the
 * resampler's lookahead and the partial last chunk.
 */
export class TrackPipeline {
  readonly resampler: Resampler;
  readonly chunker: Chunker;
  private finished = false;

  constructor(private readonly o: TrackPipelineOptions) {
    this.resampler = new Resampler({
      ...o.resampler,
      inputRate: o.inputRate,
      outputRate: AUDIO_SAMPLE_RATE,
    });
    this.chunker = new Chunker(o.chunkSamples);
  }

  get inputFrames(): number {
    return this.resampler.inputSamples;
  }
  /** 16 kHz samples produced (complete chunks + the partial one) */
  get outputSamples(): number {
    return this.chunker.totalSamples;
  }
  get chunks(): number {
    return this.chunker.chunks;
  }

  push(input: Float32Array) {
    if (this.finished) return;
    this.emit(this.resampler.process(input));
  }

  finish() {
    if (this.finished) return;
    this.finished = true;
    this.emit(this.resampler.flush());
    const last = this.chunker.flush();
    if (last) this.o.onChunk(last);
  }

  private emit(out: Float32Array) {
    if (out.length === 0) return;
    this.o.onOutput?.(out);
    for (const d of this.chunker.push(out)) this.o.onChunk(d);
  }
}
