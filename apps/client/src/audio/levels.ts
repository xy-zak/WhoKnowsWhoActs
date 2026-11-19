import { AUDIO_LEVEL_INTERVAL_MS } from "@wkwa/shared";
import type { MicLevel } from "./types";

/**
 * Levels in dBFS: 20·log10(amplitude / full scale). A full-scale square wave
 * is 0 dB RMS and a full-scale sine about −3 dB RMS. Digital silence is
 * floored at MIN_DB so every value stays a finite JSON number.
 */
export const MIN_DB = -100;

export function toDb(linear: number): number {
  if (!(linear > 0)) return MIN_DB;
  return Math.max(MIN_DB, 20 * Math.log10(linear));
}

/** Rounds to 0.1 dB for display and messages. */
export function roundDb(db: number): number {
  return Math.round(db * 10) / 10;
}

export function rmsDb(samples: ArrayLike<number>, fullScale = 1): number {
  if (samples.length === 0) return MIN_DB;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i]!;
    sum += v * v;
  }
  return toDb(Math.sqrt(sum / samples.length) / fullScale);
}

export function peakDb(samples: ArrayLike<number>, fullScale = 1): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]!);
    if (v > peak) peak = v;
  }
  return toDb(peak / fullScale);
}

export interface LevelMeterOptions {
  sampleRate: number;
  /** window length; default AUDIO_LEVEL_INTERVAL_MS (≈ 4 updates per second) */
  intervalMs?: number;
  /** called once per window with the window's level (rounded to 0.1 dB) and its duration */
  onLevel(level: MicLevel, windowMs: number): void;
}

/** Accumulates samples and reports the RMS and peak level of every window. */
export class LevelMeter {
  private readonly window: number;
  private readonly windowMs: number;
  private count = 0;
  private sum = 0;
  private peak = 0;

  constructor(private readonly o: LevelMeterOptions) {
    this.window = Math.max(1, Math.round((o.sampleRate * (o.intervalMs ?? AUDIO_LEVEL_INTERVAL_MS)) / 1000));
    this.windowMs = (this.window / o.sampleRate) * 1000;
  }

  push(samples: ArrayLike<number>) {
    for (let i = 0; i < samples.length; i++) {
      const v = samples[i]!;
      this.sum += v * v;
      const a = Math.abs(v);
      if (a > this.peak) this.peak = a;
      if (++this.count === this.window) {
        const level = {
          rmsDb: roundDb(toDb(Math.sqrt(this.sum / this.count))),
          peakDb: roundDb(toDb(this.peak)),
        };
        this.reset();
        this.o.onLevel(level, this.windowMs);
      }
    }
  }

  reset() {
    this.count = 0;
    this.sum = 0;
    this.peak = 0;
  }
}
