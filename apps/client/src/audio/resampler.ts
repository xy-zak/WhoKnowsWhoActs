/**
 * Streaming sample-rate converter (native microphone rate → 16 kHz).
 *
 * Method: band-limited interpolation with a Kaiser-windowed sinc kernel,
 * evaluated polyphase.
 *  - The ratio is reduced to integers: L = outputRate / g, M = inputRate / g
 *    (g = gcd), e.g. 48 000 → 16 000 is L = 1, M = 3 and 44 100 → 16 000 is
 *    L = 160, M = 441. Output sample k is the band-limited value of the input
 *    at position k·M/L input samples, i.e. at time k / outputRate since the
 *    first input sample. The position is kept as an integer pair
 *    (base, phase) = (⌊kM/L⌋, kM mod L), so the sample count never drifts:
 *    N input samples always give exactly ⌈N·L/M⌉ output samples.
 *  - The kernel is a zero-phase low-pass (cut-off 7.5 kHz for a 16 kHz output,
 *    ~2.5 ms half-width, Kaiser window for ~80 dB stop-band from ~8 kHz), so it
 *    is also the anti-aliasing filter. Output sample k is aligned with input
 *    time k·M/L exactly (no group delay); the price is a lookahead of
 *    `halfTaps` input samples, which flush() pads with zeros at the end.
 *  - One tap table per phase, normalised to unity DC gain. Up to 1024 phases
 *    are exact; for unusual rates with more phases the phase is rounded to
 *    1/1024 input sample (the sample count stays exact).
 *  - State (input history, phase) carries across calls: the output does not
 *    depend on how the input is split into blocks.
 */

const MAX_PHASES = 1024;
const EMPTY = new Float32Array(0);

function gcd(a: number, b: number): number {
  let x = a;
  let y = b;
  while (y) [x, y] = [y, x % y];
  return x;
}

/** Modified Bessel function of the first kind, order 0 (power series). */
export function besselI0(x: number): number {
  const q = (x * x) / 4;
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 500; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}

/** Kaiser window β for a stop-band attenuation in dB (Kaiser's formula). */
export function kaiserBeta(attenuationDb: number): number {
  if (attenuationDb > 50) return 0.1102 * (attenuationDb - 8.7);
  if (attenuationDb >= 21) return 0.5842 * (attenuationDb - 21) ** 0.4 + 0.07886 * (attenuationDb - 21);
  return 0;
}

export interface ResamplerOptions {
  inputRate: number;
  /** default 16 000 */
  outputRate?: number;
  /** −6 dB point of the low-pass; default 0.46875 × min(input, output) rate (7.5 kHz for 16 kHz) */
  cutoffHz?: number;
  /** kernel half-width; default 2.5 ms (~1 kHz transition band) */
  halfWidthMs?: number;
  /** Kaiser stop-band attenuation; default 80 dB */
  attenuationDb?: number;
}

/** Exact number of output samples for `inputLength` input samples (after flush()). */
export function resampledLength(inputLength: number, inputRate: number, outputRate = 16000): number {
  const g = gcd(inputRate, outputRate);
  const up = outputRate / g;
  const down = inputRate / g;
  return Math.floor((inputLength * up + down - 1) / down);
}

export class Resampler {
  readonly inputRate: number;
  readonly outputRate: number;
  /** L: output sample k sits at input position k·down/up */
  readonly up: number;
  /** M */
  readonly down: number;
  /** taps on each side of the interpolation point (input samples) */
  readonly halfTaps: number;
  readonly cutoffHz: number;
  private readonly taps: number;
  private readonly buckets: number;
  private readonly tables: Array<Float64Array | undefined>;
  private readonly fcNorm: number;
  private readonly beta: number;
  private readonly i0Beta: number;
  /** input history: buf[0] holds absolute input index bufStart; indices < 0 are zeros */
  private buf: Float32Array;
  private bufStart: number;
  private bufLen: number;
  private inCount = 0;
  private outCount = 0;
  private base = 0;
  private phase = 0;
  private finished = false;

  constructor(o: ResamplerOptions) {
    const outputRate = o.outputRate ?? 16000;
    for (const [k, v] of [
      ["inputRate", o.inputRate],
      ["outputRate", outputRate],
    ] as const) {
      if (!Number.isInteger(v) || v <= 0) throw new RangeError(`Resampler: ${k} must be a positive integer`);
    }
    this.inputRate = o.inputRate;
    this.outputRate = outputRate;
    const g = gcd(o.inputRate, outputRate);
    this.up = outputRate / g;
    this.down = o.inputRate / g;
    this.cutoffHz = o.cutoffHz ?? 0.46875 * Math.min(o.inputRate, outputRate);
    this.halfTaps = Math.max(2, Math.ceil(((o.halfWidthMs ?? 2.5) * o.inputRate) / 1000));
    this.taps = 2 * this.halfTaps;
    this.buckets = Math.min(this.up, MAX_PHASES);
    this.tables = new Array(this.buckets + 1);
    this.fcNorm = this.cutoffHz / o.inputRate;
    this.beta = kaiserBeta(o.attenuationDb ?? 80);
    this.i0Beta = besselI0(this.beta);
    // pre-roll: the H − 1 samples before the start are zeros
    this.buf = new Float32Array(Math.max(4096, this.taps * 4));
    this.bufStart = -(this.halfTaps - 1);
    this.bufLen = this.halfTaps - 1;
  }

  /** Input samples received so far. */
  get inputSamples(): number {
    return this.inCount;
  }

  /** Output samples produced so far. */
  get outputSamples(): number {
    return this.outCount;
  }

  /** Feeds input; returns every output sample that can be computed now. */
  process(input: Float32Array): Float32Array {
    if (this.finished) throw new Error("Resampler: process() after flush()");
    this.append(input);
    this.inCount += input.length;
    // output k needs input up to base + H, so base + H < inCount
    return this.run(this.inCount - this.halfTaps);
  }

  /** Ends the stream: produces the remaining outputs (positions < input length), padding the lookahead with zeros. */
  flush(): Float32Array {
    if (this.finished) return EMPTY;
    this.finished = true;
    this.append(new Float32Array(this.halfTaps));
    return this.run(this.inCount);
  }

  /** Produces outputs while base < limit, i.e. k < limit·L/M. */
  private run(limit: number): Float32Array {
    if (limit <= 0) return EMPTY;
    const total = Math.floor((limit * this.up + this.down - 1) / this.down);
    const n = total - this.outCount;
    if (n <= 0) return EMPTY;
    const out = new Float32Array(n);
    const { buf, taps, up, down } = this;
    const offset = 1 - this.halfTaps - this.bufStart;
    let base = this.base;
    let phase = this.phase;
    for (let i = 0; i < n; i++) {
      const table = this.table(phase);
      const start = base + offset;
      let acc = 0;
      for (let j = 0; j < taps; j++) acc += table[j]! * buf[start + j]!;
      out[i] = acc;
      phase += down;
      if (phase >= up) {
        base += Math.floor(phase / up);
        phase %= up;
      }
    }
    this.base = base;
    this.phase = phase;
    this.outCount = total;
    this.compact();
    return out;
  }

  /** Drops input that no future output needs (indices < base − H + 1). */
  private compact() {
    const keepFrom = this.base - this.halfTaps + 1;
    const drop = keepFrom - this.bufStart;
    if (drop <= 0) return;
    const n = Math.max(0, this.bufLen - drop);
    if (n > 0) this.buf.copyWithin(0, drop, drop + n);
    this.bufLen = n;
    this.bufStart = keepFrom;
  }

  private append(input: Float32Array) {
    const need = this.bufLen + input.length;
    if (need > this.buf.length) {
      const next = new Float32Array(Math.max(need, this.buf.length * 2));
      next.set(this.buf.subarray(0, this.bufLen));
      this.buf = next;
    }
    this.buf.set(input, this.bufLen);
    this.bufLen = need;
  }

  private table(phase: number): Float64Array {
    const q = this.up <= MAX_PHASES ? phase : Math.round((phase * MAX_PHASES) / this.up);
    let t = this.tables[q];
    if (!t) {
      t = this.design(q / this.buckets);
      this.tables[q] = t;
    }
    return t;
  }

  /** Taps for an interpolation point `frac` ∈ [0, 1] input samples after the base index. */
  private design(frac: number): Float64Array {
    const H = this.halfTaps;
    const t = new Float64Array(this.taps);
    const w2 = 2 * this.fcNorm;
    let sum = 0;
    for (let j = 0; j < this.taps; j++) {
      // input index (base − H + 1 + j) minus the interpolation point
      const tau = j - H + 1 - frac;
      const x = tau / H;
      const r = 1 - x * x;
      const win = r > 0 ? besselI0(this.beta * Math.sqrt(r)) / this.i0Beta : r === 0 ? 1 / this.i0Beta : 0;
      const sinc = tau === 0 ? w2 : Math.sin(Math.PI * w2 * tau) / (Math.PI * tau);
      const v = sinc * win;
      t[j] = v;
      sum += v;
    }
    for (let j = 0; j < this.taps; j++) t[j] = t[j]! / sum;
    return t;
  }
}
