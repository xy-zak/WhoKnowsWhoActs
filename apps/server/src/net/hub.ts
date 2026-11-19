import { timingSafeEqual } from "node:crypto";
import {
  AUDIO_SILENCE_DB,
  type AudioLevel,
  audioEnabled,
  type DashboardMsg,
  FACILITATOR_SCHEMAS,
  type FacilitatorAck,
  type FacilitatorClientToServer,
  type FacilitatorCommand,
  type FacilitatorMessage,
  type FacilitatorResult,
  type FacilitatorResults,
  type FacilitatorServerToClient,
  type FakePlayerPace,
  LIVE_TELEMETRY_TYPES,
  PLAYER_SCHEMAS,
  type PlayerAcks,
  type PlayerClientToServer,
  type PlayerMessage,
  type PlayerRequest,
  type PlayerServerToClient,
  parseSessionConfig,
  parseTelemetryItem,
  playerView,
  REDACTED_EVENT_TYPES,
  type Scenario,
  type SeatLiveStats,
  type SeatMicStats,
  type ServerSide,
  type SessionConfig,
  type StoredEvent,
  type StoredTelemetry,
  seatList,
  type TelemetryItem,
  type TerminalInfo,
} from "@wkwa/shared";
import type { Logger } from "pino";
import type { Namespace, Server, Socket } from "socket.io";
import type { ZodType, z } from "zod";
import { loadOnboardingContent, type ScenarioLibrary } from "../content";
import { getMeta } from "../db/database";
import type { Store } from "../db/store";
import type { SessionStores } from "../db/stores";
import { FakePlayers } from "../fake/FakePlayers";
import { nowTs } from "../runtime";
import { CommandError, SessionManager } from "../session/SessionManager";
import { SimulationRunner } from "../simulation/SimulationRunner";

interface TerminalEntry {
  terminal: number;
  sockets: Set<PlayerSocket>;
}

interface PlayerSocketData {
  terminalKey?: string;
  terminal?: number;
  seat?: number | null;
}

/**
 * The two namespaces, typed with the shared event maps (socket.ts): every emit and every
 * listener is checked by the compiler, and incoming payloads stay `unknown` until validated.
 */
type NoServerSideEvents = Record<string, never>;
type PlayerNamespace = Namespace<
  ServerSide<PlayerClientToServer>,
  PlayerServerToClient,
  NoServerSideEvents,
  PlayerSocketData
>;
type PlayerSocket = Socket<
  ServerSide<PlayerClientToServer>,
  PlayerServerToClient,
  NoServerSideEvents,
  PlayerSocketData
>;
type FacilitatorNamespace = Namespace<
  ServerSide<FacilitatorClientToServer>,
  FacilitatorServerToClient,
  NoServerSideEvents,
  Record<string, never>
>;
type FacilitatorSocket = Socket<
  ServerSide<FacilitatorClientToServer>,
  FacilitatorServerToClient,
  NoServerSideEvents,
  Record<string, never>
>;

/**
 * The schema of a message, typed by its name. TypeScript cannot narrow an index into the schema
 * table by a generic key, so this is the one place that states the link (the table itself is
 * checked against the catalogue and the event maps in @wkwa/shared).
 */
function playerSchema<K extends PlayerRequest>(name: K): ZodType<PlayerMessage<K>> {
  return PLAYER_SCHEMAS[name] as unknown as ZodType<PlayerMessage<K>>;
}
function facilitatorSchema<K extends FacilitatorCommand>(name: K): ZodType<FacilitatorMessage<K>> {
  return FACILITATOR_SCHEMAS[name] as unknown as ZodType<FacilitatorMessage<K>>;
}

/** Latest `audio:level` of a seat (volatile: never stored). */
type MicLevelReading = z.output<typeof AudioLevel>;

export interface HubDeps {
  io: Server;
  /** Participant and simulation databases; each session lives in exactly one. */
  stores: SessionStores;
  scenarios: ScenarioLibrary;
  configDir: string;
  log: Logger;
  adminToken: string | null;
  /** This server's own URL once it listens; fake players connect to it. */
  selfUrl: () => Promise<string>;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function isLoopback(address: string | undefined): boolean {
  return address !== undefined && LOOPBACK.has(address);
}

export function tokenMatches(given: unknown, expected: string | null): boolean {
  if (!expected || typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function emptyStats(seat: number): SeatLiveStats {
  return {
    seat,
    focused: null,
    visible: null,
    idle: false,
    rttMs: null,
    offsetMs: null,
    hoverRegionId: null,
    screen: null,
    telemetryCount: 0,
    lastTelemetryTs: null,
  };
}

/** Facilitator-visible copy of an event: demographic answers are never shown live. */
export function redactEvent(ev: StoredEvent): StoredEvent {
  if (!REDACTED_EVENT_TYPES.has(ev.type)) return ev;
  return { ...ev, payload: { ...(ev.payload as object), answers: "[redacted]" } } as unknown as StoredEvent;
}

/**
 * The hub in hub-and-spoke: every message between players passes through
 * here. It owns the socket namespaces, the terminal registry and the active
 * SessionManager, and fans state out to each recipient as a projection.
 */
export class Hub {
  session: SessionManager | null = null;
  /** Plays the agents while a simulated session is attached. */
  private runner: SimulationRunner | null = null;
  /** Fake players (test clients) of the attached real session. */
  private readonly fakes: FakePlayers;
  private terminals = new Map<string, TerminalEntry>();
  private nextTerminal = 1;
  private seatSockets = new Map<number, PlayerSocket>();
  private stats = new Map<number, SeatLiveStats>();
  private micLevels = new Map<number, MicLevelReading>();
  private liveTelemetry: StoredTelemetry[] = [];
  private statsTimer: NodeJS.Timeout | null = null;
  readonly player: PlayerNamespace;
  readonly facilitator: FacilitatorNamespace;
  private readonly secret: string;

  constructor(private readonly deps: HubDeps) {
    // seat tokens only exist for real participants, so the participant database's secret signs them
    this.secret = getMeta(deps.stores.real.db, "server_secret") ?? "";
    if (!this.secret) throw new Error("Database has no server secret");
    this.fakes = new FakePlayers({ selfUrl: deps.selfUrl, log: deps.log });
    // the server is created untyped (two namespaces, two event maps); each namespace gets its map here
    this.player = deps.io.of("/player") as unknown as PlayerNamespace;
    this.facilitator = deps.io.of("/facilitator") as unknown as FacilitatorNamespace;
    this.facilitator.use((socket, next) => {
      if (
        isLoopback(socket.handshake.address) ||
        tokenMatches(socket.handshake.auth?.token, deps.adminToken)
      ) {
        return next();
      }
      next(new Error("unauthorised"));
    });
    this.player.on("connection", (s) => this.onPlayer(s));
    this.facilitator.on("connection", (s) => this.onFacilitator(s));
  }

  /* ═════════════════════════ sessions ═════════════════════════ */

  /** The database of the attached session (participant database when none is attached). */
  private get store(): Store {
    return this.session?.store ?? this.deps.stores.real;
  }

  /**
   * What a SessionManager needs, for a new config or a stored one (`config_json`). Throws a
   * CommandError if that config or the onboarding content cannot be loaded (e.g. consent.json lost
   * its audio item), before anything changed: the attached session stays as it is.
   */
  private sessionDeps(scenario: Scenario, store: Store, config: SessionConfig | string) {
    let onboarding: ReturnType<typeof loadOnboardingContent>;
    try {
      const parsed = typeof config === "string" ? parseSessionConfig(JSON.parse(config)) : config;
      // composed for the session: the consent form has its audio section and item only with audio
      onboarding = loadOnboardingContent(this.deps.configDir, { audio: audioEnabled(parsed) });
    } catch (e) {
      throw new CommandError((e as Error).message);
    }
    return {
      store,
      scenario,
      onboarding,
      serverSecret: this.secret,
      log: this.deps.log,
      onEvents: (evs: StoredEvent[]) => this.onEvents(evs),
    };
  }

  createSession(scenarioId: string, config: SessionConfig, notes: string): SessionManager {
    const scenario = this.deps.scenarios.load(scenarioId);
    const deps = this.sessionDeps(scenario, this.deps.stores.of(config.players), config);
    this.detach("A new session was created");
    // this.session is null while creating, so the SessionCreated batch is delivered by afterAttach()
    const created = SessionManager.create(deps, config, notes);
    this.session = created;
    this.deps.log.info(
      { sessionId: created.sessionId, scenario: scenario.id, players: config.players },
      "session created",
    );
    this.afterAttach();
    return created;
  }

  resumeSession(sessionId: string): SessionManager {
    const found = this.deps.stores.find(sessionId);
    if (!found) throw new CommandError(`Unknown session ${sessionId}`);
    const scenario = this.deps.scenarios.load(found.row.scenario_id);
    const deps = this.sessionDeps(scenario, found.store, found.row.config_json);
    this.detach("Switching session");
    const m = SessionManager.load(deps, sessionId);
    this.session = m;
    this.deps.log.info({ sessionId }, "session resumed");
    this.afterAttach();
    return m;
  }

  /** Resume the most recent session (of either database) that has not ended (used on server start). */
  autoResume() {
    const s = this.deps.stores.latestUnfinished();
    if (s) {
      try {
        this.resumeSession(s.id);
      } catch (e) {
        this.deps.log.error({ err: e, sessionId: s.id }, "auto-resume failed");
      }
    }
  }

  private detach(reason: string) {
    this.runner?.dispose();
    this.runner = null;
    this.dropFakes();
    if (!this.session) return;
    // its tracks end here (`interrupted`); a browser's late chunks are accepted when it is loaded again
    try {
      this.session.closeAudioTracks("interrupted");
    } catch (e) {
      this.deps.log.error({ err: e }, "could not close the audio tracks");
    }
    this.session.dispose();
    this.session = null;
    for (const [, sock] of this.seatSockets) {
      sock.emit("unbound", { reason });
      sock.data.seat = null;
    }
    this.seatSockets.clear();
    this.stats.clear();
    this.micLevels.clear();
    this.liveTelemetry = [];
  }

  private afterAttach() {
    const m = this.session!;
    for (const s of Object.values(m.state.seats)) this.stats.set(s.seat, emptyStats(s.seat));
    // Connected browsers re-send hello with their stored seat token, so seats are re-claimed
    // by token only (terminal numbers are not stable across server restarts).
    this.player.emit("rehello");
    this.facilitator.emit("scenario", m.scenario);
    this.facilitator.emit("events", {
      events: this.store.listEvents(m.sessionId).map(redactEvent),
      reset: true,
    });
    this.facilitator.emit("telemetry:live", { items: [], reset: true });
    this.pushAll();
    if (m.simulated) {
      this.runner = new SimulationRunner(m, this.deps.log);
      this.runner.sync();
    }
    this.restoreFakes(m);
  }

  /* ═════════════════════════ fake players ═════════════════════════ */

  /**
   * Real sessions, lobby only: start a fake player for each seat (default:
   * every unbound seat) and bind it. Each one connects over the network like a
   * browser; its seat is logged with `fake: true`, gets no participant code and
   * skips onboarding.
   */
  async addFakePlayers(seatsIn: number[] | null, pace: FakePlayerPace): Promise<{ seats: number[] }> {
    const m = this.session;
    if (!m) throw new CommandError("No active session");
    if (m.simulated) {
      throw new CommandError(
        "Fake players are for sessions with real players; a simulated session already has an agent in every seat",
      );
    }
    if (m.state.phase !== "lobby") {
      throw new CommandError(
        "Fake players can only be added in the lobby (setup step 07), before onboarding",
      );
    }
    const free = seatList(m.state)
      .filter((s) => !s.bound)
      .map((s) => s.seat);
    const seats = seatsIn ?? free;
    if (seats.length === 0) throw new CommandError("Every seat is already bound");
    for (const seat of seats) {
      if (!m.state.seats[seat]) throw new CommandError(`Seat ${seat} does not exist in this session`);
      if (!free.includes(seat)) throw new CommandError(`Seat ${seat} is already bound; unbind it first`);
    }
    // connect them all at once, then bind in seat order
    const bots = await Promise.all(seats.map((seat) => this.fakes.spawn({ pace, seat })));
    const terminals = await Promise.allSettled(bots.map((b) => b.waitForTerminal(5000)));
    const added: number[] = [];
    let failed = false;
    seats.forEach((seat, i) => {
      const bot = bots[i]!;
      const t = terminals[i]!;
      // the session may have changed while the fake players were connecting
      const stale = this.session !== m || m.state.phase !== "lobby" || m.state.seats[seat]?.bound;
      if (t.status === "rejected" || stale) {
        failed ||= t.status === "rejected";
        this.dropFake(bot.terminalKey);
        return;
      }
      this.bindTerminal(t.value, seat, pace);
      added.push(seat);
    });
    if (failed && added.length === 0)
      throw new CommandError("A fake player could not connect to this server");
    this.deps.log.info({ sessionId: m.sessionId, seats: added, pace }, "fake players added");
    return { seats: added };
  }

  /**
   * After a resume or restart, start the fake players of the session again
   * (at the pace logged in their SeatBound); they re-claim their seats by token.
   */
  private restoreFakes(m: SessionManager) {
    if (m.isFinal || m.state.phase === "game_complete") return;
    for (const s of seatList(m.state)) {
      if (!s.bound || !s.fake || s.withdrawn) continue;
      const opts = {
        pace: s.fakePace ?? "normal",
        seat: s.seat,
        seatToken: m.seatToken(s.seat),
        clientSeqStart: m.nextClientSeq(s.seat) - 1,
      };
      void this.deps
        .selfUrl()
        .then(() => {
          if (this.session === m && !m.isFinal) return this.fakes.spawn(opts);
        })
        .catch((e) => this.deps.log.error({ err: e, seat: s.seat }, "could not restore fake player"));
    }
  }

  private dropFake(terminalKey: string) {
    this.fakes.stop(terminalKey);
    this.terminals.delete(terminalKey);
  }

  private dropFakes() {
    for (const key of this.terminals.keys()) if (this.fakes.isFake(key)) this.terminals.delete(key);
    this.fakes.stopAll();
  }

  /**
   * Bind a connected client to a seat. Only clients whose key the server
   * registered itself (FakePlayers) are bound as fake; a browser never can be.
   */
  private bindTerminal(terminal: number, seat: number, fakePace?: FakePlayerPace) {
    const m = this.session;
    if (!m) throw new CommandError("No active session");
    const [key, entry] =
      [...this.terminals].find(([, t]) => t.terminal === terminal && t.sockets.size > 0) ?? [];
    if (!key || !entry) throw new CommandError(`Client ${terminal} is not connected`);
    const seated = [...entry.sockets].map((x) => x.data.seat).find((x) => x);
    if (seated && seated !== seat) throw new CommandError(`Client ${terminal} is already seat ${seated}`);
    return m.bindSeat(terminal, seat, { fake: this.fakes.isFake(key), fakePace });
  }

  /* ═════════════════════════ fan-out ═════════════════════════ */

  private onEvents(events: StoredEvent[]) {
    const m = this.session;
    if (!m) return;
    for (const ev of events) {
      if (ev.type === "SeatBound") {
        const entry = [...this.terminals.values()].find((t) => t.terminal === ev.payload.terminal);
        const sock = entry ? [...entry.sockets].at(-1) : undefined;
        if (sock) queueMicrotask(() => this.claimSeat(sock, ev.payload.seat));
      }
      // the mic meter of a seat that is no longer recorded goes blank
      if (ev.type === "SeatUnbound" || ev.type === "ParticipantWithdrawn" || ev.type === "MicCheckSkipped")
        this.micLevels.delete(ev.payload.seat);
      if (ev.type === "SeatUnbound") {
        const sock = this.seatSockets.get(ev.payload.seat);
        const key = sock ? sock.data.terminalKey : undefined;
        if (sock && key && this.fakes.isFake(key)) {
          // a fake player only exists for its seat: unbinding it ends it
          this.seatSockets.delete(ev.payload.seat);
          this.dropFake(key);
        } else if (sock) {
          sock.emit("unbound", { reason: ev.payload.reason });
          sock.data.seat = null;
          this.seatSockets.delete(ev.payload.seat);
          // a seated socket has sent hello, so it has a client number
          if (sock.data.terminal !== undefined) sock.emit("terminal", { terminal: sock.data.terminal });
        }
      }
    }
    this.facilitator.emit("events", { events: events.map(redactEvent), reset: false });
    // closed or aborted: nothing left for fake players to do
    if (m.isFinal) this.dropFakes();
    if (this.runner) {
      // agents can act many times a second: send the full dashboard at most every 100 ms
      this.pushPlayers();
      this.schedulePush(100);
    } else this.pushAll();
    // agents react to the new state (a round started, the game paused, …)
    this.runner?.sync();
  }

  private pushAll() {
    this.pushPlayers();
    this.pushDashboard();
  }

  private pushPlayers() {
    const m = this.session;
    if (!m) return;
    const now = nowTs();
    for (const [seat, sock] of this.seatSockets) {
      try {
        sock.emit("state", playerView(m.state, m.scenario, seat, m.onboarding, now));
      } catch (e) {
        this.deps.log.error({ err: e, seat }, "projection failed");
      }
    }
  }

  dashboard(): DashboardMsg {
    const m = this.session;
    const terminals: TerminalInfo[] = [...this.terminals]
      .map(([key, t]) => {
        const seated = [...t.sockets].map((x) => x.data.seat).find((x) => x);
        return {
          terminal: t.terminal,
          connected: t.sockets.size > 0,
          seat: seated ?? null,
          fake: this.fakes.isFake(key),
        };
      })
      .filter((t) => t.connected || t.seat !== null)
      .sort((a, b) => a.terminal - b.terminal);
    const stats: Record<number, SeatLiveStats> = {};
    for (const [seat, st] of this.stats)
      stats[seat] = m?.state.audio.enabled ? { ...st, mic: this.micStats(m, seat) } : st;
    return {
      state: m?.state ?? null,
      serverTs: nowTs(),
      terminals,
      stats,
      live: Boolean(m && !m.isFinal),
    };
  }

  /** LIVE mic figures of a seat: the browser's latest meter reading plus what the server stored. */
  private micStats(m: SessionManager, seat: number): SeatMicStats {
    const level = this.micLevels.get(seat);
    const stored = m.audio.seatStats(seat);
    return {
      state: level?.state ?? "idle",
      rmsDb: level?.rmsDb ?? AUDIO_SILENCE_DB,
      peakDb: level?.peakDb ?? AUDIO_SILENCE_DB,
      lastChunkServerTs: stored.lastChunkServerTs,
      pendingChunks: level?.pendingChunks ?? 0,
      tracks: stored.tracks,
      recordedMs: Math.round(stored.recordedMs),
    };
  }

  private pushDashboard() {
    if (this.statsTimer) clearTimeout(this.statsTimer);
    this.statsTimer = null;
    this.facilitator.emit("dashboard", this.dashboard());
  }

  /** Throttled dashboard refresh (telemetry-driven stats changes; agents' actions). */
  private schedulePush(ms = 1000) {
    if (this.statsTimer) return;
    this.statsTimer = setTimeout(() => {
      this.statsTimer = null;
      this.facilitator.emit("dashboard", this.dashboard());
    }, ms);
  }

  /* ═════════════════════════ players ═════════════════════════ */

  private claimSeat(sock: PlayerSocket, seat: number) {
    const m = this.session;
    const seatToken = m?.seatToken(seat);
    // no token: the seat is not bound (any more), so there is nothing to claim
    if (!m || !seatToken || !sock.connected) return;
    const prev = this.seatSockets.get(seat);
    if (prev && prev !== sock) {
      prev.emit("unbound", { reason: "This seat was opened in another window" });
      prev.data.seat = null;
    }
    this.seatSockets.set(seat, sock);
    sock.data.seat = seat;
    sock.emit("bound", { seat, sessionId: m.sessionId, seatToken });
    const before = m.state.lastSeq;
    m.playerConnected(seat);
    if (m.state.lastSeq === before) this.pushAll(); // no event was appended → push manually
  }

  private onPlayer(sock: PlayerSocket) {
    const data = sock.data;
    const helloTimeout = setTimeout(() => {
      if (data.terminal === undefined) sock.disconnect(true);
    }, 15_000);

    sock.on("hello", (raw, ack) => {
      const msg = PLAYER_SCHEMAS.hello.safeParse(raw);
      if (!msg.success) return ack?.({ ok: false, error: "bad hello" });
      clearTimeout(helloTimeout);
      let entry = this.terminals.get(msg.data.terminalKey);
      if (!entry) {
        entry = { terminal: this.nextTerminal++, sockets: new Set() };
        this.terminals.set(msg.data.terminalKey, entry);
      }
      entry.sockets.add(sock);
      data.terminalKey = msg.data.terminalKey;
      data.terminal = entry.terminal;
      data.seat = null;
      const seat = this.session?.seatForToken(msg.data.seatToken) ?? null;
      ack?.({ ok: true, terminal: entry.terminal, seat });
      if (seat !== null) this.claimSeat(sock, seat);
      else {
        sock.emit("terminal", { terminal: entry.terminal });
        this.pushDashboard();
      }
    });

    sock.on("clock:ping", (raw, ack) => {
      const msg = PLAYER_SCHEMAS["clock:ping"].safeParse(raw);
      if (msg.success) ack?.({ t0: msg.data.t0, serverTs: nowTs() });
    });

    /**
     * A seated player's request: refused when the socket holds no seat or the payload is invalid
     * (validated with the message's schema from PLAYER_SCHEMAS); `fn` may be async. `refuse` builds
     * the refusal ack (`retry`: the player may send it again).
     */
    const seatHandler = <K extends PlayerRequest>(
      name: K,
      fn: (m: SessionManager, seat: number, msg: PlayerMessage<K>) => PlayerAcks[K] | Promise<PlayerAcks[K]>,
      refuse: (error: string, retry: boolean) => PlayerAcks[K],
    ) => {
      const schema = playerSchema(name);
      const handler = async (raw: unknown, ack?: (a: PlayerAcks[K]) => void) => {
        const m = this.session;
        const seat = data.seat;
        if (!m || seat === null || seat === undefined) return ack?.(refuse("Not seated", true));
        const msg = schema.safeParse(raw);
        if (!msg.success)
          return ack?.(refuse(`Invalid message: ${msg.error.issues[0]?.message ?? ""}`, false));
        try {
          ack?.(await fn(m, seat, msg.data));
        } catch (e) {
          if (e instanceof CommandError) return ack?.(refuse(e.message, false));
          this.deps.log.error({ err: e, msg: name }, "player command failed");
          ack?.(refuse("Server error", true));
        }
      };
      // Socket.IO's listener type cannot follow a generic name. `handler` has the shape that
      // ServerSide<PlayerClientToServer> gives K (both come from PlayerAcks), so `never` only stands in for that.
      sock.on(name, handler as never);
    };

    /** A request whose refusals are `Refusal`s; a command returning nothing acks `{ ok: true }`. */
    const seatCmd = <K extends PlayerRequest>(
      name: K,
      fn: (m: SessionManager, seat: number, msg: PlayerMessage<K>) => PlayerAcks[K] | undefined,
    ) =>
      seatHandler(
        name,
        (m, seat, msg) => fn(m, seat, msg) ?? ({ ok: true } as PlayerAcks[K]),
        (error, retry) => ({ ok: false, error, retry }) as PlayerAcks[K],
      );

    /**
     * Audio uploads: every refusal says whether to retry (AudioAck). Not seated (e.g. right after a
     * reconnect, before hello) is transient; a bad payload is permanent.
     */
    const audioCmd = <K extends "audio:start" | "audio:chunk" | "audio:stop">(
      name: K,
      fn: (m: SessionManager, seat: number, msg: PlayerMessage<K>) => PlayerAcks[K] | Promise<PlayerAcks[K]>,
    ) => seatHandler(name, fn, (error, retry) => ({ ok: false, error, retry }));

    const done = undefined; // a command that returns nothing: acked { ok: true }
    seatCmd("consent:submit", (m, seat, msg) => {
      m.submitConsent(seat, msg);
      return done;
    });
    seatCmd("mic:check", (m, seat, msg) => {
      m.submitMicCheck(seat, msg);
      return done;
    });
    audioCmd("audio:start", (m, seat, msg) => m.audio.start(seat, msg));
    audioCmd("audio:chunk", async (m, seat, msg) => {
      const a = await m.audio.chunk(seat, msg);
      // a stored chunk changes the LIVE mic column (throttled); start and stop push through their events
      if (a.ok && !a.duplicate && this.session === m) this.schedulePush();
      return a;
    });
    audioCmd("audio:stop", (m, seat, msg) => m.audio.stop(seat, msg));
    seatCmd("demographics:submit", (m, seat, msg) => {
      m.submitDemographics(seat, msg);
      return done;
    });
    seatCmd("briefing:ack", (m, seat, msg) => {
      m.acknowledgeBriefing(seat, msg);
      return done;
    });
    seatCmd("intent", (m, seat, msg) => m.intent(seat, msg));
    seatCmd("telemetry", (m, seat, msg) => ({ stored: this.ingestTelemetry(m, seat, msg) }));

    sock.on("presence", (raw) => {
      const seat = data.seat;
      const msg = PLAYER_SCHEMAS.presence.safeParse(raw);
      if (!msg.success || !seat) return;
      const st = this.stats.get(seat);
      if (st) st.hoverRegionId = msg.data.regionId;
      this.facilitator.volatile.emit("presence:live", { seat, regionId: msg.data.regionId });
    });

    // volatile meter reading for LIVE: never stored, dropped for seats that are not recorded
    sock.on("audio:level", (raw) => {
      const m = this.session;
      const seat = data.seat;
      if (!m || !seat || m.audio.refusal(seat) !== null) return;
      const msg = PLAYER_SCHEMAS["audio:level"].safeParse(raw);
      if (!msg.success) return;
      this.micLevels.set(seat, msg.data);
      this.schedulePush();
    });

    sock.on("disconnect", (reason) => {
      clearTimeout(helloTimeout);
      if (data.terminalKey) this.terminals.get(data.terminalKey)?.sockets.delete(sock);
      const seat = data.seat;
      if (seat && this.seatSockets.get(seat) === sock) {
        this.seatSockets.delete(seat);
        this.micLevels.delete(seat);
        const st = this.stats.get(seat);
        if (st) st.hoverRegionId = null;
        this.session?.playerDisconnected(seat, reason);
      }
      this.pushDashboard();
    });
  }

  private ingestTelemetry(
    m: SessionManager,
    seat: number,
    msg: { clockOffsetMs: number; items: unknown[] },
  ): number {
    const seatState = m.state.seats[seat];
    const code = seatState?.participantCode;
    if (!code || m.isFinal) return 0;
    // No interaction telemetry is stored before the participant has consented.
    if (seatState.consent !== "given" && seatState.consent !== "skipped") return 0;
    const items: TelemetryItem[] = [];
    for (const raw of msg.items) {
      const it = parseTelemetryItem(raw);
      if (it) items.push(it);
    }
    if (items.length === 0) return 0;
    const stored = this.store.insertTelemetry(
      m.sessionId,
      seat,
      code,
      m.state.round,
      msg.clockOffsetMs,
      items,
    );
    const st = this.stats.get(seat) ?? emptyStats(seat);
    this.stats.set(seat, st);
    st.telemetryCount += stored.length;
    st.lastTelemetryTs = nowTs();
    for (const it of items) {
      if (it.type === "focus_change") st.focused = it.payload.focused;
      else if (it.type === "visibility_change") st.visible = it.payload.visible;
      else if (it.type === "idle") st.idle = it.payload.state === "start";
      else if (it.type === "clock_sync") {
        st.rttMs = it.payload.rttMs;
        st.offsetMs = it.payload.offsetMs;
      } else if (it.type === "screen_view") st.screen = it.payload.screen;
    }
    const live = stored.filter((t) => LIVE_TELEMETRY_TYPES.has(t.type));
    if (live.length) {
      this.liveTelemetry.push(...live);
      if (this.liveTelemetry.length > 500) this.liveTelemetry.splice(0, this.liveTelemetry.length - 500);
      this.facilitator.emit("telemetry:live", { items: live, reset: false });
    }
    this.schedulePush();
    return stored.length;
  }

  /* ═════════════════════════ facilitator ═════════════════════════ */

  private onFacilitator(sock: FacilitatorSocket) {
    const m = this.session;
    sock.emit("scenario", m?.scenario ?? null);
    sock.emit("events", {
      events: m ? this.store.listEvents(m.sessionId).map(redactEvent) : [],
      reset: true,
    });
    sock.emit("telemetry:live", { items: this.liveTelemetry, reset: true });
    sock.emit("dashboard", this.dashboard());

    /**
     * A facilitator command: the payload is validated with the command's schema from
     * FACILITATOR_SCHEMAS, then `fn` runs (it may be async: fake:add waits for network clients).
     */
    const cmd = <K extends FacilitatorCommand>(
      name: K,
      fn: (msg: FacilitatorMessage<K>) => FacilitatorResult<K> | Promise<FacilitatorResult<K>>,
      needsSession = true,
    ) => {
      const schema = facilitatorSchema(name);
      const handler = (raw: unknown, ack?: (a: FacilitatorAck<K>) => void) => {
        const msg = schema.safeParse(raw ?? {});
        if (!msg.success)
          return ack?.({ ok: false, error: `Invalid message: ${msg.error.issues[0]?.message ?? ""}` });
        if (needsSession && !this.session) return ack?.({ ok: false, error: "No active session" });
        const fail = (e: unknown) => {
          if (e instanceof CommandError) return ack?.({ ok: false, error: e.message });
          this.deps.log.error({ err: e, msg: name }, "facilitator command failed");
          ack?.({ ok: false, error: (e as Error).message ?? "Server error" });
        };
        try {
          const data = fn(msg.data);
          if (data instanceof Promise) data.then((d) => ack?.({ ok: true, data: d }), fail);
          else ack?.({ ok: true, data });
        } catch (e) {
          fail(e);
        }
      };
      // Socket.IO's listener type cannot follow a generic name (see seatHandler in onPlayer)
      sock.on(name, handler as never);
    };
    const s = () => this.session!;
    /** A command that answers with no data (whatever the session's method returns is not sent). */
    const act = <K extends Exclude<FacilitatorCommand, keyof FacilitatorResults>>(
      name: K,
      fn: (msg: FacilitatorMessage<K>) => unknown,
    ) =>
      cmd(name, (msg) => {
        fn(msg);
        // FacilitatorResult<K> is `undefined` for every K without a result; TypeScript cannot resolve it for a generic K
        return undefined as FacilitatorResult<K>;
      });

    cmd(
      "session:create",
      (msg) => ({ sessionId: this.createSession(msg.scenarioId, msg.config, msg.notes).sessionId }),
      false,
    );
    cmd("session:resume", (msg) => ({ sessionId: this.resumeSession(msg.sessionId).sessionId }), false);
    cmd("seat:bind", (msg) => this.bindTerminal(msg.terminal, msg.seat));
    cmd("fake:add", (msg) => this.addFakePlayers(msg.seats, msg.pace));
    act("seat:unbind", (msg) => s().unbindSeat(msg.seat, msg.reason));
    act("labels:set", (msg) => s().setLabels(msg.assignments, msg.pairing));
    act("labels:randomise", (msg) => s().randomiseLabels(msg.pairing, msg.shuffleK));
    act("onboarding:start", () => s().startOnboarding());
    act("simulation:start", () => s().startSimulation());
    act("round:start", () => s().startRound("facilitator"));
    act("round:end", () => s().endRound());
    act("game:pause", () => s().pause());
    act("game:resume", () => s().resume());
    act("action:revoke", (msg) => s().revoke(msg.seq, msg.reason));
    act("broadcast", (msg) => s().broadcast(msg.text));
    act("note", (msg) => s().note(msg.text));
    act("participant:withdraw", (msg) => s().withdraw(msg.seat));
    act("game:end", () => s().endGame());
    act("session:close", () => s().close());
    act("session:abort", (msg) => s().abort(msg.reason));
    act("mic:skip", (msg) => s().skipMicCheck(msg.seat, msg.reason));
    act("calibration:start", () => s().startCalibration(false));
    act("calibration:redo", () => s().startCalibration(true));
    act("calibration:skip", (msg) => s().skipCalibration(msg.reason));
    act("recording:pause", (msg) => s().pauseRecording(msg.reason));
    act("recording:resume", () => s().resumeRecording());
  }

  /** Detach a session (e.g. before deleting it); connected players return to the waiting screen. */
  release(sessionId: string) {
    if (this.session?.sessionId !== sessionId) return;
    this.detach("The session was deleted");
    this.facilitator.emit("scenario", null);
    this.facilitator.emit("events", { events: [], reset: true });
    this.facilitator.emit("telemetry:live", { items: [], reset: true });
    this.pushDashboard();
  }

  /** Called after an erasure changed stored events of the attached session. */
  reloadActiveSession() {
    const m = this.session;
    if (!m) return;
    this.resumeSession(m.sessionId);
  }

  close() {
    this.runner?.dispose();
    this.dropFakes();
    this.session?.dispose();
    if (this.statsTimer) clearTimeout(this.statsTimer);
  }
}
