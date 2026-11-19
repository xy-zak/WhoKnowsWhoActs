import type { z } from "zod";
import type { AudioAck } from "./audio";
import type { StoredEvent } from "./events";
import type { PlayerView } from "./projections";
import type { Ack, DashboardMsg, FACILITATOR_SCHEMAS, PLAYER_SCHEMAS } from "./protocol";
import type { Scenario } from "./scenario";
import type { StoredTelemetry } from "./telemetry";

/* ═══════════════════════════════════════════════════════════════════════════
 * TYPED SOCKET.IO EVENT MAPS, derived from the schema tables in protocol.ts.
 *
 * Both ends use them: the browsers and test clients as
 *   Socket<PlayerServerToClient, PlayerClientToServer>   (socket.io-client)
 * and the server as
 *   Namespace<ServerSide<PlayerClientToServer>, PlayerServerToClient>.
 *
 * So the compiler checks every emit and every listener: the message name, the payload a client
 * sends (the schema's input type), the acknowledgement it gets back, and every server→client
 * payload. On the server an incoming payload stays `unknown` (ServerSide) until the handler has
 * validated it with the message's schema: nothing a client sends is trusted.
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * The refusal every seated-player request can answer with. `retry: true` is transient: the socket
 * holds no seat yet (right after a reconnect, before `hello` was answered) or the server failed;
 * the same message may be sent again. `retry: false`: invalid, or refused by the session.
 */
export type Refusal = { ok: false; error: string; retry?: boolean };

/** Ack of `hello`. */
export type HelloAck = { ok: true; terminal: number; seat: number | null } | Refusal;

/** Ack of `clock:ping`. */
export interface ClockPingAck {
  t0: number;
  serverTs: number;
}

/** Ack of `intent`: accepted (with the event's seq) or rejected by the rules (reason, detail). */
export type IntentAck =
  | { ok: true; seq: number; duplicate?: boolean }
  | { ok: false; reason: string; detail: string; duplicate?: boolean };

/** Ack of `audio:chunk`. */
export type AudioChunkAck = AudioAck<{ trackId: string; seq: number; duplicate?: boolean }>;

/** What the server answers to each /player message that has an acknowledgement. */
export interface PlayerAcks {
  hello: HelloAck;
  "clock:ping": ClockPingAck;
  "consent:submit": Ack;
  "demographics:submit": Ack;
  "mic:check": Ack;
  "briefing:ack": Ack;
  intent: IntentAck | Refusal;
  telemetry: { stored: number } | Refusal;
  "audio:start": AudioAck<unknown>;
  "audio:chunk": AudioChunkAck;
  "audio:stop": AudioAck<unknown>;
}

export type PlayerCommand = keyof typeof PLAYER_SCHEMAS;
export type FacilitatorCommand = keyof typeof FACILITATOR_SCHEMAS;

/** What a client sends: the input of the message's schema (before defaults and transforms). */
export type PlayerPayload<K extends PlayerCommand> = z.input<(typeof PLAYER_SCHEMAS)[K]>;
/** What the server works with after validation: the output of the message's schema. */
export type PlayerMessage<K extends PlayerCommand> = z.output<(typeof PLAYER_SCHEMAS)[K]>;
export type FacilitatorPayload<K extends FacilitatorCommand> = z.input<(typeof FACILITATOR_SCHEMAS)[K]>;
export type FacilitatorMessage<K extends FacilitatorCommand> = z.output<(typeof FACILITATOR_SCHEMAS)[K]>;

/** /player messages with an acknowledgement. */
export type PlayerRequest = keyof PlayerAcks & PlayerCommand;

export type PlayerClientToServer = {
  [K in PlayerCommand]: K extends keyof PlayerAcks
    ? (msg: PlayerPayload<K>, ack: (a: PlayerAcks[K]) => void) => void
    : (msg: PlayerPayload<K>) => void;
};

/** `bound`: this browser now holds a seat. */
export interface BoundMsg {
  seat: number;
  sessionId: string;
  seatToken: string;
}

export interface PlayerServerToClient {
  terminal: (m: { terminal: number }) => void;
  bound: (m: BoundMsg) => void;
  unbound: (m: { reason: string }) => void;
  rehello: () => void;
  state: (v: PlayerView) => void;
}

/** The `data` of a successful facilitator command (commands not listed return none). */
export interface FacilitatorResults {
  "session:create": { sessionId: string };
  "session:resume": { sessionId: string };
  "seat:bind": { participantCode: string | null; fake: boolean };
  "fake:add": { seats: number[] };
}

export type FacilitatorResult<K extends FacilitatorCommand> = K extends keyof FacilitatorResults
  ? FacilitatorResults[K]
  : undefined;

/** Ack of a facilitator command: its result (`undefined` for commands without one), or the error. */
export type FacilitatorAck<K extends FacilitatorCommand> =
  | { ok: true; data: FacilitatorResult<K> }
  | { ok: false; error: string };

export type FacilitatorClientToServer = {
  [K in FacilitatorCommand]: (msg: FacilitatorPayload<K>, ack: (a: FacilitatorAck<K>) => void) => void;
};

export interface FacilitatorServerToClient {
  dashboard: (d: DashboardMsg) => void;
  scenario: (s: Scenario | null) => void;
  events: (m: { events: StoredEvent[]; reset: boolean }) => void;
  "telemetry:live": (m: { items: StoredTelemetry[]; reset: boolean }) => void;
  "presence:live": (m: { seat: number; regionId: string | null }) => void;
}

/**
 * The server's view of a client→server map: every payload is `unknown` until validated, and the
 * acknowledgement is optional (a client may leave it out).
 */
export type ServerSide<M> = {
  [K in keyof M]: M[K] extends (...args: infer P) => void
    ? P extends [unknown, infer A]
      ? (raw: unknown, ack?: A) => void
      : (raw: unknown) => void
    : never;
};
