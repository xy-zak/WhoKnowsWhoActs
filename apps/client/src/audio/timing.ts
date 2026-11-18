import type { TimingMethod } from "./types";

/**
 * Timing model: when was a captured sample recorded, on the server clock?
 *
 * Three clocks are involved:
 *  1. the AudioContext clock: the capture worklet tags every block with
 *     `currentFrame`, the context frame index of its first sample. A chunk's
 *     first 16 kHz sample s of a track that began at context frame F₀ is
 *     context frame F = F₀ + s · nativeRate / 16 000 (the resampler is zero-phase,
 *     so this is exact).
 *  2. the performance clock (performance.now(), ms). Each time a block arrives
 *     the main thread reads one timing sample and derives the "render origin"
 *     O = the performance time at which context frame 0 was rendered, so that
 *     frame F was rendered at O + F · 1000 / nativeRate. Two methods:
 *       - "output-timestamp": getOutputTimestamp() pairs a context time c with
 *         the performance time p at which that frame reaches the speakers. The
 *         graph renders a frame (baseLatency + outputLatency) before it is
 *         heard, so O = p − c·1000 − (baseLatency + outputLatency)·1000.
 *         Median over the recent samples (jitter is symmetric).
 *       - "current-time" (fallback): O = performance.now() − currentTime·1000.
 *         currentTime only advances when a render quantum finishes, so every
 *         sample over-estimates O by up to one audio callback; the minimum over
 *         the recent samples is used. currentTime is read before
 *         performance.now() to keep the error one-sided.
 *     The method is chosen once per track, from its first sample:
 *     "output-timestamp" when that sample has a valid output timestamp
 *     (Chrome returns zeros for the first callbacks of a new context),
 *     otherwise "current-time". Every clientTs of a track (start, chunks,
 *     stop) therefore comes from the same estimator, as reported in the
 *     start info's timingMethod.
 *     The sample's pair of clock readings is taken together on the main thread,
 *     so the time a message took to arrive does not enter the estimate.
 *  3. the server clock: ClockSync.now() = performance time + epoch offset, so
 *     server-epoch(p) = p + (now() − performance.now()), read when the chunk is
 *     finished. The microphone captured the sample inputLatency before the
 *     graph processed it (track.getSettings().latency when reported, else 0):
 *
 *        clientTs = O + F·1000/nativeRate − inputLatencyMs + (now() − performance.now())
 *
 * Each chunk's clientTs is computed independently from fresh samples and
 * carries the clockOffsetMs in use, so the server can estimate the drift of
 * the audio clock against the server clock (a regression of clientTs on
 * startSample) and redo the offset correction. Nothing is changed afterwards
 * when ClockSync re-syncs.
 *
 * Discontinuities: if a new sample's current-time origin differs from the
 * estimate by more than `jumpMs` (the audio clock stalled or skipped, e.g.
 * after the computer slept), observe() reports a jump and the recorder starts
 * a new track, because the track's sample timeline no longer matches real time.
 */
export interface TimingSample {
  /** performance.now() when sampled (ms), read after currentTime */
  perfNow: number;
  /** AudioContext.currentTime (s) */
  currentTime: number;
  /** getOutputTimestamp().contextTime (s) */
  contextTime?: number | undefined;
  /** getOutputTimestamp().performanceTime (ms) */
  performanceTime?: number | undefined;
  /** AudioContext.baseLatency (s) */
  baseLatency?: number | undefined;
  /** AudioContext.outputLatency (s) */
  outputLatency?: number | undefined;
}

const finite = (x: number | undefined): x is number => typeof x === "number" && Number.isFinite(x);

/** Render origin (ms) implied by one sample, or null when the sample has no data for the method. */
export function renderOrigin(s: TimingSample, method: TimingMethod): number | null {
  if (method === "output-timestamp") {
    const c = s.contextTime;
    const p = s.performanceTime;
    if (!finite(c) || !finite(p) || c <= 0 || p <= 0) return null;
    const latency =
      (finite(s.baseLatency) ? s.baseLatency : 0) + (finite(s.outputLatency) ? s.outputLatency : 0);
    return p - c * 1000 - latency * 1000;
  }
  if (!finite(s.perfNow) || !finite(s.currentTime)) return null;
  return s.perfNow - s.currentTime * 1000;
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export interface ClockMapperOptions {
  /** samples kept per method; default 64 (~2.5 s of 40 ms blocks) */
  window?: number;
  /** a current-time origin this far from the estimate is a discontinuity; default 250 ms */
  jumpMs?: number;
}

/** Maps context frames to performance time for one track. */
export class ClockMapper {
  private readonly ot: number[] = [];
  private readonly ct: number[] = [];
  private locked: TimingMethod | null = null;
  private readonly window: number;
  private readonly jumpMs: number;

  constructor(
    readonly sampleRate: number,
    o: ClockMapperOptions = {},
  ) {
    this.window = Math.max(1, o.window ?? 64);
    this.jumpMs = o.jumpMs ?? 250;
  }

  /** True once at least one usable sample was observed. */
  get ready(): boolean {
    return this.ct.length > 0 || this.ot.length > 0;
  }

  /** The track's method, fixed by its first sample. */
  get method(): TimingMethod {
    return this.locked ?? "current-time";
  }

  /**
   * Adds a sample. Returns false, without adding it, when it contradicts the
   * current estimate by more than jumpMs (a discontinuity); true otherwise.
   */
  observe(s: TimingSample): boolean {
    const ct = renderOrigin(s, "current-time");
    if (ct !== null && this.ct.length > 0) {
      const ref = Math.min(...this.ct);
      if (Math.abs(ct - ref) > this.jumpMs) return false;
    }
    const ot = renderOrigin(s, "output-timestamp");
    this.locked ??= ot !== null ? "output-timestamp" : "current-time";
    if (ct !== null) push(this.ct, ct, this.window);
    if (ot !== null) push(this.ot, ot, this.window);
    return true;
  }

  /** Render origin O (ms): performance time at which context frame 0 was rendered. */
  origin(): number {
    if (this.locked === "output-timestamp" && this.ot.length > 0) return median(this.ot);
    if (this.ct.length > 0) return Math.min(...this.ct);
    throw new Error("ClockMapper: no timing sample observed");
  }

  /** Performance time (ms) at which context frame `frame` was rendered. */
  renderPerfMs(frame: number): number {
    return this.origin() + (frame * 1000) / this.sampleRate;
  }

  /** Server-epoch ms at which context frame `frame` was captured by the microphone. */
  captureEpochMs(frame: number, inputLatencyMs: number, epochMinusPerfMs: number): number {
    return this.renderPerfMs(frame) - inputLatencyMs + epochMinusPerfMs;
  }
}

function push(xs: number[], x: number, max: number) {
  xs.push(x);
  if (xs.length > max) xs.shift();
}

/** Rounds a timestamp to 1 µs. */
export function roundTs(ms: number): number {
  return Math.round(ms * 1000) / 1000;
}
