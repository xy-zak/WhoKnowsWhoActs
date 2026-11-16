import { z } from "zod";
import { RoundSpecSchema, SessionConfigSchema } from "./config";
import { ActionKindSchema, KLabelSchema, PLabelSchema, SeatSchema, ViewIdSchema } from "./labels";
import { defineRecord } from "./meta";

/* ═══════════════════════════════════════════════════════════════════════════
 * GAME EVENTS — the append-only, authoritative log of a session.
 *
 * Invariant: a participant code NEVER appears inside a payload. It lives only
 * in the envelope column `participantCode`, so erasure is a single
 * `DELETE … WHERE participant_code = ?`. Inside a session players are
 * referred to by seat number.
 * ═══════════════════════════════════════════════════════════════════════════ */

const SeatList = z.array(SeatSchema);
const Ms = (d: string) => z.number().min(0).describe(`${d} (milliseconds)`);

const ConfigExample = SessionConfigSchema.parse({});

export const EVENT_DEFS = {
  SessionCreated: defineRecord({
    summary: "A new session was created with a scenario and configuration.",
    trigger: "Facilitator clicks 'Create session' on the setup screen.",
    actors: ["facilitator"],
    changesState: true,
    visibleTo: "Facilitator",
    dataClass: "non-personal",
    frequency: "1 per session",
    payload: z.object({
      config: SessionConfigSchema.describe("Full effective session configuration"),
      scenario: z
        .object({
          id: z.string().describe("Scenario id"),
          title: z.string().describe("Scenario title"),
          version: z.string().describe("Scenario version"),
          hash: z.string().describe("SHA-256 of the loaded scenario (map + views)"),
        })
        .describe("Scenario used in this session"),
      regionIds: z.array(z.string()).describe("All region ids in the map outline"),
      viewIds: z.array(z.string()).describe("All view ids available in the scenario"),
      harness: z
        .object({
          version: z.string().describe("Harness package version"),
          gitCommit: z.string().describe("Git commit of the harness code ('unknown' if not a git checkout)"),
        })
        .describe("Software version, for reproducibility"),
      notes: z.string().describe("Researcher notes entered at creation (no personal data)"),
    }),
    example: {
      config: ConfigExample,
      scenario: { id: "demo", title: "Demo archipelago", version: "1", hash: "9f2c…" },
      regionIds: ["R01", "R02"],
      viewIds: ["Ka", "Kb", "Kc", "Kd"],
      harness: { version: "0.1.0", gitCommit: "3e1a9c2" },
      notes: "Pilot session",
    },
  }),

  SessionNote: defineRecord({
    summary: "Facilitator annotation (e.g. 'fire alarm', 'participant asked a question').",
    trigger: "Facilitator adds a note on the dashboard.",
    actors: ["facilitator"],
    changesState: false,
    visibleTo: "Facilitator",
    dataClass: "non-personal",
    frequency: "0–n per session",
    payload: z.object({
      text: z
        .string()
        .max(500)
        .describe("Note text — must not contain names or other identifying information"),
    }),
    example: { text: "Seat 3 asked how to zoom; explained." },
  }),

  SeatBound: defineRecord({
    summary: "A browser terminal was assigned to a seat and a participant code was generated.",
    trigger: "Facilitator binds a connected terminal to a seat in the lobby.",
    actors: ["facilitator"],
    changesState: true,
    visibleTo: "Facilitator; the bound player sees their seat",
    dataClass: "pseudonymous",
    frequency: "1 per seat (more if re-bound)",
    payload: z.object({
      seat: SeatSchema,
      terminal: z.number().int().min(1).describe("Terminal number displayed on the player's screen"),
      bindingId: z.string().describe("Random id of this binding (used to derive the reconnect token)"),
    }),
    example: { seat: 2, terminal: 3, bindingId: "b-7KQ2M9" },
  }),

  SeatUnbound: defineRecord({
    summary: "A seat binding was removed before the game started.",
    trigger: "Facilitator unbinds a seat (wrong PC, participant left before onboarding).",
    actors: ["facilitator"],
    changesState: true,
    visibleTo: "Facilitator",
    dataClass: "pseudonymous",
    frequency: "rare",
    payload: z.object({
      seat: SeatSchema,
      reason: z.string().max(200).describe("Short reason"),
    }),
    example: { seat: 2, reason: "bound wrong terminal" },
  }),

  LabelsAssigned: defineRecord({
    summary: "Knowledge-type, power-type and map view were (re)assigned to seats.",
    trigger: "Facilitator sets labels manually or presses 'Randomise'. Not allowed during an active round.",
    actors: ["facilitator"],
    changesState: true,
    visibleTo: "Facilitator; each player sees own labels (configurable)",
    dataClass: "pseudonymous",
    frequency: "1–n per session",
    payload: z.object({
      assignments: z
        .array(
          z.object({
            seat: SeatSchema,
            k: KLabelSchema,
            p: PLabelSchema,
            view: ViewIdSchema,
          }),
        )
        .describe("Complete assignment for every seat"),
      method: z.enum(["manual", "random"]).describe("How the assignment was produced"),
      seed: z.string().nullable().describe("Seed of the random assignment (null for manual)"),
    }),
    example: {
      assignments: [
        { seat: 1, k: "Ka", p: "Pc", view: "Ka" },
        { seat: 2, k: "Kb", p: "Pa", view: "Kb" },
      ],
      method: "random",
      seed: "4QX9T2",
    },
  }),

  OnboardingStarted: defineRecord({
    summary: "Seats are locked; players move to the consent / demographics / briefing screens.",
    trigger: "Facilitator clicks 'Start onboarding' once all seats are bound and labelled.",
    actors: ["facilitator"],
    changesState: true,
    visibleTo: "Everyone",
    dataClass: "non-personal",
    frequency: "1 per session",
    payload: z.object({
      steps: z
        .array(z.enum(["consent", "demographics", "briefing"]))
        .describe("Onboarding steps enabled for this session"),
    }),
    example: { steps: ["consent", "demographics", "briefing"] },
  }),

  ConsentRecorded: defineRecord({
    summary: "Participant answered the in-game consent form.",
    trigger: "Player submits the consent screen (agree or decline).",
    actors: ["player"],
    changesState: true,
    visibleTo: "Facilitator (consent status only)",
    dataClass: "pseudonymous-sensitive",
    frequency: "1 per seat",
    payload: z.object({
      formVersion: z.string().describe("Version of the consent form shown"),
      textSha256: z.string().describe("SHA-256 of the exact consent text shown"),
      answers: z.record(z.string(), z.boolean()).describe("Answer per consent item id"),
      consented: z.boolean().describe("True if all required items were accepted"),
      durationMs: Ms("Time the consent screen was open"),
    }),
    example: {
      formVersion: "2026-11-v1",
      textSha256: "a3f1…",
      answers: { participate: true, data_use: true, future_research: false },
      consented: true,
      durationMs: 84213,
    },
  }),

  DemographicsSubmitted: defineRecord({
    summary: "Participant submitted the demographics questionnaire.",
    trigger: "Player submits the demographics screen.",
    actors: ["player"],
    changesState: true,
    visibleTo: "Nobody live (facilitator sees 'submitted ✓' only); exported to demographics.csv only",
    dataClass: "pseudonymous-sensitive",
    frequency: "1 per seat",
    payload: z.object({
      formVersion: z.string().describe("Version of the demographics form"),
      answers: z.record(z.string(), z.string()).describe("Selected option value per question id"),
      durationMs: Ms("Time the questionnaire was open"),
    }),
    example: {
      formVersion: "2026-11-v1",
      answers: { age_bracket: "25_34", field: "design", games_experience: "weekly" },
      durationMs: 41022,
    },
  }),

  BriefingAcknowledged: defineRecord({
    summary: "Participant confirmed they read the briefing / instructions.",
    trigger: "Player presses 'I'm ready' on the briefing screen.",
    actors: ["player"],
    changesState: true,
    visibleTo: "Facilitator",
    dataClass: "pseudonymous",
    frequency: "1 per seat",
    payload: z.object({
      textSha256: z.string().describe("SHA-256 of the briefing text shown"),
      durationMs: Ms("Time the briefing was open"),
    }),
    example: { textSha256: "77be…", durationMs: 120400 },
  }),

  PlayerConnected: defineRecord({
    summary: "A bound player's browser (re)connected.",
    trigger: "Socket connects and authenticates with its seat token.",
    actors: ["system"],
    changesState: true,
    visibleTo: "Facilitator; other players see connection status",
    dataClass: "pseudonymous",
    frequency: "1 + number of reconnects per seat",
    payload: z.object({
      seat: SeatSchema,
      reconnect: z.boolean().describe("True if this seat had connected before in this session"),
    }),
    example: { seat: 2, reconnect: false },
  }),

  PlayerDisconnected: defineRecord({
    summary: "A bound player's browser disconnected.",
    trigger: "Socket disconnects (tab closed, network drop, reload).",
    actors: ["system"],
    changesState: true,
    visibleTo: "Facilitator; other players see connection status",
    dataClass: "pseudonymous",
    frequency: "0–n per seat",
    payload: z.object({
      seat: SeatSchema,
      reason: z.string().describe("Socket.IO disconnect reason, e.g. 'transport close'"),
    }),
    example: { seat: 2, reason: "transport close" },
  }),

  RoundStarted: defineRecord({
    summary: "A round began; players may now propose/decide.",
    trigger: "Facilitator clicks 'Start round' (or auto-advance timer fires).",
    actors: ["facilitator", "system"],
    changesState: true,
    visibleTo: "Everyone",
    dataClass: "non-personal",
    frequency: "roundCount per session (default 3)",
    payload: z.object({
      round: z.number().int().min(1).describe("Round number (1-based)"),
      spec: RoundSpecSchema.describe("Effective round definition"),
      startedBy: z.enum(["facilitator", "auto"]),
    }),
    example: {
      round: 1,
      spec: { rule: "quota", quota: { propose: 5, decide: 5 }, timeLimitSec: null },
      startedBy: "facilitator",
    },
  }),

  ProposalMade: defineRecord({
    summary: "A player proposed a region (highlighted for all players).",
    trigger: "Player confirms a 'propose' on a region and the server accepts it.",
    actors: ["player"],
    changesState: true,
    visibleTo: "Everyone (actor seat visible to players if showActorToPlayers)",
    dataClass: "pseudonymous",
    frequency: "≤ quota.propose × seats × rounds (default 60)",
    payload: z.object({
      regionId: z.string().describe("Target region id"),
      quotaUsed: z
        .number()
        .int()
        .min(1)
        .describe("Proposals this seat has made this round, including this one"),
      quotaLimit: z.number().int().nullable().describe("Proposal quota this round (null = unlimited)"),
      priorProposals: SeatList.describe("Seats that had already proposed this region this round"),
      priorDecisions: SeatList.describe("Seats that had already decided this region this round"),
      msSinceRoundStart: Ms("Active (un-paused) server time since the round started"),
    }),
    example: {
      regionId: "R07",
      quotaUsed: 2,
      quotaLimit: 5,
      priorProposals: [3],
      priorDecisions: [],
      msSinceRoundStart: 51234,
    },
  }),

  DecisionMade: defineRecord({
    summary: "A player decided on a region (highlighted in the decision colour for all players).",
    trigger: "Player confirms a 'decide' on a region and the server accepts it.",
    actors: ["player"],
    changesState: true,
    visibleTo: "Everyone (actor seat visible to players if showActorToPlayers)",
    dataClass: "pseudonymous",
    frequency: "≤ quota.decide × seats × rounds (default 60)",
    payload: z.object({
      regionId: z.string().describe("Target region id"),
      quotaUsed: z
        .number()
        .int()
        .min(1)
        .describe("Decisions this seat has made this round, including this one"),
      quotaLimit: z.number().int().nullable().describe("Decision quota this round (null = unlimited)"),
      priorProposals: SeatList.describe(
        "Seats that had proposed this region this round before this decision",
      ),
      priorDecisions: SeatList.describe("Seats that had already decided this region this round"),
      msSinceRoundStart: Ms("Active (un-paused) server time since the round started"),
    }),
    example: {
      regionId: "R07",
      quotaUsed: 1,
      quotaLimit: 5,
      priorProposals: [3, 2],
      priorDecisions: [],
      msSinceRoundStart: 73410,
    },
  }),

  IntentRejected: defineRecord({
    summary: "A player's propose/decide attempt was refused by the rules.",
    trigger: "Server validation fails (not active, paused, quota used up, unknown region, …).",
    actors: ["player"],
    changesState: false,
    visibleTo: "Facilitator; the acting player gets an error message",
    dataClass: "pseudonymous",
    frequency: "rare",
    payload: z.object({
      kind: ActionKindSchema,
      regionId: z.string().describe("Region the player tried to act on"),
      reason: z
        .enum(["round_not_active", "paused", "seat_inactive", "unknown_region", "quota_exhausted", "rule"])
        .describe("Machine-readable rejection reason"),
      detail: z.string().describe("Human-readable explanation"),
    }),
    example: {
      kind: "decide",
      regionId: "R02",
      reason: "quota_exhausted",
      detail: "No decisions left this round",
    },
  }),

  ActionRevoked: defineRecord({
    summary: "Facilitator undid a proposal/decision (e.g. misclick). The original event is kept.",
    trigger: "Facilitator clicks 'Revoke' on an action during the active round.",
    actors: ["facilitator"],
    changesState: true,
    visibleTo: "Everyone (highlight disappears)",
    dataClass: "pseudonymous",
    frequency: "rare",
    payload: z.object({
      targetSeq: z.number().int().describe("seq of the ProposalMade/DecisionMade being revoked"),
      targetType: z.enum(["ProposalMade", "DecisionMade"]),
      targetSeat: SeatSchema.describe("Seat whose action was revoked"),
      regionId: z.string(),
      reason: z.string().max(200),
    }),
    example: {
      targetSeq: 57,
      targetType: "DecisionMade",
      targetSeat: 4,
      regionId: "R11",
      reason: "misclick",
    },
  }),

  RoundCompleted: defineRecord({
    summary: "A round ended.",
    trigger: "All quotas used (rule 'quota'), time limit elapsed, or facilitator force-ended the round.",
    actors: ["system", "facilitator"],
    changesState: true,
    visibleTo: "Everyone",
    dataClass: "non-personal",
    frequency: "roundCount per session",
    payload: z.object({
      round: z.number().int().min(1),
      reason: z.enum(["quota_met", "time_limit", "facilitator"]),
      durationMs: Ms("Server time from RoundStarted to now, excluding nothing (pauses included)"),
      pausedMs: Ms("Total time paused during the round"),
      actionCounts: z
        .record(z.string(), z.object({ propose: z.number().int(), decide: z.number().int() }))
        .describe("Non-revoked actions per seat in this round"),
    }),
    example: {
      round: 1,
      reason: "quota_met",
      durationMs: 612000,
      pausedMs: 0,
      actionCounts: { "1": { propose: 5, decide: 5 }, "2": { propose: 5, decide: 5 } },
    },
  }),

  GamePaused: defineRecord({
    summary: "The game was paused; actions are refused until resumed.",
    trigger: "Facilitator presses pause, or a player disconnects during a round (pauseOnDisconnect).",
    actors: ["facilitator", "system"],
    changesState: true,
    visibleTo: "Everyone",
    dataClass: "non-personal",
    frequency: "0–n",
    payload: z.object({
      reason: z.enum(["facilitator", "disconnect"]),
      seat: SeatSchema.nullable().describe("Seat that disconnected (reason = disconnect)"),
    }),
    example: { reason: "disconnect", seat: 3 },
  }),

  GameResumed: defineRecord({
    summary: "The game was resumed after a pause.",
    trigger: "Facilitator presses resume.",
    actors: ["facilitator"],
    changesState: true,
    visibleTo: "Everyone",
    dataClass: "non-personal",
    frequency: "0–n",
    payload: z.object({ pausedMs: Ms("Length of the pause") }),
    example: { pausedMs: 45000 },
  }),

  FacilitatorBroadcast: defineRecord({
    summary: "Facilitator sent a message shown on every player's screen.",
    trigger: "Facilitator uses 'Broadcast'.",
    actors: ["facilitator"],
    changesState: true,
    visibleTo: "Everyone",
    dataClass: "non-personal",
    frequency: "0–n",
    payload: z.object({ text: z.string().max(300).describe("Message text") }),
    example: { text: "Five minutes left in this round." },
  }),

  ParticipantWithdrawn: defineRecord({
    summary: "A participant withdrew (during the session) or their data was erased afterwards.",
    trigger: "Facilitator marks a participant as withdrawn, or an erasure request is executed.",
    actors: ["facilitator", "system"],
    changesState: true,
    visibleTo: "Facilitator; other players see the seat as inactive",
    dataClass: "non-personal",
    frequency: "rare",
    payload: z.object({
      seat: SeatSchema,
      by: z.enum(["facilitator", "erasure"]).describe("How the withdrawal was recorded"),
      phase: z.string().describe("Session phase when the withdrawal was recorded"),
    }),
    example: { seat: 3, by: "facilitator", phase: "round_active" },
  }),

  GameCompleted: defineRecord({
    summary: "The last round finished (or the facilitator ended the game early).",
    trigger: "RoundCompleted for the final round, or facilitator clicks 'End game'.",
    actors: ["system", "facilitator"],
    changesState: true,
    visibleTo: "Everyone (players see the end screen with their takedown code)",
    dataClass: "non-personal",
    frequency: "1 per session",
    payload: z.object({
      roundsPlayed: z.number().int().min(0),
      reason: z.enum(["all_rounds", "facilitator"]),
    }),
    example: { roundsPlayed: 3, reason: "all_rounds" },
  }),

  SessionClosed: defineRecord({
    summary: "Session archived; no further events except erasure markers.",
    trigger: "Facilitator clicks 'Close session'.",
    actors: ["facilitator"],
    changesState: true,
    visibleTo: "Facilitator",
    dataClass: "non-personal",
    frequency: "1 per session",
    payload: z.object({}),
    example: {},
  }),

  SessionAborted: defineRecord({
    summary: "Session abandoned before completion (data kept, marked as aborted).",
    trigger: "Facilitator clicks 'Abort session'.",
    actors: ["facilitator"],
    changesState: true,
    visibleTo: "Everyone",
    dataClass: "non-personal",
    frequency: "rare",
    payload: z.object({ reason: z.string().max(200) }),
    example: { reason: "network failure" },
  }),
} as const;

export type EventDefs = typeof EVENT_DEFS;
export type EventType = keyof EventDefs;
export const EVENT_TYPES = Object.keys(EVENT_DEFS) as EventType[];
export type PayloadOf<T extends EventType> = z.infer<EventDefs[T]["payload"]>;

export const ActorKindSchema = z.enum(["player", "facilitator", "system"]).describe("Who caused the event");
export type ActorKind = z.infer<typeof ActorKindSchema>;

/** Envelope fields shared by every stored event. Column names in SQLite are snake_case. */
export const EventEnvelopeSchema = z.object({
  sessionId: z.string().describe("Session id, e.g. S-20261116-7KQ2"),
  seq: z
    .number()
    .int()
    .min(1)
    .describe("Position in the session's event log (1, 2, 3, …; gaps only after erasure)"),
  type: z.enum(EVENT_TYPES as [EventType, ...EventType[]]).describe("Event type"),
  actorKind: ActorKindSchema,
  seat: SeatSchema.nullable().describe("Seat the event is about/caused by (null for session-level events)"),
  participantCode: z
    .string()
    .nullable()
    .describe("Pseudonymous participant code of that seat — the ONLY place codes are stored"),
  round: z.number().int().min(0).describe("Current round when the event happened (0 = before round 1)"),
  serverTs: z
    .number()
    .describe(
      "Server timestamp, Unix epoch milliseconds with sub-ms precision (monotonic within a server run)",
    ),
  serverWall: z.string().describe("Server wall-clock time, ISO-8601 UTC (human-readable copy of serverTs)"),
  clientTs: z
    .number()
    .nullable()
    .describe("Client timestamp corrected to server time (epoch ms) for player-initiated events, else null"),
  clientSeq: z
    .number()
    .int()
    .nullable()
    .describe("Client-side sequence number of the intent (idempotency on reconnect), else null"),
});
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

/** A stored event: envelope + typed payload (a discriminated union on `type`). */
export type StoredEvent = {
  [K in EventType]: Omit<EventEnvelope, "type"> & { type: K; payload: PayloadOf<K> };
}[EventType];

export type EventOf<T extends EventType> = Extract<StoredEvent, { type: T }>;

/** What the server passes to the event store; seq/timestamps are filled in on append. */
export type NewEvent = {
  [K in EventType]: {
    type: K;
    payload: PayloadOf<K>;
    actorKind: ActorKind;
    seat?: number | null;
    participantCode?: string | null;
    clientTs?: number | null;
    clientSeq?: number | null;
  };
}[EventType];

export function parsePayload<T extends EventType>(type: T, payload: unknown): PayloadOf<T> {
  return EVENT_DEFS[type].payload.parse(payload) as PayloadOf<T>;
}

/** Types whose payload must be hidden from live dashboards and generic exports. */
export const REDACTED_EVENT_TYPES: ReadonlySet<EventType> = new Set(["DemographicsSubmitted"]);
