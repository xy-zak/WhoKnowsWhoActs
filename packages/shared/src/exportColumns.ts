import { AUDIO_START_REASONS_DOC, AUDIO_STOP_REASONS_DOC, INTERRUPTED_STOP_REASONS } from "./audioReasons";
import type { DataClass } from "./meta";

/* ═══════════════════════════════════════════════════════════════════════════
 * EXPORT FILES — the contract between the server's exporter and the
 * researcher's analysis scripts. Every file written to
 *   exports/<sessionId>/<exportId>/          (standard, pseudonymised)
 *   exports/<sessionId>/anon-<id>/           (anonymised)
 * is described here, column by column. docs/DATA-TYPES.md and each export's
 * codebook.md are generated from this list — change it here first.
 *
 * Conventions for every CSV:
 *  - UTF-8, comma-separated, RFC 4180 quoting, header row, `\n` line ends.
 *  - Empty cell = null / not applicable.
 *  - Booleans are 0/1. Timestamps: `*_ts` = Unix epoch ms (may have decimals),
 *    `*_wall` = ISO-8601 UTC string.
 *  - Seat lists are space-separated seat numbers, e.g. "1 3".
 *  - In anonymised exports the `participant_code` column holds a random
 *    `A-XXXXXX` id instead (consistent within that export only).
 * ═══════════════════════════════════════════════════════════════════════════ */

export type ExportColumnType =
  | "string"
  | "integer"
  | "number"
  | "bool01"
  | "epoch-ms"
  | "iso-datetime"
  | "seat-list"
  | "json";

export interface ExportColumn {
  name: string;
  type: ExportColumnType;
  description: string;
  /** Where the value comes from (event field, derivation rule, …). */
  source: string;
}

/** Columns generated from the study config (one per consent item / demographic question). */
export interface DynamicColumns {
  /** e.g. `answer_<itemId>` — `<id>` is replaced by each id. */
  pattern: string;
  type: ExportColumnType;
  description: string;
  source: string;
  /** Which config list provides the ids. */
  idsFrom: "consentItems" | "demographicQuestions";
}

export interface ExportFileDef {
  file: string;
  format: "csv" | "json" | "md";
  /** What one row (CSV) or the document (JSON/MD) represents. */
  rowUnit: string;
  description: string;
  dataClass: DataClass;
  columns: ExportColumn[];
  dynamicColumns?: DynamicColumns;
}

function col(name: string, type: ExportColumnType, description: string, source: string): ExportColumn {
  return { name, type, description, source };
}

const SESSION_ID: ExportColumn = col(
  "session_id",
  "string",
  "Session id, e.g. S-20261116-7KQ2",
  "envelope.sessionId",
);
const SEAT: ExportColumn = col("seat", "integer", "Seat number (1–4)", "envelope.seat / SeatBound.seat");
const CODE: ExportColumn = col(
  "participant_code",
  "string",
  "Pseudonymous participant code (anonymised export: random A-XXXXXX id)",
  "envelope.participantCode",
);

export const EXPORT_FILES: ExportFileDef[] = [
  {
    file: "session.json",
    format: "json",
    rowUnit: "one document per export",
    description: "Session metadata: configuration, scenario, software version and a per-round summary.",
    dataClass: "non-personal",
    columns: [
      col("exportId", "string", "Id of this export", "generated at export time"),
      col("kind", "string", "'standard' (pseudonymised) or 'anonymised'", "export request"),
      col("exportedWall", "iso-datetime", "When the export was made", "server clock"),
      col("sessionId", "string", "Session id", "sessions.id"),
      col("status", "string", "Session phase at export time", "reduced state.phase"),
      col("createdWall", "iso-datetime", "Session creation time", "SessionCreated"),
      col("scenario", "json", "{ id, title, version, hash } of the scenario used", "SessionCreated.scenario"),
      col("config", "json", "Full effective session configuration", "SessionCreated.config"),
      col(
        "tags",
        "json",
        'Session tags (list of strings), e.g. ["pilot", "condition-A"]',
        "SessionCreated.config.tags",
      ),
      col("notes", "string", "Researcher notes at creation", "SessionCreated.notes"),
      col("harness", "json", "{ version, gitCommit } of the harness software", "SessionCreated.harness"),
      col(
        "rounds",
        "json",
        "[{ round, startedWall, endedWall, reason, durationMs, pausedMs }] per played round",
        "RoundStarted + RoundCompleted",
      ),
      col(
        "labelPairing",
        "json",
        "{ mode, id, name, pairs } of the final label assignment: aligned, or fully dissociated D1–D6 (see the pairing table), e.g. { mode: 'dissociated', id: 6, name: 'D6', pairs: 'Ka–Pd Kb–Pc Kc–Pa Kd–Pb' }",
        "last LabelsAssigned.pairing",
      ),
      col(
        "fakeSeats",
        "json",
        "Seats played by fake players (test clients the server created, not participants), e.g. [1, 3]; [] when every seat was a participant or an agent",
        "SeatBound.fake",
      ),
      col("counts", "json", "{ events, telemetry, actions, players } row counts in this export", "computed"),
    ],
  },
  {
    file: "players.csv",
    format: "csv",
    rowUnit: "one row per seat that was bound at the end of the session",
    description:
      "Who sat where, with which labels, and their onboarding status; which seats were fake players; which agent policy played each seat in a simulated session.",
    dataClass: "pseudonymous",
    columns: [
      SESSION_ID,
      SEAT,
      CODE,
      col(
        "terminal",
        "integer",
        "Client number of the browser bound to the seat (column name kept as terminal)",
        "SeatBound.terminal",
      ),
      col("k_label", "string", "Knowledge type (Ka–Kd)", "last LabelsAssigned"),
      col("p_label", "string", "Power type (Pa–Pd)", "last LabelsAssigned"),
      col("view", "string", "Map view id shown to the seat", "last LabelsAssigned"),
      col(
        "consent_status",
        "string",
        "pending | given | declined | skipped",
        "ConsentRecorded (skipped if consent step disabled)",
      ),
      col("consent_version", "string", "Consent form version answered", "ConsentRecorded.formVersion"),
      col(
        "demographics_submitted",
        "bool01",
        "1 if the questionnaire was submitted",
        "DemographicsSubmitted",
      ),
      col("briefing_acknowledged", "bool01", "1 if the briefing was confirmed", "BriefingAcknowledged"),
      col("withdrawn", "bool01", "1 if the participant withdrew", "ParticipantWithdrawn"),
      col("reconnects", "integer", "Number of reconnections during the session", "PlayerConnected.reconnect"),
      col("rejections", "integer", "Number of rejected propose/decide attempts", "IntentRejected"),
      col(
        "pairing",
        "string",
        "K–P pairing in force at the end: 'aligned' or 'D1'…'D6' (fully dissociated, see the pairing table)",
        "last LabelsAssigned.pairing",
      ),
      col(
        "agent_policy",
        "string",
        "Simulated sessions: id of the agent policy that played the seat (version, parameters and seed are in AgentBound). Empty for real participants",
        "AgentBound.policy",
      ),
      col(
        "fake_player",
        "bool01",
        "1 if the seat was played by a fake player: a test client the server created (not a participant; no code, no onboarding). Leave these rows out of analyses of participants",
        "SeatBound.fake",
      ),
    ],
  },
  {
    file: "actions.csv",
    format: "csv",
    rowUnit: "one row per ProposalMade / DecisionMade event (revoked ones included, flagged)",
    description: "Analysis-ready table of every map interaction with labels, timings and context.",
    dataClass: "pseudonymous",
    columns: [
      SESSION_ID,
      col("seq", "integer", "Event seq of the action", "envelope.seq"),
      col("round", "integer", "Round number", "envelope.round"),
      SEAT,
      CODE,
      col("k_label", "string", "Knowledge type of the seat at action time", "state"),
      col("p_label", "string", "Power type of the seat at action time", "state"),
      col("view", "string", "View of the seat at action time", "state"),
      col("kind", "string", "propose | decide", "event type"),
      col(
        "region_id",
        "string",
        "Target sub-square id, e.g. C7-Kb (square C7, knowledge type Kb)",
        "payload.regionId",
      ),
      col("region_name", "string", "Target sub-square name, e.g. 'C7 · Kb'", "scenario regions"),
      col("square_id", "string", "Square of the target sub-square, e.g. C7", "payload.regionId"),
      col("target_k", "string", "Knowledge type of the target sub-square (Ka–Kd)", "payload.regionId"),
      col("server_ts", "epoch-ms", "Server time the action was accepted", "envelope"),
      col("server_wall", "iso-datetime", "Same as server_ts, human-readable", "envelope"),
      col(
        "client_ts",
        "epoch-ms",
        "Client time of the confirm click, corrected to server time",
        "envelope.clientTs",
      ),
      col("client_seq", "integer", "Client intent counter", "envelope.clientSeq"),
      col(
        "ms_since_round_start",
        "number",
        "Active (un-paused) server ms since the round started",
        "payload.msSinceRoundStart",
      ),
      col(
        "ms_since_prev_own_action",
        "number",
        "Server ms since this seat's previous action in the same round (empty for the first)",
        "derived from server_ts",
      ),
      col(
        "reaction_ms",
        "number",
        "server_ts minus clientTs of this seat's latest state_received telemetry before the action (time from seeing the latest state to acting); empty if none",
        "derived: telemetry state_received",
      ),
      col(
        "quota_used",
        "integer",
        "Actions of this kind used by the seat this round, incl. this one",
        "payload.quotaUsed",
      ),
      col(
        "quota_limit",
        "integer",
        "Quota for this kind this round (empty = unlimited)",
        "payload.quotaLimit",
      ),
      col(
        "prior_proposals",
        "seat-list",
        "Seats that had proposed this sub-square earlier this round",
        "payload.priorProposals",
      ),
      col(
        "prior_decisions",
        "seat-list",
        "Seats that had decided this sub-square earlier this round",
        "payload.priorDecisions",
      ),
      col(
        "score_changes",
        "string",
        "Score changes the game rules applied when the action was accepted, e.g. 'C7-Kb 6>10; C7-Ka 5>4' (empty if none)",
        "payload.scoreChanges",
      ),
      col(
        "map_score_after",
        "number",
        "Map score right after the action (empty for sessions without a grid map); a later revocation is not reflected here",
        "derived: replayed scores + game rules",
      ),
      col("revoked", "bool01", "1 if the facilitator revoked the action", "ActionRevoked"),
      col(
        "revoked_by_seq",
        "integer",
        "seq of the ActionRevoked event (empty if not revoked)",
        "ActionRevoked.seq",
      ),
    ],
  },
  {
    file: "events.csv",
    format: "csv",
    rowUnit: "one row per stored event",
    description:
      "The complete event log (envelope + JSON payload). DemographicsSubmitted payloads are redacted here — answers are only in demographics.csv.",
    dataClass: "pseudonymous",
    columns: [
      SESSION_ID,
      col("seq", "integer", "Position in the event log", "envelope.seq"),
      col("type", "string", "Event type (see DATA-TYPES.md)", "envelope.type"),
      col("actor_kind", "string", "player | facilitator | system", "envelope.actorKind"),
      col("seat", "integer", "Seat (empty for session-level events)", "envelope.seat"),
      CODE,
      col("round", "integer", "Round at the time (0 = before round 1)", "envelope.round"),
      col("server_ts", "epoch-ms", "Server timestamp", "envelope.serverTs"),
      col("server_wall", "iso-datetime", "Server wall-clock time", "envelope.serverWall"),
      col("client_ts", "epoch-ms", "Corrected client timestamp (player events only)", "envelope.clientTs"),
      col("client_seq", "integer", "Client intent counter", "envelope.clientSeq"),
      col(
        "payload_json",
        "json",
        'Event payload as JSON (DemographicsSubmitted → {"redacted":true})',
        "events.payload_json",
      ),
    ],
  },
  {
    file: "telemetry.csv",
    format: "csv",
    rowUnit: "one row per stored telemetry item",
    description: "Fine-grained UI behaviour (hover, inspect, pan/zoom, focus, idle, acks, clock sync).",
    dataClass: "pseudonymous",
    columns: [
      col("id", "integer", "Telemetry row id", "telemetry.id"),
      SESSION_ID,
      SEAT,
      CODE,
      col("round", "integer", "Round when received", "telemetry.round"),
      col("type", "string", "Telemetry type (see DATA-TYPES.md)", "telemetry.type"),
      col("client_ts", "epoch-ms", "Corrected client timestamp", "telemetry.client_ts"),
      col("client_offset_ms", "number", "Clock offset the client applied", "telemetry.client_offset_ms"),
      col("server_ts", "epoch-ms", "Server receive time", "telemetry.server_ts"),
      col("server_wall", "iso-datetime", "Server receive time, human-readable", "telemetry.server_wall"),
      col("payload_json", "json", "Telemetry payload as JSON", "telemetry.payload_json"),
    ],
  },
  {
    file: "consent.csv",
    format: "csv",
    rowUnit: "one row per ConsentRecorded event",
    description: "Consent answers per participant, one column per consent item.",
    dataClass: "pseudonymous-sensitive",
    columns: [
      SESSION_ID,
      col("seq", "integer", "Event seq", "envelope.seq"),
      SEAT,
      CODE,
      col("form_version", "string", "Consent form version", "payload.formVersion"),
      col("text_sha256", "string", "SHA-256 of the exact consent text shown", "payload.textSha256"),
      col("consented", "bool01", "1 if all required items were accepted", "payload.consented"),
      col("duration_ms", "number", "Time on the consent screen", "payload.durationMs"),
      col("server_wall", "iso-datetime", "When consent was recorded", "envelope"),
    ],
    dynamicColumns: {
      pattern: "answer_<id>",
      type: "bool01",
      description: "Answer to consent item <id>",
      source: "payload.answers[<id>]",
      idsFrom: "consentItems",
    },
  },
  {
    file: "demographics.csv",
    format: "csv",
    rowUnit: "one row per DemographicsSubmitted event",
    description: "Questionnaire answers (option values), one column per question.",
    dataClass: "pseudonymous-sensitive",
    columns: [
      SESSION_ID,
      SEAT,
      CODE,
      col("form_version", "string", "Questionnaire version", "payload.formVersion"),
      col("duration_ms", "number", "Time on the questionnaire", "payload.durationMs"),
      col("server_wall", "iso-datetime", "When submitted", "envelope"),
    ],
    dynamicColumns: {
      pattern: "q_<id>",
      type: "string",
      description: "Selected option value for question <id> ('prefer_not_to_say' allowed)",
      source: "payload.answers[<id>]",
      idsFrom: "demographicQuestions",
    },
  },
  {
    file: "audio_tracks.csv",
    format: "csv",
    rowUnit: "one row per stored audio track (one continuous microphone capture run of one seat)",
    description:
      "Index of the recorded microphone audio: when each track ran, how much audio arrived and how the browser processed it. Metadata only: the audio itself stays encrypted on the server and is never part of this export (see 'Export audio'). Empty (header only) for sessions without audio.",
    dataClass: "pseudonymous",
    columns: [
      SESSION_ID,
      SEAT,
      CODE,
      col("track_id", "string", "Random id of the track (UUID)", "AudioTrackStarted.trackId"),
      col(
        "status",
        "string",
        `open (still recording) | closed (stopped normally) | interrupted (the browser or microphone went away, or the server restarted: stop_reason ${INTERRUPTED_STOP_REASONS.join(", ")}, or a reason this version does not know) | deleted (raw audio deleted, metadata kept)`,
        "audio_tracks.status + stop_reason",
      ),
      col("start_reason", "string", AUDIO_START_REASONS_DOC, "AudioTrackStarted.reason"),
      col("stop_reason", "string", `${AUDIO_STOP_REASONS_DOC}; empty while open`, "AudioTrackStopped.reason"),
      col(
        "started_server_ts",
        "epoch-ms",
        "When the server opened the track",
        "audio_tracks.started_server_ts",
      ),
      col(
        "first_sample_ts",
        "epoch-ms",
        "Capture time of the first sample, as estimated by the browser's synchronised clock",
        "audio_tracks.started_client_ts",
      ),
      col(
        "closed_server_ts",
        "epoch-ms",
        "When the track was closed (empty while open)",
        "audio_tracks.closed_server_ts",
      ),
      col("duration_ms", "number", "Audio stored: samples / sample_rate", "audio_tracks.samples"),
      col("samples", "integer", "Samples stored (16 000 per second)", "audio_tracks.samples"),
      col("chunks", "integer", "Chunks (about 5 s each) stored", "audio_tracks.chunks"),
      col(
        "dropped_chunks",
        "integer",
        "Chunks the browser reported as lost (their audio is missing)",
        "AudioTrackStopped.droppedChunks",
      ),
      col(
        "gaps",
        "integer",
        "Missing chunks: sequence numbers or sample ranges never received",
        "derived: audio_chunks seq / start_sample",
      ),
      col(
        "sample_rate",
        "integer",
        "Sample rate of the stored audio (Hz; always 16000)",
        "AudioTrackStarted.sampleRate",
      ),
      col(
        "capture_sample_rate",
        "integer",
        "Native sample rate of the microphone before resampling (Hz)",
        "AudioTrackStarted.settings.sampleRate",
      ),
      col(
        "echo_cancellation",
        "bool01",
        "1 if the browser applied echo cancellation (requested off; empty if not reported)",
        "AudioTrackStarted.settings.echoCancellation",
      ),
      col(
        "noise_suppression",
        "bool01",
        "1 if the browser applied noise suppression (requested off; empty if not reported)",
        "AudioTrackStarted.settings.noiseSuppression",
      ),
      col(
        "auto_gain_control",
        "bool01",
        "1 if the browser applied automatic gain control (requested off; empty if not reported)",
        "AudioTrackStarted.settings.autoGainControl",
      ),
      col(
        "channel_count",
        "integer",
        "Channels the browser delivered (mixed to mono before upload; empty if not reported)",
        "AudioTrackStarted.settings.channelCount",
      ),
    ],
  },
  {
    file: "speech_segments.csv",
    format: "csv",
    rowUnit: "one row per stretch of speech of one seat",
    description:
      "Who spoke when, from the speaker attribution run in the DATABASE tab: it compares the loudness of the seats' microphones and never identifies a voice. Timing only, no voice content. Empty (header only) until an attribution has been run, and for sessions without audio. A participant's rows disappear when their data is erased.",
    dataClass: "pseudonymous",
    columns: [
      SESSION_ID,
      SEAT,
      CODE,
      col(
        "start_server_ts",
        "epoch-ms",
        "Start of the speech (server clock, aligned across seats)",
        "attribution segment.startTs",
      ),
      col("end_server_ts", "epoch-ms", "End of the speech (server clock)", "attribution segment.endTs"),
      col("duration_ms", "number", "end_server_ts − start_server_ts", "attribution segment.durationMs"),
      col(
        "round",
        "integer",
        "Round in progress when the speech started (0 = before round 1)",
        "event log at start_server_ts",
      ),
      col(
        "phase",
        "string",
        "Session phase when the speech started, e.g. onboarding, round_active, round_complete",
        "event log at start_server_ts",
      ),
      col("paused", "bool01", "1 if the game was paused when the speech started", "GamePaused / GameResumed"),
      col(
        "recording_paused",
        "bool01",
        "1 if recording was paused when the speech started (only possible at the edge of a pause)",
        "RecordingPaused / RecordingResumed",
      ),
      col(
        "mean_db",
        "number",
        "Mean level of the seat's own microphone over the speech (dBFS)",
        "attribution segment.meanDb",
      ),
      col(
        "confidence",
        "number",
        "0–1: mean speech probability of the speech model over the segment (with the energy fallback: share of frames that passed the gate)",
        "attribution segment.confidence",
      ),
      col(
        "overlap",
        "bool01",
        "1 if another seat spoke at the same time for part of the segment",
        "attribution segment.overlap",
      ),
      col(
        "overlap_ms",
        "number",
        "Time within the segment during which another seat also spoke",
        "attribution segment.overlapMs",
      ),
      col(
        "overlap_with",
        "seat-list",
        "Seats that spoke at the same time",
        "attribution segment.overlapWith",
      ),
      col(
        "engine_version",
        "string",
        "Version of the attribution engine that produced the segment",
        "audio_derivatives.engine_version",
      ),
    ],
  },
  {
    file: "manifest.json",
    format: "json",
    rowUnit: "one document per export",
    description:
      "Inventory of the export, used to trace which exports contain a participant after an erasure request.",
    dataClass: "pseudonymous",
    columns: [
      col("exportId", "string", "Id of this export", "generated"),
      col("sessionId", "string", "Session exported", "sessions.id"),
      col("kind", "string", "'standard' | 'anonymised'", "export request"),
      col("createdWall", "iso-datetime", "When the export was made", "server clock"),
      col(
        "files",
        "json",
        "[{ name, rows, sha256 }] for every file in the folder (integrity check)",
        "computed",
      ),
      col(
        "codeHashes",
        "json",
        "SHA-256 of every participant code contained (standard exports only; empty list in anonymised exports)",
        "computed",
      ),
    ],
  },
  {
    file: "codebook.md",
    format: "md",
    rowUnit: "one document per export",
    description:
      "Human-readable data dictionary for this export (generated from the same definitions as this table).",
    dataClass: "non-personal",
    columns: [],
  },
];

/* ─────────────────────────── Audio export ("Export audio") ─────────────────────────── */

/**
 * The separate, explicit and registered "Export audio" action of the DATABASE tab writes
 *   exports/<sessionId>/audio-<exportId>/
 * with one WAV per seat and kind, plus a manifest. Audio is never part of the CSV exports above.
 * File names hold the session id and the seat number only, never a participant code.
 */
export type AudioExportKind = "raw" | "clean";
/** What an "Export audio" request asks for: one kind, or both (one WAV of each per seat). */
export type AudioExportRequestKind = AudioExportKind | "both";

/** File name of one seat's WAV in an audio export (never contains a participant code). */
export function audioExportFileName(sessionId: string, seat: number, kind: AudioExportKind): string {
  return `${sessionId}_seat${seat}_${kind}.wav`;
}

export function exportFile(name: string): ExportFileDef {
  const f = EXPORT_FILES.find((x) => x.file === name);
  if (!f) throw new Error(`Unknown export file ${name}`);
  return f;
}

/** Expand a file's columns, including config-dependent dynamic columns. */
export function expandColumns(
  def: ExportFileDef,
  ids: { consentItems?: string[]; demographicQuestions?: string[] } = {},
): ExportColumn[] {
  if (!def.dynamicColumns) return def.columns;
  const d = def.dynamicColumns;
  const list = ids[d.idsFrom] ?? [];
  return [
    ...def.columns,
    ...list.map((id) =>
      col(
        d.pattern.replace("<id>", id),
        d.type,
        d.description.replace("<id>", id),
        d.source.replace("<id>", id),
      ),
    ),
  ];
}
