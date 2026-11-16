import { z } from "zod";
import { SessionConfigSchema } from "./config";
import { ActionKindSchema, KLabelSchema, PLabelSchema, SeatSchema } from "./labels";
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
    .describe("Random per-browser key (localStorage) so a PC keeps its terminal number across reloads"),
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
  regionId: z.string().max(64).nullable().describe("Region currently hovered (null = none)"),
});

/* ─────────────────────────── /facilitator : client → server ─────────────────────────── */

export const SessionCreate = z.object({
  scenarioId: z.string(),
  config: SessionConfigSchema,
  notes: z.string().max(1000).default(""),
});
export const SessionResume = z.object({ sessionId: z.string() });
export const SeatBind = z.object({ terminal: z.number().int().min(1), seat: SeatSchema });
export const SeatUnbind = z.object({ seat: SeatSchema, reason: z.string().max(200).default("facilitator") });
export const LabelsSet = z.object({
  assignments: z.array(
    z.object({ seat: SeatSchema, k: KLabelSchema, p: PLabelSchema, view: z.string().optional() }),
  ),
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

export type Ack<T = unknown> = { ok: true; data?: T } | { ok: false; error: string };

/* ─────────────────────────── Catalogue (drives docs/NETWORKING.md) ─────────────────────────── */

export interface MessageDef {
  namespace: "/player" | "/facilitator";
  direction: "client→server" | "server→client";
  description: string;
  /** zod schema (client→server) or TypeScript type name (server→client). */
  schema: z.ZodType | string;
  ack?: string;
  logged: string;
}

export const MESSAGES: Record<string, MessageDef> = {
  /* /player C→S */
  hello: {
    namespace: "/player",
    direction: "client→server",
    description:
      "First message after connecting. Identifies the browser (terminal) and, if present, re-claims a seat.",
    schema: PlayerHello,
    ack: "{ terminal: number, seat: number | null }",
    logged: "PlayerConnected (only if the seat token is valid)",
  },
  "clock:ping": {
    namespace: "/player",
    direction: "client→server",
    description: "Clock synchronisation sample (NTP-style). Sent 5× on connect and every 60 s.",
    schema: ClockPing,
    ack: "{ t0: number, serverTs: number }",
    logged: "Result stored by the client as telemetry 'clock_sync'",
  },
  "consent:submit": {
    namespace: "/player",
    direction: "client→server",
    description: "Answers of the consent form.",
    schema: ConsentSubmit,
    ack: "Ack",
    logged: "ConsentRecorded",
  },
  "demographics:submit": {
    namespace: "/player",
    direction: "client→server",
    description: "Answers of the demographics questionnaire.",
    schema: DemographicsSubmit,
    ack: "Ack",
    logged: "DemographicsSubmitted",
  },
  "briefing:ack": {
    namespace: "/player",
    direction: "client→server",
    description: "Player confirms having read the briefing.",
    schema: BriefingAck,
    ack: "Ack",
    logged: "BriefingAcknowledged",
  },
  intent: {
    namespace: "/player",
    direction: "client→server",
    description: "Request to propose or decide a region. Validated by the rules engine.",
    schema: IntentMsg,
    ack: "{ ok: true, seq } | { ok: false, reason, detail }",
    logged: "ProposalMade / DecisionMade, or IntentRejected",
  },
  telemetry: {
    namespace: "/player",
    direction: "client→server",
    description: "Batch of UI telemetry items (every 2 s or 20 items).",
    schema: TelemetryBatch,
    ack: "{ stored: number }",
    logged: "telemetry table (one row per valid item)",
  },
  presence: {
    namespace: "/player",
    direction: "client→server",
    description: "Volatile 'currently hovering' signal for the facilitator's live mirrors.",
    schema: Presence,
    logged: "Not stored (ephemeral). The persisted record is telemetry 'region_hover'.",
  },
  /* /player S→C */
  terminal: {
    namespace: "/player",
    direction: "server→client",
    description: "Terminal number assigned to this browser (shown in large type while unassigned).",
    schema: "{ terminal: number }",
    logged: "—",
  },
  bound: {
    namespace: "/player",
    direction: "server→client",
    description: "This browser was bound to a seat; carries the reconnect token.",
    schema: "{ seat: number, sessionId: string, seatToken: string }",
    logged: "— (SeatBound is logged when the facilitator binds)",
  },
  unbound: {
    namespace: "/player",
    direction: "server→client",
    description: "The seat binding was removed (or the session ended); return to the waiting screen.",
    schema: "{ reason: string }",
    logged: "—",
  },
  state: {
    namespace: "/player",
    direction: "server→client",
    description:
      "Full projected state for this player (PlayerView): phase, round, own labels and quotas, map geometry, OWN view content only, highlights.",
    schema: "PlayerView",
    logged: "Client acknowledges with telemetry 'state_received'",
  },
  /* /facilitator C→S */
  "session:create": {
    namespace: "/facilitator",
    direction: "client→server",
    description: "Create a new session from a scenario and config.",
    schema: SessionCreate,
    ack: "Ack<{ sessionId }>",
    logged: "SessionCreated",
  },
  "session:resume": {
    namespace: "/facilitator",
    direction: "client→server",
    description: "Re-open an unfinished session (e.g. after a server restart).",
    schema: SessionResume,
    ack: "Ack",
    logged: "—",
  },
  "seat:bind": {
    namespace: "/facilitator",
    direction: "client→server",
    description: "Bind a connected terminal to a seat; generates the participant code.",
    schema: SeatBind,
    ack: "Ack<{ participantCode }>",
    logged: "SeatBound, PlayerConnected",
  },
  "seat:unbind": {
    namespace: "/facilitator",
    direction: "client→server",
    description: "Remove a seat binding (lobby only).",
    schema: SeatUnbind,
    ack: "Ack",
    logged: "SeatUnbound",
  },
  "labels:set": {
    namespace: "/facilitator",
    direction: "client→server",
    description: "Set K/P labels (and view when viewAssignment = manual) for every seat.",
    schema: LabelsSet,
    ack: "Ack",
    logged: "LabelsAssigned (method = manual)",
  },
  "labels:randomise": {
    namespace: "/facilitator",
    direction: "client→server",
    description: "Randomly assign distinct K and P labels to the seats.",
    schema: Empty,
    ack: "Ack",
    logged: "LabelsAssigned (method = random, with seed)",
  },
  "onboarding:start": {
    namespace: "/facilitator",
    direction: "client→server",
    description: "Lock seats and send players to consent / demographics / briefing.",
    schema: Empty,
    ack: "Ack",
    logged: "OnboardingStarted",
  },
  "round:start": {
    namespace: "/facilitator",
    direction: "client→server",
    description: "Start the next round.",
    schema: Empty,
    ack: "Ack",
    logged: "RoundStarted",
  },
  "round:end": {
    namespace: "/facilitator",
    direction: "client→server",
    description: "Force-end the current round.",
    schema: Empty,
    ack: "Ack",
    logged: "RoundCompleted (reason = facilitator) [+ GameCompleted after the last round]",
  },
  "game:pause": {
    namespace: "/facilitator",
    direction: "client→server",
    description: "Pause the active round.",
    schema: Empty,
    ack: "Ack",
    logged: "GamePaused",
  },
  "game:resume": {
    namespace: "/facilitator",
    direction: "client→server",
    description: "Resume after a pause.",
    schema: Empty,
    ack: "Ack",
    logged: "GameResumed",
  },
  "action:revoke": {
    namespace: "/facilitator",
    direction: "client→server",
    description: "Undo a proposal/decision of the current round.",
    schema: ActionRevoke,
    ack: "Ack",
    logged: "ActionRevoked",
  },
  broadcast: {
    namespace: "/facilitator",
    direction: "client→server",
    description: "Show a message on every player's screen.",
    schema: BroadcastMsg,
    ack: "Ack",
    logged: "FacilitatorBroadcast",
  },
  note: {
    namespace: "/facilitator",
    direction: "client→server",
    description: "Add a facilitator annotation to the log.",
    schema: NoteMsg,
    ack: "Ack",
    logged: "SessionNote",
  },
  "participant:withdraw": {
    namespace: "/facilitator",
    direction: "client→server",
    description: "Mark a participant as withdrawn during the session.",
    schema: WithdrawMsg,
    ack: "Ack",
    logged: "ParticipantWithdrawn",
  },
  "game:end": {
    namespace: "/facilitator",
    direction: "client→server",
    description: "End the game early.",
    schema: Empty,
    ack: "Ack",
    logged: "[RoundCompleted] + GameCompleted (reason = facilitator)",
  },
  "session:close": {
    namespace: "/facilitator",
    direction: "client→server",
    description: "Archive the session; players return to the waiting screen.",
    schema: Empty,
    ack: "Ack",
    logged: "SessionClosed",
  },
  "session:abort": {
    namespace: "/facilitator",
    direction: "client→server",
    description: "Abandon the session (data kept, marked aborted).",
    schema: AbortMsg,
    ack: "Ack",
    logged: "SessionAborted",
  },
  /* /facilitator S→C */
  dashboard: {
    namespace: "/facilitator",
    direction: "server→client",
    description:
      "Full session state (all seats incl. participant codes), connected terminals and live per-seat statistics.",
    schema: "DashboardMsg",
    logged: "—",
  },
  scenario: {
    namespace: "/facilitator",
    direction: "server→client",
    description: "The loaded scenario with ALL views (for the composite map). Sent when a session is loaded.",
    schema: "Scenario | null",
    logged: "—",
  },
  events: {
    namespace: "/facilitator",
    direction: "server→client",
    description:
      "New events for the live log (demographic answers redacted). The backlog is sent on connect.",
    schema: "{ events: StoredEvent[], reset: boolean }",
    logged: "—",
  },
  "telemetry:live": {
    namespace: "/facilitator",
    direction: "server→client",
    description: "Newly stored telemetry rows (chatty types such as state_received are omitted).",
    schema: "{ items: StoredTelemetry[] }",
    logged: "—",
  },
  "presence:live": {
    namespace: "/facilitator",
    direction: "server→client",
    description: "Relayed hover presence of a seat for the live mirrors.",
    schema: "{ seat: number, regionId: string | null }",
    logged: "—",
  },
};

/* ─────────────────────────── Server → facilitator payload types ─────────────────────────── */

export interface TerminalInfo {
  terminal: number;
  connected: boolean;
  seat: number | null;
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
}

export interface DashboardMsg {
  state: import("./state").GameState | null;
  serverTs: number;
  terminals: TerminalInfo[];
  stats: Record<number, SeatLiveStats>;
  /** True when the dashboard is attached to a session that can still change. */
  live: boolean;
}
