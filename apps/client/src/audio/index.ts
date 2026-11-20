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
export { classifyMicError, MicError, type MicErrorInfo, micSupportProblem } from "./errors";
export { MicRecorder, type MicRecorderOptions, type RecorderStatus } from "./MicRecorder";
export { type SpeechCheckResult, SpeechDetector } from "./speech";
export type {
  AudioChunk,
  AudioStartInfo,
  AudioStopInfo,
  EngineCaptureSettings,
  MicLevel,
  RecorderState,
  SendResult,
} from "./types";
