import { MIN_DB, roundDb, toDb } from "./levels";

/**
 * Simple energy-based speech detector for the onboarding mic check.
 *
 *  - The 16 kHz signal is cut into 20 ms frames; each frame's RMS level in dBFS.
 *  - Noise floor: the minimum frame level over the last 3 s ("minimum
 *    statistics"). Pauses between words pull it down to the room noise, and a
 *    permanent change of the noise is followed within the window. Frames of
 *    digital silence (exact zeros, e.g. the first blocks of a new stream) are
 *    ignored, so they cannot pin the floor at −100 dB.
 *  - A frame is speech when it is at least `marginDb` above the floor and
 *    above `minSpeechDb`. Gaps up to `hangoverMs` between speech frames
 *    (troughs between syllables) are counted as speech, but only when speech
 *    resumes, so the hangover never lengthens the end of a burst.
 *  - It passes once the speech adds up to `minSpeechMs`.
 *
 * This only checks that the microphone hears the participant; it says
 * nothing about who is speaking (no speaker identification).
 */
export interface SpeechDetectorOptions {
  /** default 16 000 */
  sampleRate?: number;
  /** default 20 ms */
  frameMs?: number;
  /** speech needed to pass; default 1000 ms */
  minSpeechMs?: number;
  /** speech must be this far above the noise floor; default 12 dB */
  marginDb?: number;
  /** and above this absolute level; default −60 dBFS */
  minSpeechDb?: number;
  /** gaps up to this long inside speech still count; default 200 ms */
  hangoverMs?: number;
  /** noise-floor window; default 3000 ms */
  floorWindowMs?: number;
}

export interface SpeechCheckResult {
  /** speech detected so far (ms) */
  speechMs: number;
  /** current noise floor (dBFS) */
  noiseFloorDb: number;
  /** mean level of the speech frames (dBFS, power mean); MIN_DB when none */
  speechDb: number;
  /** speechMs ≥ minSpeechMs */
  passed: boolean;
  /** audio analysed so far (ms) */
  analysedMs: number;
}

const SILENCE_DB = MIN_DB + 1;

export class SpeechDetector {
  readonly minSpeechMs: number;
  private readonly frameLen: number;
  private readonly frameMs: number;
  private readonly marginDb: number;
  private readonly minSpeechDb: number;
  private readonly hangoverMs: number;
  private readonly floorRing: Float64Array;
  private ringFill = 0;
  private ringPos = 0;
  private frameSum = 0;
  private frameCount = 0;
  private floor: number | null = null;
  private inSpeech = false;
  private gapMs = 0;
  private speech = 0;
  private analysed = 0;
  private speechPower = 0;
  private speechFrames = 0;

  constructor(o: SpeechDetectorOptions = {}) {
    const rate = o.sampleRate ?? 16000;
    this.frameMs = o.frameMs ?? 20;
    this.frameLen = Math.max(1, Math.round((rate * this.frameMs) / 1000));
    this.minSpeechMs = o.minSpeechMs ?? 1000;
    this.marginDb = o.marginDb ?? 12;
    this.minSpeechDb = o.minSpeechDb ?? -60;
    this.hangoverMs = o.hangoverMs ?? 200;
    this.floorRing = new Float64Array(Math.max(1, Math.round((o.floorWindowMs ?? 3000) / this.frameMs)));
  }

  /** Analyses 16 kHz samples; returns the result so far. */
  push(samples: ArrayLike<number>): SpeechCheckResult {
    for (let i = 0; i < samples.length; i++) {
      const v = samples[i]!;
      this.frameSum += v * v;
      if (++this.frameCount === this.frameLen) {
        this.onFrame(toDb(Math.sqrt(this.frameSum / this.frameCount)));
        this.frameSum = 0;
        this.frameCount = 0;
      }
    }
    return this.result;
  }

  get result(): SpeechCheckResult {
    return {
      speechMs: Math.round(this.speech),
      noiseFloorDb: roundDb(this.floor ?? MIN_DB),
      speechDb: roundDb(this.speechFrames ? toDb(Math.sqrt(this.speechPower / this.speechFrames)) : MIN_DB),
      passed: this.speech >= this.minSpeechMs,
      analysedMs: Math.round(this.analysed),
    };
  }

  reset() {
    this.ringFill = 0;
    this.ringPos = 0;
    this.frameSum = 0;
    this.frameCount = 0;
    this.floor = null;
    this.inSpeech = false;
    this.gapMs = 0;
    this.speech = 0;
    this.analysed = 0;
    this.speechPower = 0;
    this.speechFrames = 0;
  }

  private onFrame(db: number) {
    this.analysed += this.frameMs;
    if (db <= SILENCE_DB) {
      this.endOrBridge();
      return;
    }
    this.floorRing[this.ringPos] = db;
    this.ringPos = (this.ringPos + 1) % this.floorRing.length;
    if (this.ringFill < this.floorRing.length) this.ringFill++;
    let floor = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.ringFill; i++) floor = Math.min(floor, this.floorRing[i]!);
    this.floor = floor;

    if (db >= this.minSpeechDb && db >= floor + this.marginDb) {
      if (this.inSpeech) this.speech += this.gapMs;
      this.gapMs = 0;
      this.inSpeech = true;
      this.speech += this.frameMs;
      this.speechPower += 10 ** (db / 10);
      this.speechFrames++;
    } else {
      this.endOrBridge();
    }
  }

  private endOrBridge() {
    if (!this.inSpeech) return;
    this.gapMs += this.frameMs;
    if (this.gapMs > this.hangoverMs) {
      this.inSpeech = false;
      this.gapMs = 0;
    }
  }
}
