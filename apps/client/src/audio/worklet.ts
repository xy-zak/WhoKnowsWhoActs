/**
 * The capture AudioWorklet, as an inline module source.
 *
 * Loaded from a Blob URL (fallback: a data: URL), so it works the same in
 * `vite dev` and in the production build: there is no separate asset to
 * resolve, transpile or serve.
 *
 * The processor does as little as possible on the real-time audio thread:
 * it copies the mono input (the node down-mixes to one channel) into batches
 * of `batchFrames` frames and posts each batch to the main thread with the
 * context frame index of its first sample (`currentFrame`). A render quantum
 * without input channels (nothing connected) is recorded as silence, so the
 * frame timeline stays contiguous. Its output stays silent: it is connected
 * to the destination only so every browser keeps pulling it.
 *
 * Messages to the processor: {type:"flush"} posts the partial batch now;
 * {type:"close"} flushes the partial batch,
 * replies {type:"closed"} and ends the processor (process() returns false).
 * Messages from it: {type:"pcm", frame, samples: Float32Array} and {type:"closed"}.
 */
export const CAPTURE_PROCESSOR = "wkwa-pcm-capture";

export const CAPTURE_WORKLET_SOURCE = `
class WkwaPcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.size = Math.max(128, Math.floor(o.batchFrames || 2048));
    this.buf = new Float32Array(this.size);
    this.fill = 0;
    this.first = 0;
    this.alive = true;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m && m.type === "flush" && this.alive) this.flush();
      if (m && m.type === "close" && this.alive) {
        this.flush();
        this.alive = false;
        this.port.postMessage({ type: "closed" });
      }
    };
  }
  flush() {
    if (this.fill === 0) return;
    const samples = this.buf.slice(0, this.fill);
    this.port.postMessage({ type: "pcm", frame: this.first, samples }, [samples.buffer]);
    this.fill = 0;
  }
  process(inputs) {
    if (!this.alive) return false;
    const input = inputs[0];
    const channel = input && input.length > 0 ? input[0] : null;
    const frames = channel ? channel.length : 128;
    // a batch only holds contiguous frames, so a gap shows up as a new batch's frame
    if (this.fill > 0 && (this.fill + frames > this.size || currentFrame !== this.first + this.fill)) this.flush();
    if (frames > this.size) {
      this.size = frames;
      this.buf = new Float32Array(frames);
    }
    if (this.fill === 0) this.first = currentFrame;
    if (channel) this.buf.set(channel, this.fill);
    else this.buf.fill(0, this.fill, this.fill + frames);
    this.fill += frames;
    if (this.fill >= this.size) this.flush();
    return true;
  }
}
registerProcessor(${JSON.stringify(CAPTURE_PROCESSOR)}, WkwaPcmCapture);
`;

let blobUrl: string | null = null;
const loaded = new WeakMap<BaseAudioContext, Promise<void>>();

async function addModule(ctx: BaseAudioContext) {
  try {
    blobUrl ??= URL.createObjectURL(new Blob([CAPTURE_WORKLET_SOURCE], { type: "text/javascript" }));
    await ctx.audioWorklet.addModule(blobUrl);
  } catch (first) {
    // a Content-Security-Policy may refuse blob: modules but allow data:
    try {
      await ctx.audioWorklet.addModule(
        `data:text/javascript;charset=utf-8,${encodeURIComponent(CAPTURE_WORKLET_SOURCE)}`,
      );
    } catch {
      throw first;
    }
  }
}

/** Adds the capture processor to a context (once per context). */
export function loadCaptureWorklet(ctx: BaseAudioContext): Promise<void> {
  let p = loaded.get(ctx);
  if (!p) {
    p = addModule(ctx).catch((err) => {
      loaded.delete(ctx);
      throw err;
    });
    loaded.set(ctx, p);
  }
  return p;
}

/** Batch size: ~40 ms, a whole number of 128-frame render quanta. */
export function batchFramesFor(sampleRate: number): number {
  return 128 * Math.max(1, Math.ceil((sampleRate * 0.04) / 128));
}
