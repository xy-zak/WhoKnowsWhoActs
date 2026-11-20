import { z } from "zod";
import {
  AUDIO_BYTES_PER_SAMPLE,
  AUDIO_MAX_CHUNK_SAMPLES,
  type AudioCaptureSettings,
  AudioCaptureSettingsSchema,
  AudioContextInfoSchema,
  type AudioSettings,
  CaptureSampleRate,
  Dbfs,
  PcmSchema,
  pcmByteLength,
  TrackIdSchema,
  toAudioSettings,
} from "./audio";
import { AudioStopReasonSchema, type MicLevelState, MicLevelStateSchema } from "./audioReasons";
import { FakePaceSchema, SessionConfigSchema } from "./config";
import { EVENT_DEFS } from "./events";
import { ActionKindSchema, KLabelSchema, LabelPairingSchema, SeatSchema } from "./labels";
import type { FacilitatorServerToClient, PlayerServerToClient } from "./socket";
import { TelemetryItemSchema } from "./telemetry";

/* ═══════════════════════════════════════════════════════════════════════════
 * SOCKET PROTOCOL (Socket.IO). Two namespaces:
 *   /player       — the 4 player browsers
 *   /facilitator  — the dashboard (localhost-only unless ADMIN_TOKEN is set)
 *
 * Every client→server payload is validated with the zod schema below; the
 * server never trusts a client. Server→client payloads are TypeScript types
 * (see projections.ts) and are documented in docs/NETWORKING.md.
 * ═══════════════════════════════════════════════════════════════════════════ */

const ClientTs = z.number().describe("Client timestamp corrected to server time (epoch ms)");
const DurationMs = z.number().min(0).max(86_400_000).describe("Time the screen was open (ms)");

/* ─────────────────────────── /player : client → server ─────────────────────────── */

export const PlayerHello = z.object({
  terminalKey: z
    .string()
    .regex(/^[0-9a-f]{32}$/)
    .describe("Random per-browser key (localStorage) so a PC keeps its client number across reloads"),
  seatToken: z
    .string()
    .nullable()
    .describe("Reconnect token received when the seat was bound (sessionStorage)"),
});
export const ClockPing = z.object({ t0: z.number().describe("Client send time (performance clock, ms)") });
export const ConsentSubmit = z.object({
  formVersion: z.string(),
  textSha256: z.string().regex(/^[0-9a-f]{64}$/),
  answers: z.record(z.string().regex(/^[a-z0-9_]+$/), z.boolean()),
  durationMs: DurationMs,
  clientTs: ClientTs,
});
export const DemographicsSubmit = z.object({
  formVersion: z.string(),
  answers: z.record(z.string().regex(/^[a-z0-9_]+$/), z.string().max(64)),
  durationMs: DurationMs,
  clientTs: ClientTs,
});
export const BriefingAck = z.object({
  textSha256: z.string().regex(/^[0-9a-f]{64}$/),
  durationMs: DurationMs,
  clientTs: ClientTs,
});
/** The player is ready for the calibration's turns (part 2 of "Mic check & calibration"). */
export const CalibrationReadyMsg = z.object({ clientTs: ClientTs });
export const IntentMsg = z.object({
  clientSeq: z
    .number()
    .int()
    .min(1)
    .describe("Per-seat increasing counter; resends with the same value are ignored"),
  kind: ActionKindSchema,
  regionId: z.string().max(64),
  clientTs: ClientTs,
});
export const TelemetryBatch = z.object({
  clockOffsetMs: z.number().describe("Offset the client applied to its timestamps"),
  items: z.array(TelemetryItemSchema).max(500),
});
export const Presence = z.object({
  regionId: z.string().max(64).nullable().describe("Sub-square currently hovered (null = none)"),
});

/* /player : audio (sessions that record audio; see audio.ts) */

const ClockOffsetMs = z
  .number()
  .describe("Clock offset (server minus client, ms) the client applied to its timestamps");
const Count = (d: string) => z.number().int().min(0).describe(d);

const NO_SAMPLE_RATE = {
  message: "settings.sampleRate (or the audio engine's sample rate) is needed",
  path: ["settings", "sampleRate"],
};

/** The message with its settings normalised to AudioSettings, or a NO_SAMPLE_RATE issue. */
function withSettings<T extends { settings: AudioCaptureSettings }>(
  m: T,
  sampleRate: number | undefined,
  ctx: z.RefinementCtx,
): Omit<T, "settings"> & { settings: AudioSettings } {
  const settings = toAudioSettings(m.settings, sampleRate);
  if (settings === null) {
    ctx.addIssue({ code: "custom", ...NO_SAMPLE_RATE });
    return z.NEVER;
  }
  return { ...m, settings };
}
const ContextSampleRate = CaptureSampleRate.optional().describe(
  "Rate of the browser's audio engine (Hz): used as the sample rate when settings has none",
);

/**
 * Result of the player's own mic check (logged as MicCheckCompleted). The settings are taken as the
 * browser reports them and normalised to AudioSettings (see toAudioSettings).
 */
export const MicCheckSubmit = EVENT_DEFS.MicCheckCompleted.payload
  .extend({
    settings: AudioCaptureSettingsSchema,
    contextSampleRate: ContextSampleRate,
    durationMs: DurationMs,
    clientTs: ClientTs,
  })
  .transform(({ contextSampleRate, ...m }, ctx) => withSettings(m, contextSampleRate, ctx));

/** A mic check result as the server takes it (settings normalised). */
export type MicCheckResult = z.output<typeof MicCheckSubmit>;

/**
 * A new track (logged as AudioTrackStarted), plus the timing of its first sample. Accepts the
 * capture engine's start info as it is: the timing fields `context`, `chunkSamples` and
 * `inputLatencyMs` are optional, the settings are normalised to AudioSettings, unknown keys are
 * stripped.
 */
export const AudioStart = EVENT_DEFS.AudioTrackStarted.payload
  // pick, not extend: keeps the field order, so a refusal names the same first issue
  .pick({ trackId: true, reason: true, sampleRate: true })
  .extend({
    chunkSamples: z
      .number()
      .int()
      .min(1)
      .max(AUDIO_MAX_CHUNK_SAMPLES)
      .optional()
      .describe("Samples in a full chunk (nominally 80 000 = 5 s); the last chunk of a track may be shorter"),
    clientTs: ClientTs.describe("Time of the track's first sample, corrected to server time (epoch ms)"),
    clockOffsetMs: ClockOffsetMs,
    inputLatencyMs: z
      .number()
      .min(0)
      .max(10_000)
      .optional()
      .describe("Capture latency the browser already subtracted from every clientTs (ms)"),
    settings: AudioCaptureSettingsSchema,
    context: AudioContextInfoSchema.optional(),
  })
  .transform((m, ctx) => withSettings(m, m.context?.sampleRate, ctx));

export const AudioChunk = z
  .object({
    trackId: TrackIdSchema,
    seq: Count("Chunk number within the track (0, 1, 2, …); a resend repeats it"),
    startSample: Count("Index of the chunk's first sample within the track (0-based)"),
    sampleCount: z
      .number()
      .int()
      .min(1)
      .max(AUDIO_MAX_CHUNK_SAMPLES)
      .describe(`Samples in this chunk (nominally 80 000 = 5 s; at most ${AUDIO_MAX_CHUNK_SAMPLES})`),
    clientTs: ClientTs.describe("Time of the chunk's first sample, corrected to server time (epoch ms)"),
    clockOffsetMs: ClockOffsetMs,
    rmsDb: Dbfs("RMS level of the chunk"),
    peakDb: Dbfs("Peak level of the chunk"),
    clippedSamples: Count("Samples at full scale (clipping)"),
    pcm: PcmSchema,
  })
  .refine((c) => pcmByteLength(c.pcm) === c.sampleCount * AUDIO_BYTES_PER_SAMPLE, {
    message: "pcm must hold exactly sampleCount × 2 bytes",
    path: ["pcm"],
  })
  .refine((c) => c.clippedSamples <= c.sampleCount, {
    message: "clippedSamples cannot exceed sampleCount",
    path: ["clippedSamples"],
  });

export const AudioStop = z.object({
  trackId: TrackIdSchema,
  reason: AudioStopReasonSchema,
  chunks: Count("Chunks the browser produced in this track (seq 0 … chunks − 1)"),
  samples: Count("Samples the browser captured in this track (16 000 per second)"),
  droppedChunks: Count(
    "Chunks the browser had to drop (resend queue full); their audio is missing (absent = 0)",
  ).default(0),
  clientTs: ClientTs.describe("End of the track's last sample, corrected to server time (epoch ms)"),
  clockOffsetMs: ClockOffsetMs.optional(),
});

export const AudioLevel = z.object({
  state: MicLevelStateSchema,
  rmsDb: Dbfs("RMS level over the last ~250 ms"),
  peakDb: Dbfs("Peak level over the last ~250 ms"),
  pendingChunks: Count("Chunks captured but not yet acknowledged by the server"),
  pendingBytes: Count("Bytes of those chunks (held in memory only)"),
});

/* ─────────────────────────── /facilitator : client → server ─────────────────────────── */

export const SessionCreate = z.object({
  scenarioId: z.string(),
  config: SessionConfigSchema,
  notes: z.string().max(1000).default(""),
});
export const SessionResume = z.object({ sessionId: z.string() });
export const SeatBind = z.object({ terminal: z.number().int().min(1), seat: SeatSchema });

export const FakeAdd = z.object({
  seats: z
    .array(SeatSchema)
    .nullable()
    .default(null)
    .describe("Seats to give a fake player; null = every seat that is still unbound"),
  pace: FakePaceSchema.default("normal"),
});
export const SeatUnbind = z.object({ seat: SeatSchema, reason: z.string().max(200).default("facilitator") });
const PairingIn = LabelPairingSchema.default({ mode: "aligned", id: null }).describe(
  "Pairing to use; dissociated with id null = random D1–D6 (seed logged)",
);
/** K per seat + pairing; the server derives each P from the pairing (P is never chosen freely). */
export const LabelsSet = z.object({
  assignments: z.array(z.object({ seat: SeatSchema, k: KLabelSchema, view: z.string().optional() })),
  pairing: PairingIn,
});
export const LabelsRandomise = z.object({
  pairing: PairingIn,
  shuffleK: z
    .boolean()
    .default(true)
    .describe("Shuffle which seat gets which K (otherwise seat order: seat 1 = Ka …)"),
});
export const ActionRevoke = z.object({
  seq: z.number().int().min(1),
  reason: z.string().max(200).default(""),
});
export const BroadcastMsg = z.object({ text: z.string().min(1).max(300) });
export const NoteMsg = z.object({ text: z.string().min(1).max(500) });
export const WithdrawMsg = z.object({ seat: SeatSchema });
export const AbortMsg = z.object({ reason: z.string().max(200).default("") });
export const Empty = z.object({}).passthrough();

/* /facilitator : audio */
const FacilitatorReason = z
  .string()
  .max(200)
  .default("")
  .describe("Facilitator's reason (free text, no personal data)");
export const CalibrationSkip = z.object({ reason: FacilitatorReason });
export const MicSkip = z.object({ seat: SeatSchema, reason: FacilitatorReason });
export const RecordingPause = z.object({
  reason: z.string().max(200).optional().describe("Facilitator's reason (free text, no personal data)"),
});

export type Ack<T = unknown> = { ok: true; data?: T } | { ok: false; error: string };

/* ─────────────────────────── Schema of every client→server message ─────────────────────────── */

/**
 * The ONE place that says which schema validates which message. The server's handlers look the
 * schema up here by message name (so a handler cannot use the wrong one), the typed Socket.IO
 * event maps (socket.ts) derive the payload types from it, and MESSAGES below must document
 * exactly these names.
 */
export const PLAYER_SCHEMAS = {
  hello: PlayerHello,
  "clock:ping": ClockPing,
  "consent:submit": ConsentSubmit,
  "demographics:submit": DemographicsSubmit,
  "mic:check": MicCheckSubmit,
  "briefing:ack": BriefingAck,
  "calibration:ready": CalibrationReadyMsg,
  intent: IntentMsg,
  telemetry: TelemetryBatch,
  presence: Presence,
  "audio:start": AudioStart,
  "audio:chunk": AudioChunk,
  "audio:stop": AudioStop,
  "audio:level": AudioLevel,
} as const;

export const FACILITATOR_SCHEMAS = {
  "session:create": SessionCreate,
  "session:resume": SessionResume,
  "seat:bind": SeatBind,
  "fake:add": FakeAdd,
  "seat:unbind": SeatUnbind,
  "labels:set": LabelsSet,
  "labels:randomise": LabelsRandomise,
  "onboarding:start": Empty,
  "simulation:start": Empty,
  "calibration:start": Empty,
  "calibration:redo": Empty,
  "calibration:skip": CalibrationSkip,
  "mic:skip": MicSkip,
  "recording:pause": RecordingPause,
  "recording:resume": Empty,
  "round:start": Empty,
  "round:end": Empty,
  "game:pause": Empty,
  "game:resume": Empty,
  "action:revoke": ActionRevoke,
  broadcast: BroadcastMsg,
  note: NoteMsg,
  "participant:withdraw": WithdrawMsg,
  "game:end": Empty,
  "session:close": Empty,
  "session:abort": AbortMsg,
} as const;

/* ─────────────────────────── Catalogue (drives docs/NETWORKING.md) ─────────────────────────── */

export type InboundDoc = { description: string; ack?: string; logged: string };
/** `schema`: the TypeScript type of the payload. */
export type OutboundDoc = { description: string; schema: string; logged: string };

/**
 * Every message of the socket protocol, documented by namespace and direction. The type makes the
 * catalogue complete: a message added to a schema table or an event map (socket.ts) without an entry
 * here, an entry for a message that does not exist, or one in the wrong namespace or direction, fails
 * to compile. A client→server message is documented with the schema of its table (PLAYER_SCHEMAS or
 * FACILITATOR_SCHEMAS), the one the server validates with.
 */
export const MESSAGES: {
  "/player": {
    "client→server": Record<keyof typeof PLAYER_SCHEMAS, InboundDoc>;
    "server→client": Record<keyof PlayerServerToClient, OutboundDoc>;
  };
  "/facilitator": {
    "client→server": Record<keyof typeof FACILITATOR_SCHEMAS, InboundDoc>;
    "server→client": Record<keyof FacilitatorServerToClient, OutboundDoc>;
  };
} = {
  "/player": {
    "client→server": {
      hello: {
        description:
          "First message after connecting. Identifies the browser (client) and, if present, re-claims a seat.",
        ack: "{ terminal: number, seat: number | null }",
        logged: "PlayerConnected (only if the seat token is valid)",
      },
      "clock:ping": {
        description: "Clock synchronisation sample (NTP-style). Sent 5× on connect and every 60 s.",
        ack: "{ t0: number, serverTs: number }",
        logged: "Result stored by the client as telemetry 'clock_sync'",
      },
      "consent:submit": {
        description: "Answers of the consent form.",
        ack: "Ack",
        logged: "ConsentRecorded",
      },
      "demographics:submit": {
        description: "Answers of the demographics questionnaire.",
        ack: "Ack",
        logged: "DemographicsSubmitted",
      },
      "mic:check": {
        description:
          "Result of the player's own mic check (sessions that record audio; the last onboarding step, part 1 of 'Mic check & calibration'). Refused while PlayerView.audio.micCheckHeld (a seat has not finished the briefing yet). Only processing flags and the sample rate are sent, never the device name or id.",
        ack: "Ack",
        logged: "MicCheckCompleted",
      },
      "briefing:ack": {
        description: "Player confirms having read the briefing.",
        ack: "Ack",
        logged: "BriefingAcknowledged",
      },
      "calibration:ready": {
        description:
          "The player is ready for the calibration (part 2 of 'Mic check & calibration'; only while PlayerView.audio.calibration.canSayReady). Once every recorded seat is ready, the server starts the turns.",
        ack: "Ack",
        logged: "CalibrationReady, then CalibrationStarted when it was the last seat",
      },
      intent: {
        description: "Request to propose or decide a region. Validated by the rules engine.",
        ack: "{ ok: true, seq } | { ok: false, reason, detail }",
        logged: "ProposalMade / DecisionMade, or IntentRejected",
      },
      telemetry: {
        description: "Batch of UI telemetry items (every 2 s or 20 items).",
        ack: "{ stored: number }",
        logged: "telemetry table (one row per valid item)",
      },
      presence: {
        description: "Volatile 'currently hovering' signal for the facilitator's live mirrors.",
        logged:
          "Not stored (ephemeral). The persisted record is telemetry 'region_hover'. Dropped, like telemetry, before consent, after a withdrawal and once the session ended.",
      },
      "audio:start": {
        description:
          "A new audio track starts (one continuous capture run). Accepted only while the seat should record (PlayerView.audio.record: audio consent given, every seat done with consent, mic check reached and not skipped, recording not paused, game not complete, not a fake player or agent). A refused start is permanent (retry false): the browser drops the track's chunks too.",
        ack: "AudioAck (ok, or refused with retry true = send again later / false = drop)",
        logged: "AudioTrackStarted (the track is opened in the encrypted audio store)",
      },
      "audio:chunk": {
        description:
          "About 5 s of audio of an open track (16 kHz mono s16le, binary). The browser keeps unacknowledged chunks in memory only and resends them in order after a reconnect; a resend with the same trackId and seq is stored once (ack ok, duplicate true). Late chunks of a closed track (the server closes it on a disconnect, restart, recording pause or at game complete) are accepted for 35 minutes after the close or the previous late chunk; audio captured while recording was paused or after the game was complete is never stored (a chunk that starts before such a moment is cut there, one that starts after it is refused).",
        ack: "AudioAck<{ trackId, seq }>",
        logged: "Encrypted audio store only (audio_chunks + the track's .wka file), never the event log",
      },
      "audio:stop": {
        description:
          "The browser stopped capturing a track (pause, game complete, unload, permission lost, error). Always accepted for the seat's own tracks, also after the server closed the track itself.",
        ack: "AudioAck",
        logged: "AudioTrackStopped",
      },
      "audio:level": {
        description:
          "Volatile microphone meter reading (about 4 Hz) for the facilitator's LIVE mic column; dropped when the network is busy.",
        logged: "Not stored (ephemeral).",
      },
    },
    "server→client": {
      terminal: {
        description: "Client number assigned to this browser (shown in large type while unassigned).",
        schema: "{ terminal: number }",
        logged: "—",
      },
      bound: {
        description: "This browser was bound to a seat; carries the reconnect token.",
        schema: "{ seat: number, sessionId: string, seatToken: string }",
        logged: "— (SeatBound is logged when the facilitator binds)",
      },
      unbound: {
        description:
          "The seat binding was removed (the facilitator unbound it, or it was opened in another window); the client forgets its seat token and returns to the waiting screen.",
        schema: "{ reason: string }",
        logged: "—",
      },
      detached: {
        description:
          "The session was detached on the server (another session was resumed or created, it was reloaded after an erasure, or it was deleted). The client KEEPS its seat token and waits; when the session is attached again, `rehello` re-claims the seat.",
        schema: "{ reason: string }",
        logged: "—",
      },
      rehello: {
        description:
          "A session was (re)attached on the server; the client re-sends `hello` with its stored seat token so its seat is re-claimed.",
        schema: "{}",
        logged: "—",
      },
      state: {
        description:
          "Full projected state for this player (PlayerView): phase, round, own labels and quotas, the grid (board size, knowledge-type names), the scores of the OWN knowledge type only, the map score, which knowledge type the player acts on, and the marks (proposals and decisions).",
        schema: "PlayerView",
        logged: "Client acknowledges with telemetry 'state_received'",
      },
    },
  },
  "/facilitator": {
    "client→server": {
      "session:create": {
        description:
          "Create a new session from a scenario and config. With players = 'simulated' it goes into the simulation database and every seat gets an agent.",
        ack: "Ack<{ sessionId }>",
        logged: "SessionCreated [+ AgentBound per seat when simulated]",
      },
      "session:resume": {
        description: "Re-open an unfinished session (e.g. after a server restart).",
        ack: "Ack",
        logged: "—",
      },
      "seat:bind": {
        description:
          "Bind a connected client to a seat; generates the participant code (real sessions only: simulated seats are taken by agents).",
        ack: "Ack<{ participantCode }>",
        logged: "SeatBound, PlayerConnected",
      },
      "fake:add": {
        description:
          "Real sessions, lobby only: the server starts fake players (test clients that connect over the network like a browser) and binds them to the given seats. They skip onboarding, get no participant code and propose/decide at random.",
        ack: "Ack<{ seats }>",
        logged: "SeatBound (fake = true), PlayerConnected",
      },
      "seat:unbind": {
        description: "Remove a seat binding (lobby only).",
        ack: "Ack",
        logged: "SeatUnbound",
      },
      "labels:set": {
        description:
          "Set the K label of every seat (and view when viewAssignment = manual) plus the K–P pairing (aligned or dissociated D1–D6); the server derives each P.",
        ack: "Ack",
        logged: "LabelsAssigned (method = manual)",
      },
      "labels:randomise": {
        description:
          "Shuffle which seat gets which K (optional) and apply a pairing; dissociated without a number picks D1–D6 at random.",
        ack: "Ack",
        logged: "LabelsAssigned (method = random, with seed)",
      },
      "onboarding:start": {
        description: "Lock seats and send players to consent / demographics / briefing.",
        ack: "Ack",
        logged: "OnboardingStarted",
      },
      "simulation:start": {
        description:
          "Simulated sessions only: start the game with the agents (no onboarding) and begin round 1; the agents then play by their policies.",
        ack: "Ack",
        logged: "OnboardingStarted (no steps), RoundStarted",
      },
      "calibration:start": {
        description:
          "Sessions that record audio: start the calibration once every seat is through its onboarding and every recorded seat has said it is ready (the server also starts it by itself then). The server times the turns (each seat reads a sentence aloud while the others stay quiet) and runs a quick quality check.",
        ack: "Ack",
        logged:
          "CalibrationStarted, then CalibrationTurn per seat, CalibrationCompleted and CalibrationChecked",
      },
      "calibration:redo": {
        description:
          "Run the calibration again (e.g. after a seat moved closer to its microphone): ends a running one, then asks every recorded seat again to say it is ready; the turns start once all are.",
        ack: "Ack",
        logged: "CalibrationRequested (it ends a running run); then as calibration:start",
      },
      "calibration:skip": {
        description:
          "Skip (or cancel) the calibration, after confirmation; round 1 may then start without it.",
        ack: "Ack",
        logged: "CalibrationSkipped",
      },
      "mic:skip": {
        description:
          "Skip a seat's mic check (e.g. no working microphone): the player continues onboarding and the seat is not recorded.",
        ack: "Ack",
        logged: "MicCheckSkipped",
      },
      "recording:pause": {
        description:
          "Pause audio recording for every seat, after confirmation (players cannot mute themselves). The game goes on.",
        ack: "Ack",
        logged: "RecordingPaused (+ AudioTrackStopped per recording seat)",
      },
      "recording:resume": {
        description: "Resume audio recording; every recorded seat starts a new track.",
        ack: "Ack",
        logged: "RecordingResumed (+ AudioTrackStarted per recording seat)",
      },
      "round:start": {
        description: "Start the next round.",
        ack: "Ack",
        logged: "RoundStarted",
      },
      "round:end": {
        description: "Force-end the current round.",
        ack: "Ack",
        logged: "RoundCompleted (reason = facilitator) [+ GameCompleted after the last round]",
      },
      "game:pause": {
        description: "Pause the active round.",
        ack: "Ack",
        logged: "GamePaused",
      },
      "game:resume": {
        description: "Resume after a pause.",
        ack: "Ack",
        logged: "GameResumed",
      },
      "action:revoke": {
        description: "Undo a proposal/decision of the current round.",
        ack: "Ack",
        logged: "ActionRevoked",
      },
      broadcast: {
        description: "Show a message on every player's screen.",
        ack: "Ack",
        logged: "FacilitatorBroadcast",
      },
      note: {
        description: "Add a facilitator annotation to the log.",
        ack: "Ack",
        logged: "SessionNote",
      },
      "participant:withdraw": {
        description: "Mark a participant as withdrawn during the session.",
        ack: "Ack",
        logged: "ParticipantWithdrawn",
      },
      "game:end": {
        description: "End the game early.",
        ack: "Ack",
        logged: "[RoundCompleted] + GameCompleted (reason = facilitator)",
      },
      "session:close": {
        description: "Archive the session; players return to the waiting screen.",
        ack: "Ack",
        logged: "SessionClosed",
      },
      "session:abort": {
        description: "Abandon the session (data kept, marked aborted).",
        ack: "Ack",
        logged: "SessionAborted",
      },
    },
    "server→client": {
      dashboard: {
        description:
          "Full session state (all seats incl. participant codes), connected clients and live per-seat statistics.",
        schema: "DashboardMsg",
        logged: "—",
      },
      scenario: {
        description:
          "The loaded scenario with ALL views (for the composite map). Sent when a session is loaded.",
        schema: "Scenario | null",
        logged: "—",
      },
      events: {
        description:
          "New events for the live log (demographic answers redacted). The backlog is sent on connect.",
        schema: "{ events: StoredEvent[], reset: boolean }",
        logged: "—",
      },
      "telemetry:live": {
        description: "Newly stored telemetry rows (chatty types such as state_received are omitted).",
        schema: "{ items: StoredTelemetry[], reset: boolean }",
        logged: "—",
      },
      "presence:live": {
        description:
          "Relayed hover presence of a seat for the live mirrors; null when the seat withdraws, is unbound or disconnects.",
        schema: "{ seat: number, regionId: string | null }",
        logged: "—",
      },
    },
  },
};

/* ─────────────────────────── Server → facilitator payload types ─────────────────────────── */

export interface TerminalInfo {
  terminal: number;
  connected: boolean;
  seat: number | null;
  /** A fake player the server created (not a person's browser). */
  fake: boolean;
}

export interface SeatLiveStats {
  seat: number;
  focused: boolean | null;
  visible: boolean | null;
  idle: boolean;
  rttMs: number | null;
  offsetMs: number | null;
  hoverRegionId: string | null;
  screen: string | null;
  telemetryCount: number;
  lastTelemetryTs: number | null;
  /** Microphone of the seat (sessions that record audio; absent otherwise). */
  mic?: SeatMicStats;
}

/** Live microphone figures of one seat, for the facilitator's LIVE mic column (never stored). */
export interface SeatMicStats {
  /** Latest state reported by the browser (`audio:level`). */
  state: MicLevelState;
  /** Latest meter reading (dBFS). */
  rmsDb: number;
  peakDb: number;
  /** When the server last stored a chunk of this seat (server clock; null = none yet). */
  lastChunkServerTs: number | null;
  /** Chunks the browser still holds unacknowledged (upload backlog). */
  pendingChunks: number;
  /** Tracks stored for this seat so far. */
  tracks: number;
  /** Audio stored for this seat so far (ms). */
  recordedMs: number;
}

export interface DashboardMsg {
  state: import("./state").ReadonlyGameState | null;
  serverTs: number;
  terminals: TerminalInfo[];
  stats: Record<number, SeatLiveStats>;
  /** True when the dashboard is attached to a session that can still change. */
  live: boolean;
}

/* ─────────────────────────── REST: GET /api/server-info ─────────────────────────── */

/** How the server speaks HTTPS: its self-signed certificate, TLS_CERT + TLS_KEY, or not at all. */
export type TlsMode = "auto" | "provided" | "off";

/** What GET /api/server-info reports under `tls`. */
export interface TlsInfo {
  enabled: boolean;
  mode: TlsMode;
  /** SHA-256 fingerprint of the certificate, as browsers show it (`AB:CD:…`, 32 pairs). */
  fingerprintSha256: string | null;
  /** Names the certificate is valid for, e.g. `DNS:localhost`, `IP:192.168.1.10`. */
  sans: string[];
  /** Expiry of the certificate (ISO 8601). */
  expires: string | null;
}

/** GET /api/server-info */
export interface ServerInfo {
  /** One URL per LAN interface (or the configured HOST), with the right scheme. */
  playerUrls: Array<{ url: string; iface: string }>;
  /**
   * The plain-HTTP welcome page (LANDING_PORT), one URL per LAN interface: what participants open
   * first. Empty when the landing page is off.
   */
  landingUrls: Array<{ url: string; iface: string }>;
  port: number;
  tls: TlsInfo;
}

/** GET /api/scenarios: one entry per scenario folder; one that fails to load has `error` set. */
export interface ScenarioInfo {
  id: string;
  title: string;
  version: string;
  description: string;
  /** Board size in squares. */
  board: { cols: number; rows: number } | null;
  /** Number of sub-squares (4 per square). */
  regionCount: number;
  viewIds: string[];
  error?: string;
}

/**
 * GET /api/landing: what the welcome page shows. Served over plain HTTP before anyone accepted the
 * certificate, so it says only whether a session takes players now: no session id, no names.
 */
export interface LandingStatus {
  /** A session with real participants is open (lobby to the last round): show "Join live session". */
  live: boolean;
  /** Where the button goes: the game page (HTTPS) on the address the browser used. */
  joinUrl: string;
  /** "self-signed": the next page shows the browser's certificate warning once. */
  certificate: "self-signed" | "own" | "none";
  /** SHA-256 fingerprint of the certificate, to compare with the browser's (null without HTTPS). */
  fingerprintSha256: string | null;
}

/** Phases in which a session with real participants takes players at the game page. */
export const JOINABLE_PHASES: ReadonlySet<string> = new Set([
  "lobby",
  "onboarding",
  "round_active",
  "round_complete",
]);
