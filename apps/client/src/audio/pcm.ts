/**
 * Float ↔ signed 16-bit PCM.
 *
 * Scaling is symmetric (x · 32768, rounded) and clamped to [−32768, 32767].
 * A sample counts as clipped when it is at or beyond 16-bit full scale
 * (|x| ≳ 1.0): it hit a rail, so the waveform there is not the real signal.
 */

export const INT16_FULL_SCALE = 32768;

/** Converts one float sample; NaN becomes 0. */
export function toInt16(x: number): number {
  const s = Math.round(x * INT16_FULL_SCALE);
  if (s > 32767) return 32767;
  if (s < -32768) return -32768;
  return Number.isNaN(s) ? 0 : s;
}

/** True when the float sample is at or beyond 16-bit full scale. */
function isClipped(x: number): boolean {
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
