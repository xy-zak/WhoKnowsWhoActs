/**
 * Local types of the microphone capture engine.
 *
 * The field names match the socket messages `audio:start`, `audio:chunk`,
 * `audio:stop`, `audio:level` and `mic:check` defined in packages/shared
 * (`AudioChunk` and `SendResult` are derived from there); the engine itself has
 * no socket or UI dependency (all I/O is injected into MicRecorder).
 */
import type {
  AudioChunkInput,
  audioSendResult,
  EngineCaptureSettings,
  MicLevelState,
  PlayerPayload,
} from "@wkwa/shared";

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

export type { AudioContextInfo, EngineCaptureSettings } from "@wkwa/shared";

/** Sent once when a track (one continuous capture run) begins; the engine always sends every field. */
export type AudioStartInfo = Required<Omit<PlayerPayload<"audio:start">, "settings">> & {
  settings: EngineCaptureSettings;
};

/**
 * One chunk of a track (the `audio:chunk` message): 16 kHz mono signed 16-bit little-endian PCM,
 * `startSample` contiguous (previous startSample + sampleCount), `pcm` exactly sampleCount × 2 bytes.
 */
export type AudioChunk = Omit<AudioChunkInput, "pcm"> & { pcm: Uint8Array };

/** Sent once when a track ends, after its last chunk; the engine always sends every field. */
export type AudioStopInfo = Required<PlayerPayload<"audio:stop">>;

/**
 * Result of one delivery attempt: true = the server stored it (acked),
 * false = transient failure (retried), "rejected" = permanent refusal (dropped, not retried).
 */
export type SendResult = ReturnType<typeof audioSendResult>;
