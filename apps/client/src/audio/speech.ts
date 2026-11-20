import { AUDIO_SAMPLE_RATE } from "@wkwa/shared";
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
 *  - A frame is speech when it is at least MARGIN_DB above the floor and
 *    above MIN_SPEECH_DB. Gaps up to HANGOVER_MS between speech frames
 *    (troughs between syllables) are counted as speech, but only when speech
 *    resumes, so the hangover never lengthens the end of a burst.
 *  - It passes once the speech adds up to `minSpeechMs`.
 *
 * This only checks that the microphone hears the participant; it says
 * nothing about who is speaking (no speaker identification).
 */
export interface SpeechDetectorOptions {
  /** speech needed to pass; default 1000 ms */
  minSpeechMs?: number;
}

const FRAME_MS = 20;
const FRAME_LEN = Math.round((AUDIO_SAMPLE_RATE * FRAME_MS) / 1000);
/** speech must be this far above the noise floor */
const MARGIN_DB = 12;
/** and above this absolute level (dBFS) */
const MIN_SPEECH_DB = -60;
/** gaps up to this long inside speech still count */
const HANGOVER_MS = 200;
/** noise-floor window */
const FLOOR_WINDOW_MS = 3000;

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
  private readonly floorRing = new Float64Array(FLOOR_WINDOW_MS / FRAME_MS);
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
    this.minSpeechMs = o.minSpeechMs ?? 1000;
  }

  /** Analyses 16 kHz samples; returns the result so far. */
  push(samples: ArrayLike<number>): SpeechCheckResult {
    for (let i = 0; i < samples.length; i++) {
      const v = samples[i]!;
      this.frameSum += v * v;
      if (++this.frameCount === FRAME_LEN) {
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

  private onFrame(db: number) {
    this.analysed += FRAME_MS;
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

    if (db >= MIN_SPEECH_DB && db >= floor + MARGIN_DB) {
      if (this.inSpeech) this.speech += this.gapMs;
      this.gapMs = 0;
      this.inSpeech = true;
      this.speech += FRAME_MS;
      this.speechPower += 10 ** (db / 10);
      this.speechFrames++;
    } else {
      this.endOrBridge();
    }
  }

  private endOrBridge() {
    if (!this.inSpeech) return;
    this.gapMs += FRAME_MS;
    if (this.gapMs > HANGOVER_MS) {
      this.inSpeech = false;
      this.gapMs = 0;
    }
  }
}
