/**
 * Microphone capture engine: the typed facade.
 *
 *   const rec = new MicRecorder({ now, clockOffsetMs, sendStart, sendChunk, sendStop, onLevel, onState });
 *   button.onclick = () => { rec.prepare(); void rec.start("mic_check"); };   // inside the click (Safari)
 *   const detector = new SpeechDetector({ minSpeechMs: 1000 });
 *   const off = rec.addTap((s) => show(detector.push(s)));
 *   socket.on("connect", () => rec.onReconnect());
 *   await rec.stop("paused");
 *
 * No socket, UI or storage dependencies: all I/O is injected.
 */
export type { ChunkDraft } from "./chunker";
export {
  type BrowserFamily,
  classifyMicError,
  detectBrowser,
  detectOs,
  MicError,
  type MicErrorInfo,
  type MicErrorKind,
  type MicHelp,
  micHelp,
  micSupportProblem,
  type OsFamily,
} from "./errors";
export { LevelMeter, MIN_DB, peakDb, rmsDb, toDb } from "./levels";
export {
  MicRecorder,
  type MicRecorderOptions,
  pickSettings,
  type RecorderEnv,
  type RecorderStatus,
} from "./MicRecorder";
export { floatToInt16, int16FromLittleEndian, int16ToLittleEndian } from "./pcm";
export { Resampler, resampledLength } from "./resampler";
export { type SpeechCheckResult, SpeechDetector, type SpeechDetectorOptions } from "./speech";
export type { TimingSample } from "./timing";
export {
  type AudioCaptureSettings,
  type AudioChunk,
  type AudioContextInfo,
  type AudioStartInfo,
  type AudioStopInfo,
  DEFAULT_CHUNK_SECONDS,
  DEFAULT_MAX_PENDING_SECONDS,
  MIC_CONSTRAINTS,
  type MicLevel,
  type RecorderState,
  type SendResult,
  TARGET_SAMPLE_RATE,
  type TimingMethod,
} from "./types";
