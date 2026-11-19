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

const SESSION_ID: ExportColumn = {
  name: "session_id",
  type: "string",
  description: "Session id, e.g. S-20261116-7KQ2",
  source: "envelope.sessionId",
};
const SEAT: ExportColumn = {
  name: "seat",
  type: "integer",
  description: "Seat number (1–4)",
  source: "envelope.seat / SeatBound.seat",
};
const CODE: ExportColumn = {
  name: "participant_code",
  type: "string",
  description: "Pseudonymous participant code (anonymised export: random A-XXXXXX id)",
  source: "envelope.participantCode",
};

export const EXPORT_FILES: ExportFileDef[] = [
  {
    file: "session.json",
    format: "json",
    rowUnit: "one document per export",
    description: "Session metadata: configuration, scenario, software version and a per-round summary.",
    dataClass: "non-personal",
    columns: [
      {
        name: "exportId",
        type: "string",
        description: "Id of this export",
        source: "generated at export time",
      },
      {
        name: "kind",
        type: "string",
        description: "'standard' (pseudonymised) or 'anonymised'",
        source: "export request",
      },
      {
        name: "exportedWall",
        type: "iso-datetime",
        description: "When the export was made",
        source: "server clock",
      },
      { name: "sessionId", type: "string", description: "Session id", source: "sessions.id" },
      {
        name: "status",
        type: "string",
        description: "Session phase at export time",
        source: "reduced state.phase",
      },
      {
        name: "createdWall",
        type: "iso-datetime",
        description: "Session creation time",
        source: "SessionCreated",
      },
      {
        name: "scenario",
        type: "json",
        description: "{ id, title, version, hash } of the scenario used",
        source: "SessionCreated.scenario",
      },
      {
        name: "config",
        type: "json",
        description: "Full effective session configuration",
        source: "SessionCreated.config",
      },
      {
        name: "tags",
        type: "json",
        description: 'Session tags (list of strings), e.g. ["pilot", "condition-A"]',
        source: "SessionCreated.config.tags",
      },
      {
        name: "notes",
        type: "string",
        description: "Researcher notes at creation",
        source: "SessionCreated.notes",
      },
      {
        name: "harness",
        type: "json",
        description: "{ version, gitCommit } of the harness software",
        source: "SessionCreated.harness",
      },
      {
        name: "rounds",
        type: "json",
        description: "[{ round, startedWall, endedWall, reason, durationMs, pausedMs }] per played round",
        source: "RoundStarted + RoundCompleted",
      },
      {
        name: "labelPairing",
        type: "json",
        description:
          "{ mode, id, name, pairs } of the final label assignment: aligned, or fully dissociated D1–D6 (see the pairing table), e.g. { mode: 'dissociated', id: 6, name: 'D6', pairs: 'Ka–Pd Kb–Pc Kc–Pa Kd–Pb' }",
        source: "last LabelsAssigned.pairing",
      },
      {
        name: "fakeSeats",
        type: "json",
        description:
          "Seats played by fake players (test clients the server created, not participants), e.g. [1, 3]; [] when every seat was a participant or an agent",
        source: "SeatBound.fake",
      },
      {
        name: "counts",
        type: "json",
        description: "{ events, telemetry, actions, players } row counts in this export",
        source: "computed",
      },
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
      {
        name: "terminal",
        type: "integer",
        description: "Client number of the browser bound to the seat (column name kept as terminal)",
        source: "SeatBound.terminal",
      },
      {
        name: "k_label",
        type: "string",
        description: "Knowledge type (Ka–Kd)",
        source: "last LabelsAssigned",
      },
      { name: "p_label", type: "string", description: "Power type (Pa–Pd)", source: "last LabelsAssigned" },
      {
        name: "view",
        type: "string",
        description: "Map view id shown to the seat",
        source: "last LabelsAssigned",
      },
      {
        name: "consent_status",
        type: "string",
        description: "pending | given | declined | skipped",
        source: "ConsentRecorded (skipped if consent step disabled)",
      },
      {
        name: "consent_version",
        type: "string",
        description: "Consent form version answered",
        source: "ConsentRecorded.formVersion",
      },
      {
        name: "demographics_submitted",
        type: "bool01",
        description: "1 if the questionnaire was submitted",
        source: "DemographicsSubmitted",
      },
      {
        name: "briefing_acknowledged",
        type: "bool01",
        description: "1 if the briefing was confirmed",
        source: "BriefingAcknowledged",
      },
      {
        name: "withdrawn",
        type: "bool01",
        description: "1 if the participant withdrew",
        source: "ParticipantWithdrawn",
      },
      {
        name: "reconnects",
        type: "integer",
        description: "Number of reconnections during the session",
        source: "PlayerConnected.reconnect",
      },
      {
        name: "rejections",
        type: "integer",
        description: "Number of rejected propose/decide attempts",
        source: "IntentRejected",
      },
      {
        name: "pairing",
        type: "string",
        description:
          "K–P pairing in force at the end: 'aligned' or 'D1'…'D6' (fully dissociated, see the pairing table)",
        source: "last LabelsAssigned.pairing",
      },
      {
        name: "agent_policy",
        type: "string",
        description:
          "Simulated sessions: id of the agent policy that played the seat (version, parameters and seed are in AgentBound). Empty for real participants",
        source: "AgentBound.policy",
      },
      {
        name: "fake_player",
        type: "bool01",
        description:
          "1 if the seat was played by a fake player: a test client the server created (not a participant; no code, no onboarding). Leave these rows out of analyses of participants",
        source: "SeatBound.fake",
      },
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
      { name: "seq", type: "integer", description: "Event seq of the action", source: "envelope.seq" },
      { name: "round", type: "integer", description: "Round number", source: "envelope.round" },
      SEAT,
      CODE,
      {
        name: "k_label",
        type: "string",
        description: "Knowledge type of the seat at action time",
        source: "state",
      },
      {
        name: "p_label",
        type: "string",
        description: "Power type of the seat at action time",
        source: "state",
      },
      { name: "view", type: "string", description: "View of the seat at action time", source: "state" },
      { name: "kind", type: "string", description: "propose | decide", source: "event type" },
      {
        name: "region_id",
        type: "string",
        description: "Target sub-square id, e.g. C7-Kb (square C7, knowledge type Kb)",
        source: "payload.regionId",
      },
      {
        name: "region_name",
        type: "string",
        description: "Target sub-square name, e.g. 'C7 · Kb'",
        source: "scenario regions",
      },
      {
        name: "square_id",
        type: "string",
        description: "Square of the target sub-square, e.g. C7",
        source: "payload.regionId",
      },
      {
        name: "target_k",
        type: "string",
        description: "Knowledge type of the target sub-square (Ka–Kd)",
        source: "payload.regionId",
      },
      {
        name: "server_ts",
        type: "epoch-ms",
        description: "Server time the action was accepted",
        source: "envelope",
      },
      {
        name: "server_wall",
        type: "iso-datetime",
        description: "Same as server_ts, human-readable",
        source: "envelope",
      },
      {
        name: "client_ts",
        type: "epoch-ms",
        description: "Client time of the confirm click, corrected to server time",
        source: "envelope.clientTs",
      },
      {
        name: "client_seq",
        type: "integer",
        description: "Client intent counter",
        source: "envelope.clientSeq",
      },
      {
        name: "ms_since_round_start",
        type: "number",
        description: "Active (un-paused) server ms since the round started",
        source: "payload.msSinceRoundStart",
      },
      {
        name: "ms_since_prev_own_action",
        type: "number",
        description: "Server ms since this seat's previous action in the same round (empty for the first)",
        source: "derived from server_ts",
      },
      {
        name: "reaction_ms",
        type: "number",
        description:
          "server_ts minus clientTs of this seat's latest state_received telemetry before the action (time from seeing the latest state to acting); empty if none",
        source: "derived: telemetry state_received",
      },
      {
        name: "quota_used",
        type: "integer",
        description: "Actions of this kind used by the seat this round, incl. this one",
        source: "payload.quotaUsed",
      },
      {
        name: "quota_limit",
        type: "integer",
        description: "Quota for this kind this round (empty = unlimited)",
        source: "payload.quotaLimit",
      },
      {
        name: "prior_proposals",
        type: "seat-list",
        description: "Seats that had proposed this sub-square earlier this round",
        source: "payload.priorProposals",
      },
      {
        name: "prior_decisions",
        type: "seat-list",
        description: "Seats that had decided this sub-square earlier this round",
        source: "payload.priorDecisions",
      },
      {
        name: "score_changes",
        type: "string",
        description:
          "Score changes the game rules applied when the action was accepted, e.g. 'C7-Kb 6>10; C7-Ka 5>4' (empty if none)",
        source: "payload.scoreChanges",
      },
      {
        name: "map_score_after",
        type: "number",
        description:
          "Map score right after the action (empty for sessions without a grid map); a later revocation is not reflected here",
        source: "derived: replayed scores + game rules",
      },
      {
        name: "revoked",
        type: "bool01",
        description: "1 if the facilitator revoked the action",
        source: "ActionRevoked",
      },
      {
        name: "revoked_by_seq",
        type: "integer",
        description: "seq of the ActionRevoked event (empty if not revoked)",
        source: "ActionRevoked.seq",
      },
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
      { name: "seq", type: "integer", description: "Position in the event log", source: "envelope.seq" },
      {
        name: "type",
        type: "string",
        description: "Event type (see DATA-TYPES.md)",
        source: "envelope.type",
      },
      {
        name: "actor_kind",
        type: "string",
        description: "player | facilitator | system",
        source: "envelope.actorKind",
      },
      {
        name: "seat",
        type: "integer",
        description: "Seat (empty for session-level events)",
        source: "envelope.seat",
      },
      CODE,
      {
        name: "round",
        type: "integer",
        description: "Round at the time (0 = before round 1)",
        source: "envelope.round",
      },
      { name: "server_ts", type: "epoch-ms", description: "Server timestamp", source: "envelope.serverTs" },
      {
        name: "server_wall",
        type: "iso-datetime",
        description: "Server wall-clock time",
        source: "envelope.serverWall",
      },
      {
        name: "client_ts",
        type: "epoch-ms",
        description: "Corrected client timestamp (player events only)",
        source: "envelope.clientTs",
      },
      {
        name: "client_seq",
        type: "integer",
        description: "Client intent counter",
        source: "envelope.clientSeq",
      },
      {
        name: "payload_json",
        type: "json",
        description: 'Event payload as JSON (DemographicsSubmitted → {"redacted":true})',
        source: "events.payload_json",
      },
    ],
  },
  {
    file: "telemetry.csv",
    format: "csv",
    rowUnit: "one row per stored telemetry item",
    description: "Fine-grained UI behaviour (hover, inspect, pan/zoom, focus, idle, acks, clock sync).",
    dataClass: "pseudonymous",
    columns: [
      { name: "id", type: "integer", description: "Telemetry row id", source: "telemetry.id" },
      SESSION_ID,
      SEAT,
      CODE,
      { name: "round", type: "integer", description: "Round when received", source: "telemetry.round" },
      {
        name: "type",
        type: "string",
        description: "Telemetry type (see DATA-TYPES.md)",
        source: "telemetry.type",
      },
      {
        name: "client_ts",
        type: "epoch-ms",
        description: "Corrected client timestamp",
        source: "telemetry.client_ts",
      },
      {
        name: "client_offset_ms",
        type: "number",
        description: "Clock offset the client applied",
        source: "telemetry.client_offset_ms",
      },
      {
        name: "server_ts",
        type: "epoch-ms",
        description: "Server receive time",
        source: "telemetry.server_ts",
      },
      {
        name: "server_wall",
        type: "iso-datetime",
        description: "Server receive time, human-readable",
        source: "telemetry.server_wall",
      },
      {
        name: "payload_json",
        type: "json",
        description: "Telemetry payload as JSON",
        source: "telemetry.payload_json",
      },
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
      { name: "seq", type: "integer", description: "Event seq", source: "envelope.seq" },
      SEAT,
      CODE,
      {
        name: "form_version",
        type: "string",
        description: "Consent form version",
        source: "payload.formVersion",
      },
      {
        name: "text_sha256",
        type: "string",
        description: "SHA-256 of the exact consent text shown",
        source: "payload.textSha256",
      },
      {
        name: "consented",
        type: "bool01",
        description: "1 if all required items were accepted",
        source: "payload.consented",
      },
      {
        name: "duration_ms",
        type: "number",
        description: "Time on the consent screen",
        source: "payload.durationMs",
      },
      {
        name: "server_wall",
        type: "iso-datetime",
        description: "When consent was recorded",
        source: "envelope",
      },
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
      {
        name: "form_version",
        type: "string",
        description: "Questionnaire version",
        source: "payload.formVersion",
      },
      {
        name: "duration_ms",
        type: "number",
        description: "Time on the questionnaire",
        source: "payload.durationMs",
      },
      { name: "server_wall", type: "iso-datetime", description: "When submitted", source: "envelope" },
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
      {
        name: "track_id",
        type: "string",
        description: "Random id of the track (UUID)",
        source: "AudioTrackStarted.trackId",
      },
      {
        name: "status",
        type: "string",
        description:
          "open (still recording) | closed (stopped normally) | interrupted (the browser or microphone went away, or the server restarted) | deleted (raw audio deleted, metadata kept)",
        source: "audio_tracks.status + stop_reason",
      },
      {
        name: "start_reason",
        type: "string",
        description: "Why the track started: mic_check | resume | reconnect | reload | permission_regained",
        source: "AudioTrackStarted.reason",
      },
      {
        name: "stop_reason",
        type: "string",
        description:
          "Why the track stopped: paused | game_complete | closed | aborted | withdrawn | disconnect | permission_lost | error | client_stop (empty while open)",
        source: "AudioTrackStopped.reason",
      },
      {
        name: "started_server_ts",
        type: "epoch-ms",
        description: "When the server opened the track",
        source: "audio_tracks.started_server_ts",
      },
      {
        name: "first_sample_ts",
        type: "epoch-ms",
        description: "Capture time of the first sample, as estimated by the browser's synchronised clock",
        source: "audio_tracks.started_client_ts",
      },
      {
        name: "closed_server_ts",
        type: "epoch-ms",
        description: "When the track was closed (empty while open)",
        source: "audio_tracks.closed_server_ts",
      },
      {
        name: "duration_ms",
        type: "number",
        description: "Audio stored: samples / sample_rate",
        source: "audio_tracks.samples",
      },
      {
        name: "samples",
        type: "integer",
        description: "Samples stored (16 000 per second)",
        source: "audio_tracks.samples",
      },
      {
        name: "chunks",
        type: "integer",
        description: "Chunks (about 5 s each) stored",
        source: "audio_tracks.chunks",
      },
      {
        name: "dropped_chunks",
        type: "integer",
        description: "Chunks the browser reported as lost (their audio is missing)",
        source: "AudioTrackStopped.droppedChunks",
      },
      {
        name: "gaps",
        type: "integer",
        description: "Missing chunks: sequence numbers or sample ranges never received",
        source: "derived: audio_chunks seq / start_sample",
      },
      {
        name: "sample_rate",
        type: "integer",
        description: "Sample rate of the stored audio (Hz; always 16000)",
        source: "AudioTrackStarted.sampleRate",
      },
      {
        name: "capture_sample_rate",
        type: "integer",
        description: "Native sample rate of the microphone before resampling (Hz)",
        source: "AudioTrackStarted.settings.sampleRate",
      },
      {
        name: "echo_cancellation",
        type: "bool01",
        description: "1 if the browser applied echo cancellation (requested off; empty if not reported)",
        source: "AudioTrackStarted.settings.echoCancellation",
      },
      {
        name: "noise_suppression",
        type: "bool01",
        description: "1 if the browser applied noise suppression (requested off; empty if not reported)",
        source: "AudioTrackStarted.settings.noiseSuppression",
      },
      {
        name: "auto_gain_control",
        type: "bool01",
        description: "1 if the browser applied automatic gain control (requested off; empty if not reported)",
        source: "AudioTrackStarted.settings.autoGainControl",
      },
      {
        name: "channel_count",
        type: "integer",
        description: "Channels the browser delivered (mixed to mono before upload; empty if not reported)",
        source: "AudioTrackStarted.settings.channelCount",
      },
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
      {
        name: "start_server_ts",
        type: "epoch-ms",
        description: "Start of the speech (server clock, aligned across seats)",
        source: "attribution segment.startTs",
      },
      {
        name: "end_server_ts",
        type: "epoch-ms",
        description: "End of the speech (server clock)",
        source: "attribution segment.endTs",
      },
      {
        name: "duration_ms",
        type: "number",
        description: "end_server_ts − start_server_ts",
        source: "attribution segment.durationMs",
      },
      {
        name: "round",
        type: "integer",
        description: "Round in progress when the speech started (0 = before round 1)",
        source: "event log at start_server_ts",
      },
      {
        name: "phase",
        type: "string",
        description: "Session phase when the speech started, e.g. onboarding, round_active, round_complete",
        source: "event log at start_server_ts",
      },
      {
        name: "paused",
        type: "bool01",
        description: "1 if the game was paused when the speech started",
        source: "GamePaused / GameResumed",
      },
      {
        name: "recording_paused",
        type: "bool01",
        description:
          "1 if recording was paused when the speech started (only possible at the edge of a pause)",
        source: "RecordingPaused / RecordingResumed",
      },
      {
        name: "mean_db",
        type: "number",
        description: "Mean level of the seat's own microphone over the speech (dBFS)",
        source: "attribution segment.meanDb",
      },
      {
        name: "confidence",
        type: "number",
        description:
          "0–1: mean speech probability of the speech model over the segment (with the energy fallback: share of frames that passed the gate)",
        source: "attribution segment.confidence",
      },
      {
        name: "overlap",
        type: "bool01",
        description: "1 if another seat spoke at the same time for part of the segment",
        source: "attribution segment.overlap",
      },
      {
        name: "overlap_ms",
        type: "number",
        description: "Time within the segment during which another seat also spoke",
        source: "attribution segment.overlapMs",
      },
      {
        name: "overlap_with",
        type: "seat-list",
        description: "Seats that spoke at the same time",
        source: "attribution segment.overlapWith",
      },
      {
        name: "engine_version",
        type: "string",
        description: "Version of the attribution engine that produced the segment",
        source: "audio_derivatives.engine_version",
      },
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
      { name: "exportId", type: "string", description: "Id of this export", source: "generated" },
      { name: "sessionId", type: "string", description: "Session exported", source: "sessions.id" },
      { name: "kind", type: "string", description: "'standard' | 'anonymised'", source: "export request" },
      {
        name: "createdWall",
        type: "iso-datetime",
        description: "When the export was made",
        source: "server clock",
      },
      {
        name: "files",
        type: "json",
        description: "[{ name, rows, sha256 }] for every file in the folder (integrity check)",
        source: "computed",
      },
      {
        name: "codeHashes",
        type: "json",
        description:
          "SHA-256 of every participant code contained (standard exports only; empty list in anonymised exports)",
        source: "computed",
      },
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

export interface AudioExportFileDef {
  /** File name pattern; `<sessionId>` and `<seat>` are replaced. */
  pattern: string;
  format: "wav" | "json";
  description: string;
  dataClass: DataClass;
}

export const AUDIO_EXPORT_FILES: AudioExportFileDef[] = [
  {
    pattern: "<sessionId>_seat<seat>_raw.wav",
    format: "wav",
    description:
      "The seat's raw microphone audio on the session timeline: 16 kHz mono 16-bit PCM, sample 0 = the timeline start in manifest.json, clock drift corrected, silence where the seat has no audio. Every seat's file has the same length, so the files line up sample for sample. Other seats' voices are audible (same room).",
    dataClass: "voice",
  },
  {
    pattern: "<sessionId>_seat<seat>_clean.wav",
    format: "wav",
    description:
      "The same, with everything not attributed to the seat attenuated by 30 dB (speaker attribution by loudness comparison). Overlapping speech stays at full level.",
    dataClass: "voice",
  },
  {
    pattern: "manifest.json",
    format: "json",
    description:
      "{ exportId, kind: 'audio', audioKind, sessionId, createdWall, requestedBy, note, format, timeline, files: [{ name, seat, kind, samples, durationMs, bytes, sha256 }] } — no participant codes. The export is also recorded in the export register.",
    dataClass: "non-personal",
  },
];

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
    ...list.map((id) => ({
      name: d.pattern.replace("<id>", id),
      type: d.type,
      description: d.description.replace("<id>", id),
      source: d.source.replace("<id>", id),
    })),
  ];
}
