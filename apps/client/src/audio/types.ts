/**
 * Local types of the microphone capture engine.
 *
 * The field names match the socket messages `audio:start`, `audio:chunk`,
 * `audio:stop`, `audio:level` and `mic:check` defined in packages/shared
 * (`AudioChunk` and `SendResult` are derived from there); the engine itself has
 * no socket or UI dependency (all I/O is injected into MicRecorder).
 */
import type {
  AUDIO_SAMPLE_RATE,
  AudioChunkInput,
  AudioStartReason,
  AudioStopReason,
  audioSendResult,
  MicLevelState,
} from "@wkwa/shared";

/** Default cap of unacknowledged audio kept in memory (30 min ≈ 57.6 MB). */
export const DEFAULT_MAX_PENDING_SECONDS = 1800;

/**
 * Raw capture: no echo cancellation, noise suppression or automatic gain, so
 * the server can compare the energy of the four microphones later.
 * Plain values are "ideal" constraints: the browser applies what it can, and
 * what it applied is recorded from `track.getSettings()`.
 */
export const MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
  video: false,
};

/**
 * Recorder state, as shown to the participant and the facilitator (the `audio:level` state):
 * idle = not recording (initially and after stop()); requesting = waiting for the permission
 * prompt or setting up the audio graph; recording = audio is flowing and has signal; paused =
 * recording is wanted, but the AudioContext is suspended or interrupted (call resume() from a
 * click); no_signal = recording, but the input is muted or digital silence for a while (chunks are
 * still sent); denied = the participant or the system blocked microphone access; error = any
 * other failure (see RecorderStatus.error).
 */
export type RecorderState = MicLevelState;

/** Level of the last ~250 ms (dBFS, full-scale square wave = 0 dB, full-scale sine ≈ −3 dB). */
export interface MicLevel {
  rmsDb: number;
  peakDb: number;
}

/** How chunk times were mapped from the AudioContext clock to the performance clock. */
export type TimingMethod = "output-timestamp" | "current-time";

/**
 * Audio processing the browser actually applied, from `track.getSettings()`.
 * Only these whitelisted fields are copied: never `deviceId`, `groupId` or `label`.
 * Wider than the shared `AudioCaptureSettings` (sampleSize, voiceIsolation, latency): the server
 * keeps what it knows and strips the rest.
 */
export interface EngineCaptureSettings {
  /** sample rate of the microphone track (Hz), before the engine resamples to 16 kHz */
  sampleRate?: number;
  sampleSize?: number;
  channelCount?: number;
  /** boolean, or a string such as "all" / "remote-only" in newer Chrome */
  echoCancellation?: boolean | string;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
  voiceIsolation?: boolean;
  /** capture latency reported by the browser (seconds) */
  latency?: number;
}

/** The AudioContext the track was captured with. */
export interface AudioContextInfo {
  /** native rate the worklet captured at (44 100 / 48 000 / …) */
  sampleRate: number;
  /** AudioContext.baseLatency in ms, null if the browser does not report it */
  baseLatencyMs: number | null;
  /** AudioContext.outputLatency in ms, null if the browser does not report it */
  outputLatencyMs: number | null;
  /** clock mapping in use when the track started */
  timingMethod: TimingMethod;
}

/** Sent once when a track (one continuous capture run) begins. */
export interface AudioStartInfo {
  /** random UUID of this capture run */
  trackId: string;
  /** why the track started: the reason given to start(), or "context_resumed" / "clock_jump" / "discontinuity" / "cleared" */
  reason: AudioStartReason;
  /** rate of the PCM in the chunks: always 16 000 */
  sampleRate: typeof AUDIO_SAMPLE_RATE;
  /** samples in a full chunk (chunkSeconds × 16 000); the last chunk of a track may be shorter */
  chunkSamples: number;
  /** server-epoch ms estimate of when the track's first sample was captured */
  clientTs: number;
  /** ClockSync offset (ms) in use when clientTs was computed */
  clockOffsetMs: number;
  /** capture-side latency subtracted from every clientTs (ms): settings.latency, or 0 if not reported */
  inputLatencyMs: number;
  settings: EngineCaptureSettings;
  context: AudioContextInfo;
}

/**
 * One chunk of a track (the `audio:chunk` message): 16 kHz mono signed 16-bit little-endian PCM,
 * `startSample` contiguous (previous startSample + sampleCount), `pcm` exactly sampleCount × 2 bytes.
 */
export type AudioChunk = Omit<AudioChunkInput, "pcm"> & { pcm: Uint8Array };

/** Sent once when a track ends, after its last chunk. */
export interface AudioStopInfo {
  trackId: string;
  /** the reason given to stop(), or "track_ended" / "context_suspended" / "context_interrupted" / "clock_jump" / "discontinuity" / "cleared" / "error" */
  reason: AudioStopReason;
  /** chunks the track produced (seq 0 … chunks − 1) */
  chunks: number;
  /** 16 kHz samples the track produced */
  samples: number;
  /** server-epoch ms estimate of the end of the track's last sample */
  clientTs: number;
  clockOffsetMs: number;
}

/**
 * Result of one delivery attempt: true = the server stored it (acked),
 * false = transient failure (retried), "rejected" = permanent refusal (dropped, not retried).
 */
export type SendResult = ReturnType<typeof audioSendResult>;
