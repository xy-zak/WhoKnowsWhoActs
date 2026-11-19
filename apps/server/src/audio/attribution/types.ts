/**
 * Local input/output types and tunable parameters of the speaker-attribution engine.
 *
 * The algorithm itself is documented in `index.ts`. These types are deliberately **local to the
 * engine**: the job runner (wave 2) maps them onto the shared REST contracts in
 * `packages/shared/src/audio.ts`. Everything here is plain data (numbers, strings, typed arrays),
 * so it can cross a `worker_thread` boundary with structured clone.
 *
 * Conventions used throughout the engine:
 * - **Time** is server-epoch milliseconds (the clock of `serverTs` in the event log).
 * - **Levels** are dBFS of the mean-square energy: 0 dB is a full-scale square wave, −3 dB a
 *   full-scale sine, and −120 dB is used for digital silence.
 * - **Leakage** `G[s][j]` (dB) is how much louder (positive) or quieter (negative) seat `s`'s voice
 *   arrives on mic `j` than on its own mic `s`; `G[s][s] = 0`. It includes the gain difference
 *   between the two devices, so it can be positive when mic `j` is set much louder.
 * - **Frames** are 10 ms hops (20 ms analysis windows). Frame `f` of the session timeline covers
 *   `[t0 + 10·f, t0 + 10·(f+1))`.
 */

import { type AttributionGrade, AUDIO_SAMPLE_RATE, AUDIO_SILENCE_DB } from "@wkwa/shared";

/** Version of the algorithm; stored with every derivative so results can be traced to the code. */
export const ENGINE_VERSION = "wkwa-energy-attribution/1.0.0";
/** The capture format: 16 kHz mono signed 16-bit PCM. */
export const SAMPLE_RATE = AUDIO_SAMPLE_RATE;
/** Frame hop of every envelope and of the session timeline. */
export const HOP_MS = 10;
/** Length of the analysis window centred on each hop. */
export const WINDOW_MS = 20;
/** Level reported for digital silence (and the floor of every level). */
export const SILENCE_DB = AUDIO_SILENCE_DB;
/** At or below this level a frame counts as a dead signal (digital silence), not as quiet room noise. */
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
 * Per-frame energy envelope of one track, produced by `EnvelopeBuilder`.
 * Frame `k` covers samples `[k·hop, (k+1)·hop)`; its energy is measured over a 20 ms window
 * centred on that hop. `NaN` energy means "no data" (a lost chunk), not silence.
 */
export interface Envelope {
  sampleRate: number;
  hopSamples: number;
  frames: number;
  /** Mean-square energy after a 100 Hz high-pass (dBFS); `NaN` = no samples for this frame. */
  energyDb: Float32Array;
  /** Highest absolute raw sample in the frame's hop (dBFS); `NaN` = no data. */
  peakDb: Float32Array;
  /** 1 when at least one raw sample in the frame's hop is at full scale. */
  clipped: Uint8Array;
}

/** One continuous capture run of one seat, reduced to its envelope (the PCM is not needed for analysis). */
export interface TrackInput {
  trackId: string;
  seat: number;
  /** Nominal sample rate (default 16 000). */
  sampleRate?: number;
  chunks: readonly ChunkMeta[];
  envelope: Envelope;
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
  /** Logged calibration turns; without them the leakage matrix is estimated from the session itself. */
  calibration?: { turns: readonly CalibrationTurn[] } | null;
  /** Limit the analysis to this window (server-epoch ms); default: from the first to the last sample. */
  window?: { fromTs: number; toTs: number } | null;
  options?: Partial<AttributionOptions>;
}

/** Optional callbacks for a job runner. */
export interface AnalysisHooks {
  /** Called between stages; `fraction` is the share of the work done (0–1). */
  onProgress?: (progress: { stage: string; fraction: number }) => void;
}

/** Tunable parameters. Defaults (`DEFAULT_OPTIONS`) are the values the tests validate. */
export interface AttributionOptions {
  /** Noise floor: length of the sliding window. */
  floorWindowSec: number;
  /** Noise floor: the low percentile of frame energies taken as the floor. */
  floorPercentile: number;
  /** A channel is a speech candidate in a frame when it is at least this far above its noise floor. */
  activeMarginDb: number;
  /** A second seat counts as overlapping speech when its mic exceeds the predicted leakage by this much. */
  overlapMarginDb: number;
  /** …or by this multiple of the measured spread of that leakage, whichever is larger. */
  overlapSpreadFactor: number;
  /** Residuals larger than this (dB) count linearly instead of quadratically in the pattern fit. */
  huberDb: number;
  /** Extra cost of explaining a frame by a seat whose own mic has no data at that moment. */
  absentPenalty: number;
  /** A frame is ambiguous when the best and second-best speaker differ by less than this (dB). */
  ambiguousDb: number;
  /** Smoothing: speech runs shorter than this are dropped. */
  minSpeechMs: number;
  /** Smoothing: pauses shorter than this inside one seat's speech are bridged. */
  minGapMs: number;
  /** Smoothing: each speech run is extended by this much after it ends… */
  hangoverMs: number;
  /** …and by this much before it starts (compensates the analysis window). */
  preRollMs: number;
  /** Lag refinement: window length for envelope cross-correlation. */
  lagWindowSec: number;
  /** Lag refinement: search range (±). */
  lagMaxMs: number;
  /** Lag refinement: minimum normalised correlation for a window to count. */
  lagMinCorr: number;
  /** Calibration: only frames where the reader's mic is this far above its floor are used. */
  calibrationActiveDb: number;
  /** Calibration: fewer active frames than this (10 ms each) means "not enough speech". */
  minCalibrationFrames: number;
  /** Calibration quality: required gain-invariant margin between a seat and every other seat. */
  minMarginDb: number;
  /** Calibration quality: required own-voice level above the own noise floor. */
  minSnrDb: number;
  /** Calibration quality: share of clipped frames above which the seat is flagged. */
  maxClippingShare: number;
  /** Leakage estimation without calibration: minimum level above floor of the dominant mic. */
  estimateMinSnrDb: number;
  /** Leakage estimation without calibration: the same mic must dominate this many frames in a row. */
  estimateMinRunFrames: number;
  /** Warn when the leakage seen during the session differs from the calibration by more than this. */
  leakageChangeWarnDb: number;
  /** Warn above this share of ambiguous speech frames. */
  ambiguousWarnShare: number;
  /** Warn above this share of clipped frames (session-wide, per seat). */
  clippingWarnShare: number;
  /** Clock drifts beyond this are treated as a broken timestamp series (nominal rate used instead). */
  maxPlausibleDriftPpm: number;
}

export const DEFAULT_OPTIONS: AttributionOptions = {
  floorWindowSec: 30,
  floorPercentile: 0.05,
  activeMarginDb: 6,
  overlapMarginDb: 6,
  overlapSpreadFactor: 3,
  huberDb: 4,
  absentPenalty: 16,
  ambiguousDb: 3,
  minSpeechMs: 250,
  minGapMs: 200,
  hangoverMs: 100,
  preRollMs: 20,
  lagWindowSec: 40,
  lagMaxMs: 500,
  lagMinCorr: 0.3,
  calibrationActiveDb: 10,
  minCalibrationFrames: 100,
  minMarginDb: 10,
  minSnrDb: 15,
  maxClippingShare: 0.01,
  estimateMinSnrDb: 15,
  estimateMinRunFrames: 10,
  leakageChangeWarnDb: 4,
  ambiguousWarnShare: 0.1,
  clippingWarnShare: 0.005,
  maxPlausibleDriftPpm: 1000,
};

export function resolveOptions(partial?: Partial<AttributionOptions>): AttributionOptions {
  return { ...DEFAULT_OPTIONS, ...(partial ?? {}) };
}

/** The common session timeline: `frames` hops of `hopMs` starting at `t0`. */
export interface Timeline {
  t0: number;
  hopMs: number;
  frames: number;
}

/**
 * Where one track sits on the session timeline. Sample `n` of the track was captured at
 * `startTs + offsetMs + n · msPerSample` (server-epoch ms).
 */
export interface TrackAlignment {
  trackId: string;
  seat: number;
  /** Time of sample 0 from the robust regression of `clientTs` on `startSample`. */
  startTs: number;
  /** Correction from envelope cross-correlation (and the drift refinement), added to `startTs`. */
  offsetMs: number;
  /** Final sample-clock drift: positive means the device produced more samples per second than nominal. */
  driftPpm: number;
  /** Drift from the timestamp regression alone (before the cross-correlation refinement). */
  clockDriftPpm: number;
  /** Duration of one sample on the server clock (`1000 / (rate · (1 + driftPpm·1e-6))`). */
  msPerSample: number;
  samples: number;
  /** `startTs + offsetMs`, and the time just after the last sample. */
  alignedStartTs: number;
  alignedEndTs: number;
  /** 0–1: how well the cross-correlation confirmed this track's alignment (0 = timestamps only). */
  confidence: number;
  /** The reference track all others are aligned to (the one with the most data). */
  anchor: boolean;
  /** Tracks of one seat share a clock group (one device) unless a track's own rate disagreed. */
  clockGroup: string;
  /** RMS residual of the timestamp regression (ms): the client timestamp jitter. */
  clockResidualMs: number;
  clockOutliers: number;
  lagObservations: number;
  /** RMS residual of this track's accepted cross-correlation lags after the solve (ms). */
  lagResidualMs: number | null;
}

/** The leakage matrix, indexed `[speaker][mic]` in the order of `seats`. */
export interface LeakageReport {
  seats: number[];
  /** `matrixDb[s][j]` = G[s][j] in dB; diagonal 0; null when it could not be measured. */
  matrixDb: (number | null)[][];
  /** Robust spread (σ, dB) of the frame-by-frame measurements behind each entry. */
  spreadDb: (number | null)[][];
  /** True when the leakage was below the mic's noise floor most of the time (the value is an upper bound). */
  belowFloor: boolean[][];
  /** Where the matrix came from overall (`calibration` when at least one row was calibrated). */
  source: "calibration" | "estimated";
  rowSource: Array<"calibration" | "estimated" | "default">;
  /** Number of frames behind each row. */
  rowFrames: number[];
  /** The same matrix re-estimated from the session's own single-speaker frames (consistency check). */
  sessionMatrixDb: (number | null)[][] | null;
  /** Largest absolute difference between calibration and session matrices (dB), when both exist. */
  maxChangeDb: number | null;
}

export type CalibrationIssue =
  | "no_signal"
  | "not_enough_speech"
  | "too_quiet"
  | "low_margin"
  | "clipping"
  | "others_spoke";

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
  /** `ownDb − bestOtherDb`: how much louder the voice is on its own mic than on the nearest other mic. */
  rawMarginDb: number | null;
  /**
   * Gain-invariant decision margin: min over other seats j of −(G[s][j] + G[j][s]) / 2. Mic gain
   * differences cancel in this sum, so it is the margin the attribution actually works with.
   */
  marginDb: number | null;
  clippingShare: number;
  /** Share of the turn in which another seat's mic showed speech that was not this seat's leakage. */
  othersActiveShare: number;
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
  /** Compute time (ms). */
  elapsedMs: number;
}

/** One stretch of speech by one seat on the server clock. */
export interface SpeechSegment {
  seat: number;
  startTs: number;
  endTs: number;
  durationMs: number;
  /** Mean level of the seat's own mic over the segment's speech frames (dBFS). */
  meanDb: number;
  /** 0–1: mean per-frame confidence of the attribution inside the segment. */
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

export interface LagPairReport {
  seatA: number;
  seatB: number;
  windows: number;
  accepted: number;
  /** Median measured lag of B relative to A before correction (ms). */
  medianLagMs: number | null;
  meanCorr: number | null;
}

export interface LagReport {
  windows: number;
  observations: number;
  accepted: number;
  /** RMS of the accepted lags around the solved offsets (ms). */
  residualRmsMs: number | null;
  pairs: LagPairReport[];
}

export interface SeatQuality {
  seat: number;
  tracks: number;
  /** Time covered by this seat's audio (ms). */
  dataMs: number;
  /** Share of the timeline without audio from this seat (no track or lost chunks). */
  noDataShare: number;
  /** Share of the timeline where the seat sent digital silence. */
  deadShare: number;
  /** `noDataShare + deadShare`. */
  noSignalShare: number;
  /** Share of this seat's frames with clipping. */
  clippingShare: number;
  /** Median noise floor (dBFS). */
  noiseFloorDb: number | null;
  /** Median own-mic level in this seat's attributed speech (dBFS). */
  speechLevelDb: number | null;
  /** `speechLevelDb − noiseFloorDb`. */
  snrDb: number | null;
  talkTimeMs: number;
  overlapMs: number;
  /** Share of this seat's dominant frames that were ambiguous. */
  ambiguousShare: number;
}

export interface QualityReport {
  /** `good`: no warnings; `fair`: warnings, results usable with care; `poor`: results unreliable. */
  grade: AttributionGrade;
  calibration: CalibrationSeatQuality[] | null;
  leakageSource: "calibration" | "estimated";
  /** Share of speech frames (any mic active) where the speaker could not be told apart clearly. */
  ambiguousFrameShare: number;
  /** Share of all frames with audio that were clipped. */
  clippingShare: number;
  /** Mean over seats of the share of the timeline without a usable signal. */
  noSignalShare: number;
  /** Share of speech frames best explained by a seat whose mic had no data at that moment. */
  absentSpeakerShare: number;
  driftPpm: Array<{ trackId: string; seat: number; driftPpm: number }>;
  lag: LagReport;
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
  /** Compute time per stage (ms). */
  timingsMs: Record<string, number>;
}

/** Server time (ms) at which sample `n` of an aligned track was captured. */
export function sampleTime(alignment: TrackAlignment, n: number): number {
  return alignment.startTs + alignment.offsetMs + n * alignment.msPerSample;
}
