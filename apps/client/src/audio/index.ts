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
 * No socket, UI or storage dependencies: all I/O is injected. The building blocks (PCM conversion,
 * levels, resampler, chunker) are internal; their tests import the module files directly.
 */
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
export {
  MicRecorder,
  type MicRecorderOptions,
  type RecorderEnv,
  type RecorderStatus,
} from "./MicRecorder";
export { type SpeechCheckResult, SpeechDetector, type SpeechDetectorOptions } from "./speech";
export type { TimingSample } from "./timing";
export {
  type AudioChunk,
  type AudioContextInfo,
  type AudioStartInfo,
  type AudioStopInfo,
  type EngineCaptureSettings,
  MIC_CONSTRAINTS,
  type MicLevel,
  type RecorderState,
  type SendResult,
  type TimingMethod,
} from "./types";
