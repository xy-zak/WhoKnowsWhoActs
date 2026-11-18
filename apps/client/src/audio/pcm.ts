/**
 * Float ↔ signed 16-bit PCM.
 *
 * Scaling is symmetric (x · 32768, rounded) and clamped to [−32768, 32767].
 * A sample counts as clipped when it is at or beyond 16-bit full scale
 * (|x| ≳ 1.0): it hit a rail, so the waveform there is not the real signal.
 */

export const INT16_FULL_SCALE = 32768;

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** Converts one float sample; NaN becomes 0. */
export function toInt16(x: number): number {
  const s = Math.round(x * INT16_FULL_SCALE);
  if (s > 32767) return 32767;
  if (s < -32768) return -32768;
  return Number.isNaN(s) ? 0 : s;
}

/** True when the float sample is at or beyond 16-bit full scale. */
export function isClipped(x: number): boolean {
  return isClippedInt16(toInt16(x));
}

/** True when a converted sample sits on a 16-bit rail. */
export function isClippedInt16(v: number): boolean {
  return v === 32767 || v === -32768;
}

/** Converts float samples (−1 … 1) to Int16 and counts clipped samples. */
export function floatToInt16(input: ArrayLike<number>): { samples: Int16Array; clipped: number } {
  const samples = new Int16Array(input.length);
  let clipped = 0;
  for (let i = 0; i < input.length; i++) {
    const x = input[i]!;
    if (isClipped(x)) clipped++;
    samples[i] = toInt16(x);
  }
  return { samples, clipped };
}

/** Copies Int16 samples into a new little-endian byte array (exactly samples.length × 2 bytes). */
export function int16ToLittleEndian(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  if (LITTLE_ENDIAN) {
    out.set(new Uint8Array(samples.buffer, samples.byteOffset, samples.length * 2));
  } else {
    const view = new DataView(out.buffer);
    for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i]!, true);
  }
  return out;
}

/** Reads little-endian s16 bytes back into samples (for tests and tools). */
export function int16FromLittleEndian(bytes: Uint8Array): Int16Array {
  const n = Math.floor(bytes.length / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}
