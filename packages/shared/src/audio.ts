import { z } from "zod";
import { AudioStopReasonSchema } from "./audioReasons";
import type { AudioExportKind, AudioExportRequestKind } from "./exportColumns";
import { SeatSchema } from "./labels";
import type { AudioChunk } from "./protocol";

/* ═══════════════════════════════════════════════════════════════════════════
 * AUDIO — shared constants and data contracts for microphone recording.
 *
 * Each participant's browser records its own microphone from the mic check
 * (after consent) until the game is complete, as 16 kHz mono signed 16-bit
 * PCM in 5 s chunks. The server stores the chunks as AES-256-GCM encrypted
 * files (one random key per file, kept in the SQLCipher database), so
 * erasing the key row crypto-shreds the file.
 *
 * Privacy rules every unit follows:
 *  - never send or store a microphone's deviceId, groupId or label; only the
 *    processing flags and the sample rate (`AudioSettingsSchema`);
 *  - only real participants who gave the separate audio consent item are
 *    recorded (see `recordingVerdict` in recordingVerdict.ts); fake players, agents and
 *    simulated sessions never record;
 *  - speaker attribution detects speech on each seat's headset mic and compares
 *    loudness across the mics; it never identifies a speaker by their voice
 *    (no voiceprints: GDPR Art. 9).
 * ═══════════════════════════════════════════════════════════════════════════ */

/* ─────────────────────────── Constants ─────────────────────────── */

/** Sample rate of every uploaded and stored track (Hz). Browsers resample to this rate before upload. */
export const AUDIO_SAMPLE_RATE = 16000;
/** Bytes per sample: signed 16-bit little-endian, mono. */
export const AUDIO_BYTES_PER_SAMPLE = 2;
/** Nominal length of one uploaded chunk (seconds). */
export const AUDIO_CHUNK_SECONDS = 5;
/** Nominal samples per chunk (5 s × 16 000). */
export const AUDIO_CHUNK_SAMPLES = AUDIO_SAMPLE_RATE * AUDIO_CHUNK_SECONDS;
/** Longest chunk the server accepts (seconds); a little slack over the nominal 5 s. */
export const AUDIO_MAX_CHUNK_SECONDS = 6;
/** Most samples one chunk may hold (6 s × 16 000). */
export const AUDIO_MAX_CHUNK_SAMPLES = AUDIO_SAMPLE_RATE * AUDIO_MAX_CHUNK_SECONDS;
/** Extension of the encrypted audio container files in `data/audio/<sessionId>/`. */
export const AUDIO_ENGINE_FILE_EXT = ".wka";
/**
 * Smallest calibration margin (dB) at which a seat passes: its own voice must be this much louder
 * on its own mic than on the others (gain differences cancelled). Headsets reach ≈ 20–30 dB.
 */
export const CALIBRATION_MIN_MARGIN_DB = 12;
/** Levels are reported in dBFS, clamped to [AUDIO_SILENCE_DB, 0]; this floor stands for digital silence. */
export const AUDIO_SILENCE_DB = -120;
/** How often the browser sends its volatile `audio:level` meter reading (ms, about 4 Hz). */
export const AUDIO_LEVEL_INTERVAL_MS = 250;
/**
 * Id of the consent item that permits audio recording (in `config/consent.json`, with `when: "audio"`).
 * A seat is recorded only when its consent was given AND this item was ticked.
 */
export const AUDIO_CONSENT_ITEM = "audio_recording";

/** Clamp a level to the documented dBFS range (non-finite values, e.g. log10(0), become silence). */
export function clampDb(db: number): number {
  if (!Number.isFinite(db)) return AUDIO_SILENCE_DB;
  return Math.min(0, Math.max(AUDIO_SILENCE_DB, db));
}

/** Duration of `samples` at the stored sample rate (ms). */
export function samplesToMs(samples: number): number {
  return (samples / AUDIO_SAMPLE_RATE) * 1000;
}

/* ─────────────────────────── s16le PCM ─────────────────────────── */

/** True on little-endian hosts (every browser and server this runs on in practice). */
export const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/**
 * Samples as signed 16-bit little-endian bytes: a view of the same memory on little-endian hosts,
 * else a byte-swapped copy. Copy it (`.slice()`) when the samples' buffer is reused.
 */
export function int16ToLeBytes(samples: Int16Array): Uint8Array {
  if (LITTLE_ENDIAN) return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  const out = new Uint8Array(samples.byteLength);
  const v = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) v.setInt16(i * 2, samples[i]!, true);
  return out;
}

/**
 * Signed 16-bit little-endian bytes as samples (a trailing odd byte is ignored): a view of the
 * same memory on little-endian hosts when the bytes are 2-byte aligned, else a copy.
 */
export function int16FromLeBytes(bytes: Uint8Array): Int16Array {
  const n = Math.floor(bytes.byteLength / 2);
  if (LITTLE_ENDIAN && bytes.byteOffset % 2 === 0) return new Int16Array(bytes.buffer, bytes.byteOffset, n);
  const out = new Int16Array(n);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < n; i++) out[i] = v.getInt16(i * 2, true);
  return out;
}

/* ─────────────────────────── Shared field schemas ─────────────────────────── */

export const Dbfs = (d: string) =>
  z.number().min(AUDIO_SILENCE_DB).max(0).describe(`${d} (dBFS, ${AUDIO_SILENCE_DB}–0; 0 = full scale)`);

/* Track start and stop reasons and microphone states: the catalogue in audioReasons.ts. */

/** Most unacknowledged audio a browser keeps in memory while offline (s; 30 min ≈ 57.6 MB). */
export const AUDIO_MAX_PENDING_SECONDS = 1800;

/**
 * How long after its close (or its last late chunk) a track still accepts late chunks (ms; 35 min):
 * the server closes a seat's track when its browser disconnects, and the browser resends what was
 * not acknowledged once it is back. It outlasts the browser's buffer (AUDIO_MAX_PENDING_SECONDS)
 * plus a margin, so the oldest chunk an outage left in memory is still taken. Audio captured while
 * recording was paused or after the game was complete is never stored, late or not (see the
 * server's live audio ingest).
 */
export const AUDIO_LATE_CHUNK_GRACE_MS = (AUDIO_MAX_PENDING_SECONDS + 5 * 60) * 1000;

/** A sample rate a browser's audio engine may capture at (Hz). */
export const CaptureSampleRate = z.number().int().min(8000).max(384000);

/**
 * What is recorded about a microphone: the processing flags the browser actually applied and
 * the capture sample rate (from `MediaStreamTrack.getSettings()`). Unknown keys are stripped, so a
 * deviceId, groupId or label sent by mistake is never stored.
 */
export const AudioSettingsSchema = z
  .object({
    sampleRate: CaptureSampleRate.describe(
      "Native sample rate of the capture, before resampling to 16 000 Hz (Hz): from getSettings(), or the AudioContext's rate where the browser does not report it (e.g. Firefox)",
    ),
    echoCancellation: z
      .boolean()
      .optional()
      .describe("Echo cancellation actually applied by the browser (requested off; absent if not reported)"),
    noiseSuppression: z
      .boolean()
      .optional()
      .describe("Noise suppression actually applied by the browser (requested off; absent if not reported)"),
    autoGainControl: z
      .boolean()
      .optional()
      .describe(
        "Automatic gain control actually applied by the browser (requested off; absent if not reported)",
      ),
    channelCount: z
      .number()
      .int()
      .min(1)
      .max(32)
      .optional()
      .describe("Channels the browser delivered (requested 1; mixed to mono before upload)"),
  })
  .describe(
    "Microphone processing settings reported by the browser (getSettings()); never the device name or id",
  );
export type AudioSettings = z.infer<typeof AudioSettingsSchema>;

/**
 * The settings as the browser's capture engine reports them (`MediaStreamTrack.getSettings()`,
 * whitelisted on the client): the sample rate may be missing (Firefox) and newer Chrome reports
 * echo cancellation as a mode string. `toAudioSettings` turns this into `AudioSettings`. Unknown
 * keys (a deviceId, groupId or label sent by mistake) are stripped.
 */
export const AudioCaptureSettingsSchema = AudioSettingsSchema.extend({
  sampleRate: CaptureSampleRate.optional().describe(
    "Native sample rate of the capture (Hz), if the browser reports it",
  ),
  echoCancellation: z
    .union([z.boolean(), z.string().max(40)])
    .optional()
    .describe(
      "Echo cancellation applied: a boolean, or a mode such as 'all' / 'remote-only' (newer Chrome); stored as a boolean",
    ),
}).describe("Microphone processing settings as reported by the browser; never the device name or id");
export type AudioCaptureSettings = z.infer<typeof AudioCaptureSettingsSchema>;

/**
 * The capture engine's whitelist of `getSettings()` (the browser's own copy): AudioCaptureSettings
 * plus what only the engine uses. Unknown keys are stripped, so the device id, group id and label
 * never leave `track.getSettings()`.
 */
export const EngineCaptureSettingsSchema = AudioCaptureSettingsSchema.extend({
  sampleSize: z.number().optional(),
  voiceIsolation: z.boolean().optional(),
  /** capture latency reported by the browser (seconds) */
  latency: z.number().optional(),
});
export type EngineCaptureSettings = z.infer<typeof EngineCaptureSettingsSchema>;

/** The browser's AudioContext a track was captured with (timing details; nothing about the device). */
export const AudioContextInfoSchema = z
  .object({
    sampleRate: CaptureSampleRate.describe(
      "Rate the audio engine captured at, before resampling to 16 000 Hz (Hz)",
    ),
    baseLatencyMs: z.number().nullable().describe("AudioContext.baseLatency (ms; null = not reported)"),
    outputLatencyMs: z.number().nullable().describe("AudioContext.outputLatency (ms; null = not reported)"),
    timingMethod: z
      .string()
      .max(40)
      .describe(
        "How the browser mapped audio frames to clock time, e.g. 'output-timestamp' or 'current-time'",
      ),
  })
  .describe("The browser's audio engine of the track");
export type AudioContextInfo = z.infer<typeof AudioContextInfoSchema>;

/**
 * `AudioSettings` from what the browser reported: the sample rate falls back to the audio
 * engine's rate, and an echo-cancellation mode string counts as on (unless it is 'none').
 * Returns null when no sample rate is known at all.
 */
export function toAudioSettings(
  capture: AudioCaptureSettings,
  contextSampleRate?: number | null,
): AudioSettings | null {
  const sampleRate = capture.sampleRate ?? contextSampleRate ?? null;
  if (sampleRate === null) return null;
  const ec = capture.echoCancellation;
  return {
    sampleRate,
    ...(ec === undefined ? {} : { echoCancellation: typeof ec === "string" ? ec !== "none" : ec }),
    ...(capture.noiseSuppression === undefined ? {} : { noiseSuppression: capture.noiseSuppression }),
    ...(capture.autoGainControl === undefined ? {} : { autoGainControl: capture.autoGainControl }),
    ...(capture.channelCount === undefined ? {} : { channelCount: capture.channelCount }),
  };
}

/**
 * Acknowledgement of `audio:start`, `audio:chunk` and `audio:stop`. A refusal says whether to send
 * the item again: `retry: false` is permanent (the browser drops the item: recording not allowed
 * now, unknown or closed track, bad payload), `retry: true` is transient (not seated yet after a
 * reconnect, a storage error).
 */
export type AudioAck<T = undefined> =
  | { ok: true; data?: T; duplicate?: boolean }
  | { ok: false; error: string; retry: boolean };

/**
 * What the browser's send queue makes of an audio ack: true = stored (drop it from the queue),
 * "rejected" = refused for good (drop it, counted), false = try again later. A missing or malformed
 * ack (e.g. a timeout) means try again.
 */
export function audioSendResult(ack: unknown): true | false | "rejected" {
  if (!ack || typeof ack !== "object") return false;
  const a = ack as { ok?: unknown; retry?: unknown };
  if (a.ok === true) return true;
  if (a.ok === false) return a.retry === true ? false : "rejected";
  return false;
}

/** Byte length of a binary PCM payload (ArrayBuffer or any view of one: Node Buffer, Uint8Array, Int16Array …); -1 if not binary. */
export function pcmByteLength(v: unknown): number {
  if (ArrayBuffer.isView(v)) return v.byteLength;
  if (v instanceof ArrayBuffer) return v.byteLength;
  return -1;
}

/** Binary PCM (16 kHz mono s16le). The browser sends an ArrayBuffer or a view of one; the server receives a Buffer. */
export const PcmSchema = z
  .custom<ArrayBuffer | ArrayBufferView>((v) => pcmByteLength(v) >= 0, {
    message: "pcm must be binary (an ArrayBuffer or a typed array)",
  })
  // `format: "binary"` makes the generated message catalogue show the type as `binary`
  .meta({ description: "Raw PCM samples: 16 kHz, mono, signed 16-bit little-endian", format: "binary" });

/** Id of a track: a random UUID (crypto.randomUUID()), new for every capture run. */
export const TrackIdSchema = z
  .uuid()
  .describe("Random id of the audio track (one continuous capture run of one seat)");

/** An `audio:chunk` message as the browser sends it (the input of `AudioChunk` in protocol.ts). */
export type AudioChunkInput = z.input<typeof AudioChunk>;

/* ─────────────────────────── REST response types (DATABASE tab) ─────────────────────────── */

const Ts = (d: string) => z.number().describe(`${d} (server clock, Unix epoch ms)`);
const Wall = (d: string) => z.string().describe(`${d} (ISO-8601 UTC)`);
const Count = (d: string) => z.number().int().min(0).describe(d);
const DurMs = (d: string) => z.number().min(0).describe(`${d} (ms)`);

/** Lifecycle of a stored track. */
export const AUDIO_TRACK_STATUSES = ["open", "closed", "interrupted", "deleted"] as const;
export type AudioTrackStatus = (typeof AUDIO_TRACK_STATUSES)[number];

export const AudioTrackSummarySchema = z
  .object({
    trackId: TrackIdSchema,
    seat: SeatSchema,
    startedServerTs: Ts("When the track started"),
    closedServerTs: Ts("When the track was closed").nullable(),
    stopReason: AudioStopReasonSchema.nullable().describe("Why the track stopped (null while open)"),
    samples: Count("Samples stored (16 000 per second)"),
    durationMs: DurMs("Audio stored: samples / 16 000"),
    chunks: Count("Chunks stored"),
    gaps: Count("Missing chunks: sequence numbers or sample ranges never received"),
    bytes: Count("Size of the encrypted file on disk (bytes)"),
    status: z
      .enum(AUDIO_TRACK_STATUSES)
      .describe(
        "'open' = still recording, 'closed' = stopped normally, 'interrupted' = never stopped cleanly (e.g. server restart) and closed on recovery, 'deleted' = the raw audio was deleted (metadata kept)",
      ),
  })
  .describe("One stored track of one seat");
export type AudioTrackSummary = z.infer<typeof AudioTrackSummarySchema>;

/**
 * Kinds of derived results an attribution run stores (raw audio is never modified): per seat
 * `speech_segments` (JSON) and `clean` (a new encrypted file), per session `talk_time`,
 * `quality_report` and `leakage_matrix` (JSON). Only `clean` holds sound.
 */
export const AUDIO_DERIVATIVE_KINDS = [
  "speech_segments",
  "talk_time",
  "quality_report",
  "leakage_matrix",
  "clean",
] as const;
export type AudioDerivativeKind = (typeof AUDIO_DERIVATIVE_KINDS)[number];

export const AudioDerivativeSummarySchema = z
  .object({
    derivativeId: z.string().min(1).describe("Random id of the derived file"),
    seat: SeatSchema,
    kind: z
      .literal("clean")
      .describe(
        "'clean' = the seat's aligned track with frames attributed to other seats attenuated by 30 dB",
      ),
    sourceTrackIds: z.array(TrackIdSchema).describe("Raw tracks it was made from"),
    jobId: z.string().nullable().describe("Attribution job that produced it (null if unknown)"),
    engineVersion: z.string().describe("Version of the attribution engine that produced it"),
    params: z.record(z.string(), z.unknown()).describe("Engine parameters used"),
    createdServerTs: Ts("When it was created"),
    samples: Count("Samples (16 000 per second)"),
    durationMs: DurMs("Length: samples / 16 000"),
    bytes: Count("Size of the encrypted file on disk (bytes)"),
  })
  .describe("One derived audio file of one seat");
export type AudioDerivativeSummary = z.infer<typeof AudioDerivativeSummarySchema>;

const SeatKeyed = <T extends z.ZodType>(v: T) => z.record(z.string().regex(/^\d+$/), v);

export const AttributionSummarySchema = z
  .object({
    engineVersion: z.string().describe("Version of the attribution engine"),
    talkTimeMs: SeatKeyed(z.number().min(0)).describe(
      "Attributed speech per seat, keyed by seat number (ms; overlapping speech counts for each speaker)",
    ),
    segments: Count("Speech segments found (all seats)"),
    overlapMs: DurMs("Time in which two or more seats spoke at once"),
    quality: z
      .object({
        calibrated: z
          .boolean()
          .describe("True if the leakage between microphones was measured in the calibration"),
        speechDetector: z
          .enum(["silero", "energy"])
          .describe(
            "How speech was detected: 'silero' = the Silero VAD model, 'energy' = level above the noise floor (fallback when the model could not run)",
          ),
        perSeat: z
          .array(
            z.object({
              seat: SeatSchema,
              marginDb: z
                .number()
                .nullable()
                .describe(
                  "Calibration margin: how much louder this seat's voice is on its own mic than on the others, gain differences cancelled (dB; headsets ≈ 20–30)",
                ),
              driftPpm: z
                .number()
                .nullable()
                .describe("Estimated sample-clock drift of this seat's device (parts per million)"),
              coverage: z
                .number()
                .min(0)
                .max(1)
                .describe("Share of the recording window covered by this seat's audio (0–1)"),
            }),
          )
          .describe("Quality figures per seat"),
        ambiguousShare: z
          .number()
          .min(0)
          .max(1)
          .describe(
            "Share of speech frames whose loudness comparison was within 3 dB of the decision threshold (0–1)",
          ),
        warnings: z
          .array(z.string())
          .describe("Human-readable warnings, e.g. 'seat 3: own voice only +4 dB over the others'"),
      })
      .describe("Quality report of the attribution"),
  })
  .describe(
    "Result summary of a speaker-attribution run (speech detection and loudness comparison only, never voice identity)",
  );
export type AttributionSummary = z.infer<typeof AttributionSummarySchema>;

export const AUDIO_JOB_KINDS = ["attribution"] as const;
export type AudioJobKind = (typeof AUDIO_JOB_KINDS)[number];
export const AUDIO_JOB_STATUSES = ["queued", "running", "done", "failed"] as const;
export type AudioJobStatus = (typeof AUDIO_JOB_STATUSES)[number];

export const AttributionJobSchema = z
  .object({
    jobId: z.string().min(1).describe("Random id of the job"),
    kind: z.enum(AUDIO_JOB_KINDS).describe("'attribution' = who spoke when, plus cleaned per-seat tracks"),
    status: z.enum(AUDIO_JOB_STATUSES).describe("Job state"),
    progress: z.number().min(0).max(1).describe("Progress (0–1)"),
    startedWall: Wall("When the job started").nullable(),
    finishedWall: Wall("When the job finished or failed").nullable(),
    error: z.string().nullable().describe("Error message (status 'failed' only)"),
    summary: AttributionSummarySchema.optional().describe("Result summary (status 'done' only)"),
  })
  .describe("An audio processing job, triggered from the DATABASE tab");
export type AttributionJob = z.infer<typeof AttributionJobSchema>;

/** What a deletion removed: the raw tracks and every derivative that holds sound, or all audio. */
export const AUDIO_DELETION_SCOPES = ["raw", "all"] as const;
export type AudioDeletionScope = (typeof AUDIO_DELETION_SCOPES)[number];

export const AudioDeletionRecordSchema = z
  .object({
    id: z.number().int().min(1).describe("Register entry number"),
    sessionId: z.string().describe("Session whose audio was deleted"),
    scope: z
      .enum(AUDIO_DELETION_SCOPES)
      .describe(
        "'raw' = raw tracks and cleaned tracks deleted, speech segments and metadata kept; 'all' = every audio row and file",
      ),
    seats: z.array(SeatSchema).describe("Seats whose audio was deleted"),
    tracks: Count("Raw tracks deleted"),
    derivatives: Count("Derived files deleted"),
    bytes: Count("Encrypted bytes deleted from disk"),
    executedWall: Wall("When the deletion ran"),
    note: z
      .string()
      .max(500)
      .describe("Researcher's note, e.g. the retention rule applied (no personal data)"),
  })
  .describe("One entry of the audio deletion register");
export type AudioDeletionRecord = z.infer<typeof AudioDeletionRecordSchema>;

export const AudioSessionSummarySchema = z
  .object({
    sessionId: z.string().describe("Session id"),
    tracks: z.array(AudioTrackSummarySchema).describe("Every stored track, in start order"),
    derivatives: z.array(AudioDerivativeSummarySchema).describe("Every derived file"),
    jobs: z.array(AttributionJobSchema).describe("Processing jobs, newest first"),
    deletions: z.array(AudioDeletionRecordSchema).describe("Audio deletion register of this session"),
  })
  .describe("Everything the DATABASE tab shows about one session's audio");
export type AudioSessionSummary = z.infer<typeof AudioSessionSummarySchema>;

/*
 * The views the server builds around the summaries above (plain types: the server writes them,
 * the DATABASE tab reads them).
 */

/** Overall quality of an attribution run: `good` = no warnings, `fair` = usable with care, `poor` = unreliable. */
export type AttributionGrade = "good" | "fair" | "poor";

/** The attribution summary of a job, plus the overall quality grade of the run. */
export type AttributionSummaryView = AttributionSummary & { grade: AttributionGrade };

/** GET /api/audio/jobs/:jobId */
export type AttributionJobView = Omit<AttributionJob, "summary"> & {
  sessionId: string;
  summary?: AttributionSummaryView;
};

/** Per-seat totals for the DATABASE tab. */
export interface SeatAudioSummary {
  seat: number;
  tracks: number;
  /** Audio stored (sum of the tracks' durations, ms). */
  durationMs: number;
  /** Missing chunks inside tracks. */
  gaps: number;
  /** Breaks between consecutive tracks (a pause, a reload, a reconnect). */
  trackBreaks: number;
  /** First sample to last sample (ms), and the part of it without audio. */
  spanMs: number;
  missingMs: number;
  firstServerTs: number | null;
  lastServerTs: number | null;
  /** True once the seat's raw audio was deleted (metadata kept). */
  rawDeleted: boolean;
}

/** One entry of a session's audio exports (from the export register). */
export interface AudioExportEntry {
  exportId: string;
  createdWall: string;
  audioKind: AudioExportRequestKind | null;
  seats: number[];
  files: number;
  /** Where the WAVs were written; `onDisk` = the folder still exists. */
  path: string;
  onDisk: boolean;
}

/** GET /api/sessions/:id/audio: the shared summary plus per-seat totals. */
export type AudioSessionView = AudioSessionSummary & {
  jobs: AttributionJobView[];
  seats: SeatAudioSummary[];
  /** Summary of the latest finished attribution, or null. */
  attribution: (AttributionSummaryView & { jobId: string | null; createdServerTs: number }) | null;
  audioExports: AudioExportEntry[];
  /** True while the session runs: attribution, export and deletion wait until it has ended. */
  running: boolean;
};

/** One speech segment (stored per seat in the `speech_segments` derivative, and in the CSV). */
export interface SpeechSegmentRow {
  seat: number;
  startTs: number;
  endTs: number;
  durationMs: number;
  round: number | null;
  phase: string | null;
  paused: boolean;
  recordingPaused: boolean;
  meanDb: number;
  confidence: number;
  overlap: boolean;
  overlapMs: number;
  overlapWith: number[];
}

/** GET /api/sessions/:id/audio/segments: who spoke when (timing only, never audio). */
export interface SpeechSegmentsView {
  sessionId: string;
  engineVersion: string | null;
  jobId: string | null;
  segments: SpeechSegmentRow[];
}

export interface AudioExportFile {
  name: string;
  seat: number;
  kind: AudioExportKind;
  samples: number;
  durationMs: number;
  bytes: number;
  sha256: string;
}

/** POST /api/sessions/:id/audio/export */
export interface AudioExportResult {
  exportId: string;
  sessionId: string;
  dir: string;
  files: AudioExportFile[];
  /** `attribution` = the alignment of the latest attribution; `timestamps` = the chunks' timestamps only. */
  timing: "attribution" | "timestamps";
  /** Read problems (damaged or missing records play as silence), also in the manifest. */
  warnings: string[];
}

export interface AudioDeletionCounts {
  /** raw: tracks whose audio was deleted (rows kept as `deleted`); all: track rows deleted. */
  tracks: number;
  /** Recorded duration of those tracks, in ms. */
  audioMs: number;
  /** Chunk rows deleted (raw keeps them: they are timing metadata). */
  chunks: number;
  derivatives: number;
  jobs: number;
  /** Encrypted files whose keys were deleted (and which were then unlinked). */
  files: number;
  /** Their size on disk before the deletion (bytes). */
  bytes: number;
  /** Seats whose audio was deleted, as a bit mask (bit n = seat n), so the register keeps plain numbers. */
  seatMask: number;
}

/** Encrypted audio files unlinked after a deletion was committed. */
export interface AudioFilesRemoved {
  removed: number;
  /**
   * Files that could not be unlinked, as `<sessionId>/<fileName>`. Their keys
   * are gone with the rows, so they are unreadable; delete them by hand.
   */
  failed: string[];
  /**
   * Why compacting the database (checkpoint + VACUUM) after the committed deletion failed: the
   * rows are deleted, but their freed pages may stay in the file until the next compaction.
   */
  compactionError?: string;
}

/** POST /api/sessions/:id/audio/delete */
export interface AudioDeleteResult {
  sessionId: string;
  scope: AudioDeletionScope;
  counts: AudioDeletionCounts;
  /** Files unlinked; `all` also removes the session's audio folder. */
  audioFiles: AudioFilesRemoved & { dirRemoved: boolean };
  record: AudioDeletionRecord;
  /** Audio export folders of the session still on disk (deleting the audio does not touch them). */
  audioExportsOnDisk: string[];
}

/** Rows deleted by an erasure (also the shape of `erasures.rows_json`; older entries lack the audio counts). */
export interface ErasureRows {
  events: number;
  telemetry: number;
  audioTracks: number;
  audioChunks: number;
  audioDerivatives: number;
}

/** Rows deleted with a session (also the shape of `session_deletions.rows_json`; older entries lack audio). */
export interface SessionDeletionRows {
  events: number;
  telemetry: number;
  exports: number;
  audioTracks: number;
  audioChunks: number;
  audioDerivatives: number;
  audioJobs: number;
}

/** POST /api/sessions/:id/delete */
export interface SessionDeletionResult {
  sessionId: string;
  rows: SessionDeletionRows;
  /** Export folders of this session (deleted from disk only when requested). */
  exportPaths: string[];
  exportsDeleted: boolean;
  /**
   * The session's encrypted audio folder (data/audio/<sessionId>), always removed.
   * `error` says why it could not be (its files are unreadable: their keys are gone).
   */
  audio: { dirRemoved: boolean; files: number; error?: string };
}
