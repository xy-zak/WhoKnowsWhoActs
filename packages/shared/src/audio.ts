import { z } from "zod";
import { SeatSchema } from "./labels";

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
 *    recorded (see `shouldRecord` in state.ts); fake players, agents and
 *    simulated sessions never record;
 *  - speaker attribution compares loudness across the seats' microphones and
 *    never identifies a speaker by their voice (no voiceprints: GDPR Art. 9).
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

/* ─────────────────────────── Shared field schemas ─────────────────────────── */

export const Dbfs = (d: string) =>
  z.number().min(AUDIO_SILENCE_DB).max(0).describe(`${d} (dBFS, ${AUDIO_SILENCE_DB}–0; 0 = full scale)`);

/** Why a track (one continuous capture run) started. */
export const AUDIO_START_REASONS = [
  "mic_check",
  "resume",
  "reconnect",
  "reload",
  "permission_regained",
] as const;
export type AudioStartReason = (typeof AUDIO_START_REASONS)[number];
export const AudioStartReasonSchema = z
  .enum(AUDIO_START_REASONS)
  .describe(
    "Why the track started: 'mic_check' = first capture of the seat (its mic check), 'resume' = recording resumed after a facilitator pause, 'reconnect' = the browser reconnected, 'reload' = the page was reloaded, 'permission_regained' = the microphone came back after a permission or device loss",
  );

/** Why a track stopped. */
export const AUDIO_STOP_REASONS = [
  "paused",
  "game_complete",
  "closed",
  "aborted",
  "withdrawn",
  "disconnect",
  "permission_lost",
  "error",
  "client_stop",
] as const;
export type AudioStopReason = (typeof AUDIO_STOP_REASONS)[number];
export const AudioStopReasonSchema = z
  .enum(AUDIO_STOP_REASONS)
  .describe(
    "Why the track stopped: 'paused' = facilitator paused recording, 'game_complete' = the game ended, 'closed' / 'aborted' = the session was closed or aborted, 'withdrawn' = the participant withdrew, 'disconnect' = the browser disconnected, 'permission_lost' = the microphone permission or device went away, 'error' = capture failed, 'client_stop' = the browser stopped the track itself (e.g. page unload)",
  );

/** State of a seat's microphone, as reported by its browser in `audio:level`. */
export const MIC_LEVEL_STATES = ["recording", "no_signal", "denied", "error", "idle", "paused"] as const;
export type MicLevelState = (typeof MIC_LEVEL_STATES)[number];
export const MicLevelStateSchema = z
  .enum(MIC_LEVEL_STATES)
  .describe(
    "Microphone state: 'recording' = capturing with signal, 'no_signal' = capturing but silent for a long time (muted or unplugged mic), 'denied' = permission refused, 'error' = capture failed, 'idle' = not capturing (not yet, or not allowed), 'paused' = recording paused by the facilitator",
  );

/**
 * What is recorded about a microphone: the processing flags the browser actually applied and
 * the capture sample rate (from `MediaStreamTrack.getSettings()`). Unknown keys are stripped, so a
 * deviceId, groupId or label sent by mistake is never stored.
 */
export const AudioSettingsSchema = z
  .object({
    sampleRate: z
      .number()
      .int()
      .min(8000)
      .max(384000)
      .describe(
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

/** Kinds of derived audio files (raw audio is never modified; derivatives are new encrypted files). */
export const AUDIO_DERIVATIVE_KINDS = ["clean"] as const;
export type AudioDerivativeKind = (typeof AUDIO_DERIVATIVE_KINDS)[number];

export const AudioDerivativeSummarySchema = z
  .object({
    derivativeId: z.string().min(1).describe("Random id of the derived file"),
    seat: SeatSchema,
    kind: z
      .enum(AUDIO_DERIVATIVE_KINDS)
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
        perSeat: z
          .array(
            z.object({
              seat: SeatSchema,
              marginDb: z
                .number()
                .nullable()
                .describe("Calibration margin: own voice over the loudest other seat on this mic (dB)"),
              driftPpm: z
                .number()
                .nullable()
                .describe("Estimated sample-clock drift of this seat's device (parts per million)"),
              lagMs: z
                .number()
                .nullable()
                .describe("Median lag of this channel against the common timeline after alignment (ms)"),
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
          .describe("Share of speech frames that could not be attributed to one seat with confidence (0–1)"),
        warnings: z
          .array(z.string())
          .describe("Human-readable warnings, e.g. 'seat 3: own voice only +4 dB over the others'"),
      })
      .describe("Quality report of the attribution"),
  })
  .describe("Result summary of a speaker-attribution run (loudness comparison only, never voice identity)");
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

/** What a deletion removed: raw tracks only (derived files kept), derived files only, or both. */
export const AUDIO_DELETION_SCOPES = ["raw", "derived", "all"] as const;
export type AudioDeletionScope = (typeof AUDIO_DELETION_SCOPES)[number];

export const AudioDeletionRecordSchema = z
  .object({
    id: z.number().int().min(1).describe("Register entry number"),
    sessionId: z.string().describe("Session whose audio was deleted"),
    scope: z
      .enum(AUDIO_DELETION_SCOPES)
      .describe(
        "'raw' = raw tracks deleted, derived files and speech segments kept; 'derived' = derived files deleted; 'all' = both",
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
