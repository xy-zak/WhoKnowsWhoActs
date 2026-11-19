/**
 * Input/output types and tunable parameters of the speaker-attribution engine (see `index.ts`).
 *
 * Plain data only (numbers, strings, typed arrays), so everything can cross a `worker_thread`
 * boundary. The job runner maps the result onto the shared REST contracts in
 * `packages/shared/src/audio.ts`.
 *
 * Conventions:
 * - **Time** is server-epoch milliseconds (the clock of `serverTs` in the event log).
 * - **Levels** are dBFS of the mean-square energy (0 dB = full-scale square wave); −120 dB stands
 *   for digital silence. `NaN` means "no data" (a lost chunk, no track), never silence.
 * - **Frames** are 10 ms. Frame `f` of the session timeline covers `[t0 + 10·f, t0 + 10·(f+1))`.
 * - **Leakage** `L[s][j]` (dB) is how loud seat `s`'s voice is on mic `j` relative to its own
 *   mic `s` (negative: quieter). It includes the gain difference between the two mics.
 */

import {
  type AttributionGrade,
  AUDIO_SAMPLE_RATE,
  AUDIO_SILENCE_DB,
  CALIBRATION_MIN_MARGIN_DB,
} from "@wkwa/shared";

/** Version of the algorithm; stored with every derivative so results can be traced to the code. */
export const ENGINE_VERSION = "wkwa-gate-attribution/2.0.0";
/** The capture format: 16 kHz mono signed 16-bit PCM. */
export const SAMPLE_RATE = AUDIO_SAMPLE_RATE;
/** Frame length of the features and of the session timeline. */
export const HOP_MS = 10;
export const HOP_SAMPLES = (SAMPLE_RATE * HOP_MS) / 1000;
/** Level reported for digital silence (and the floor of every level). */
export const SILENCE_DB = AUDIO_SILENCE_DB;
/** At or below this level a frame is a dead signal (digital silence), not quiet room noise. */
export const DEAD_DB = -110;

/** Metadata of one stored 5 s chunk of a track (as received from the client). */
export interface ChunkMeta {
  seq: number;
  /** Index of the chunk's first sample within its track. */
  startSample: number;
  sampleCount: number;
  /** The client's estimate (server-epoch ms, clock-sync corrected) of the first sample's capture time. */
  clientTs: number;
  /** When the server received the chunk (server-epoch ms). Used only when `clientTs` is missing. */
  serverTs: number;
}

/**
 * Per-frame features of one track (`FeatureBuilder`). Frame `k` covers samples `[160k, 160k + 160)`.
 */
export interface TrackFeatures {
  frames: number;
  /** Mean-square energy after a 100 Hz high-pass (dBFS); `NaN` = no samples. */
  energyDb: Float32Array;
  /** 1 when a sample in the frame is at full scale. */
  clipped: Uint8Array;
  /** Speech probability (0–1) from the voice activity detector; null when none ran (energy is used). */
  speech: Float32Array | null;
}

/** One continuous capture run of one seat, reduced to its features. */
export interface TrackInput {
  trackId: string;
  seat: number;
  /** Nominal sample rate (default 16 000). */
  sampleRate?: number;
  chunks: readonly ChunkMeta[];
  features: TrackFeatures;
}

/** One calibration turn as logged by the server: seat `seat` was asked to read between the two times. */
export interface CalibrationTurn {
  seat: number;
  startTs: number;
  endTs: number;
}

export interface AnalysisInput {
  tracks: readonly TrackInput[];
  /** All seats of the session (default: the seats that have tracks). Seats without audio are reported. */
  seats?: readonly number[];
  /** Logged calibration turns; without them a conservative default leakage is used. */
  calibration?: { turns: readonly CalibrationTurn[] } | null;
  /** Limit the analysis to this window (server-epoch ms); default: from the first to the last sample. */
  window?: { fromTs: number; toTs: number } | null;
  options?: Partial<AttributionOptions>;
}

/** Tunable parameters. Defaults (`DEFAULT_OPTIONS`) are the values the tests validate. */
export interface AttributionOptions {
  /** Speech detector: a frame starts speech at this probability… */
  speechOnProb: number;
  /** …and stays speech while it is at least this (hysteresis). */
  speechOffProb: number;
  /** Without a speech detector: speech is energy this far above the mic's noise floor. */
  energyMarginDb: number;
  /** Noise floor: this low percentile of a mic's frame energies. */
  floorPercentile: number;
  /** Gate: own level must exceed every other speaker's predicted leakage onto this mic by this much. */
  gateMarginDb: number;
  /** Gate: each other mic's peak within ± this is compared (covers the timing error between devices). */
  alignToleranceMs: number;
  /** Leakage used without a calibration (conservative: laptop-like). */
  defaultLeakageDb: number;
  /** A speech frame within this distance of the gate threshold counts as ambiguous. */
  ambiguousDb: number;
  /** Smoothing: speech runs shorter than this are dropped. */
  minSpeechMs: number;
  /** Smoothing: pauses shorter than this inside one seat's speech are bridged. */
  minGapMs: number;
  /** Smoothing: each speech run is extended by this much after it ends… */
  hangoverMs: number;
  /** …and by this much before it starts. */
  preRollMs: number;
  /** Calibration: only frames where the reader's mic is this far above its floor are used. */
  calibrationActiveDb: number;
  /** Calibration: fewer active frames than this (10 ms each) means "not enough speech". */
  minCalibrationFrames: number;
  /** Calibration: required margin between a seat's own mic and every other mic (headsets: ≈ 25 dB). */
  minMarginDb: number;
  /** Calibration: required own-voice level above the own noise floor. */
  minSnrDb: number;
  /** Calibration: share of clipped frames above which the seat is flagged. */
  maxClippingShare: number;
  /** Warn above this share of ambiguous speech frames. */
  ambiguousWarnShare: number;
  /** Warn above this share of clipped frames (session-wide, per seat). */
  clippingWarnShare: number;
  /** Clock drifts beyond this are treated as a broken timestamp series (nominal rate used instead). */
  maxPlausibleDriftPpm: number;
}

export const DEFAULT_OPTIONS: AttributionOptions = {
  speechOnProb: 0.5,
  speechOffProb: 0.35,
  energyMarginDb: 10,
  floorPercentile: 0.1,
  gateMarginDb: 6,
  alignToleranceMs: 60,
  defaultLeakageDb: -10,
  ambiguousDb: 3,
  minSpeechMs: 250,
  minGapMs: 200,
  hangoverMs: 100,
  preRollMs: 20,
  calibrationActiveDb: 10,
  minCalibrationFrames: 100,
  minMarginDb: CALIBRATION_MIN_MARGIN_DB,
  minSnrDb: 15,
  maxClippingShare: 0.01,
  ambiguousWarnShare: 0.1,
  clippingWarnShare: 0.005,
  maxPlausibleDriftPpm: 1000,
};

export function resolveOptions(partial?: Partial<AttributionOptions>): AttributionOptions {
  return { ...DEFAULT_OPTIONS, ...(partial ?? {}) };
}

/** The common session timeline: `frames` frames of `hopMs` starting at `t0`. */
export interface Timeline {
  t0: number;
  hopMs: number;
  frames: number;
}

/**
 * Where one track sits on the server clock: sample `n` was captured at `startTs + n · msPerSample`.
 */
export interface TrackAlignment {
  trackId: string;
  seat: number;
  startTs: number;
  msPerSample: number;
  /** Sample-clock drift: positive means the device produced more samples per second than nominal. */
  driftPpm: number;
  samples: number;
  /** Time just after the last sample. */
  endTs: number;
  /** RMS residual of the clock fit (ms): the jitter of the client timestamps. */
  residualMs: number;
}

/** The leakage matrix, indexed `[speaker][mic]` in the order of `seats`; diagonal 0. */
export interface LeakageReport {
  seats: number[];
  /** `matrixDb[s][j]` = L[s][j] in dB; null when the calibration could not measure it. */
  matrixDb: (number | null)[][];
  /** `calibration` when at least one row was measured, else `default`. */
  source: "calibration" | "default";
}

export type CalibrationIssue = "no_signal" | "not_enough_speech" | "too_quiet" | "low_margin" | "clipping";

/** Calibration quality of one seat. */
export interface CalibrationSeatQuality {
  seat: number;
  /** Frames of the seat's turn where its mic was clearly active (10 ms each). */
  frames: number;
  /** Median level of the seat's voice on its own mic (dBFS). */
  ownDb: number | null;
  /** Own voice above the own mic's noise floor (dB). */
  snrDb: number | null;
  /** Level of the seat's voice on the other mic that hears it best (dBFS), and which seat that is. */
  bestOtherDb: number | null;
  bestOtherSeat: number | null;
  /**
   * Gain-invariant separation: min over other seats j of −(L[s][j] + L[j][s]) / 2 (mic gain
   * differences cancel in the sum); −L[s][j] where only one direction was measured.
   */
  marginDb: number | null;
  clippingShare: number;
  ok: boolean;
  issues: CalibrationIssue[];
  /** One-line advice for the facilitator, or null when the seat is fine. */
  advice: string | null;
}

export interface CalibrationReport {
  ok: boolean;
  seats: CalibrationSeatQuality[];
  leakage: LeakageReport;
  warnings: string[];
}

/** One stretch of speech by one seat on the server clock. */
export interface SpeechSegment {
  seat: number;
  startTs: number;
  endTs: number;
  durationMs: number;
  /** Mean level of the seat's own mic over the segment's speech frames (dBFS). */
  meanDb: number;
  /** 0–1: mean speech probability (or share of gated speech frames) inside the segment. */
  confidence: number;
  /** True when another seat was speaking at the same time for part of the segment. */
  overlap: boolean;
  overlapMs: number;
  overlapWith: number[];
}

/** A seat's frame mask, run-length encoded: `[start0, end0, start1, end1, …]` in timeline frames (end exclusive). */
export interface SeatMask {
  seat: number;
  runs: number[];
}

export interface SeatQuality {
  seat: number;
  tracks: number;
  /** Share of the timeline with usable audio from this seat (not lost, not digital silence). */
  coverage: number;
  /** Share of this seat's frames with clipping. */
  clippingShare: number;
  /** Noise floor (dBFS). */
  noiseFloorDb: number | null;
  /** Median own-mic level in this seat's attributed speech (dBFS). */
  speechLevelDb: number | null;
  /** `speechLevelDb − noiseFloorDb`. */
  snrDb: number | null;
  /** Clock drift of the seat's longest track (ppm). */
  driftPpm: number | null;
  talkTimeMs: number;
  overlapMs: number;
}

export interface QualityReport {
  /** `good`: no warnings; `fair`: warnings, results usable with care; `poor`: results unreliable. */
  grade: AttributionGrade;
  /** How speech was detected: the Silero model, or energy above the noise floor (fallback). */
  detector: "silero" | "energy";
  calibration: CalibrationSeatQuality[] | null;
  /** Share of speech frames whose gate decision was within `ambiguousDb` of the threshold. */
  ambiguousShare: number;
  seats: SeatQuality[];
  warnings: string[];
}

export interface AttributionResult {
  engineVersion: string;
  options: AttributionOptions;
  timeline: Timeline & { endTs: number };
  seats: number[];
  alignment: TrackAlignment[];
  leakage: LeakageReport;
  segments: SpeechSegment[];
  /** Total attributed speech per seat (ms), keyed by seat number. */
  talkTimeMs: Record<number, number>;
  /** Time during which two or more seats spoke at once (ms). */
  overlapMs: number;
  masks: SeatMask[];
  quality: QualityReport;
}
