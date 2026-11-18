import { timingSafeEqual } from "node:crypto";
import {
  AbortMsg,
  type Ack,
  ActionRevoke,
  AUDIO_SILENCE_DB,
  type AudioAck,
  AudioChunk,
  AudioLevel,
  AudioStart,
  AudioStop,
  BriefingAck,
  BroadcastMsg,
  CalibrationSkip,
  ClockPing,
  ConsentSubmit,
  type DashboardMsg,
  DemographicsSubmit,
  Empty,
  FakeAdd,
  type FakePlayerPace,
  IntentMsg,
  LabelsRandomise,
  LabelsSet,
  LIVE_TELEMETRY_TYPES,
  MicCheckSubmit,
  type MicLevelState,
  MicSkip,
  micCheckApplies,
  NoteMsg,
  normaliseForPlayers,
  PlayerHello,
  Presence,
  parseSessionConfig,
  parseTelemetryItem,
  playerView,
  REDACTED_EVENT_TYPES,
  RecordingPause,
  type Scenario,
  SeatBind,
  type SeatLiveStats,
  type SeatMicStats,
  SeatUnbind,
  type SessionConfig,
  SessionCreate,
  SessionResume,
  type StoredEvent,
  type StoredTelemetry,
  seatList,
  TelemetryBatch,
  type TelemetryItem,
  type TerminalInfo,
  WithdrawMsg,
} from "@wkwa/shared";
import type { Logger } from "pino";
import type { Namespace, Server, Socket } from "socket.io";
import type { ZodType } from "zod";
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
  sockets: Set<Socket>;
}

interface PlayerSocketData {
  terminalKey?: string;
  terminal?: number;
  seat?: number | null;
}

/** Latest `audio:level` of a seat (volatile: never stored). */
interface MicLevelReading {
  state: MicLevelState;
  rmsDb: number;
  peakDb: number;
  pendingChunks: number;
}

/** Does a session with this config record audio? (Never a simulated one.) */
function recordsAudio(config: unknown): boolean {
  return normaliseForPlayers(parseSessionConfig(config)).audio.enabled;
}

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
  private seatSockets = new Map<number, Socket>();
  private stats = new Map<number, SeatLiveStats>();
  private micLevels = new Map<number, MicLevelReading>();
  private liveTelemetry: StoredTelemetry[] = [];
  private statsTimer: NodeJS.Timeout | null = null;
  readonly player: Namespace;
  readonly facilitator: Namespace;
  private readonly secret: string;

  constructor(private readonly deps: HubDeps) {
    // seat tokens only exist for real participants, so the participant database's secret signs them
    this.secret = getMeta(deps.stores.real.db, "server_secret") ?? "";
    if (!this.secret) throw new Error("Database has no server secret");
    this.fakes = new FakePlayers({ selfUrl: deps.selfUrl, log: deps.log });
    this.player = deps.io.of("/player");
    this.facilitator = deps.io.of("/facilitator");
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

  private sessionDeps(scenario: Scenario, store: Store, audio: boolean) {
    return {
      store,
      scenario,
      // composed for the session: the consent form has its audio section and item only with audio
      onboarding: loadOnboardingContent(this.deps.configDir, { audio }),
      serverSecret: this.secret,
      log: this.deps.log,
      onEvents: (evs: StoredEvent[]) => this.onEvents(evs),
    };
  }

  createSession(scenarioId: string, config: SessionConfig, notes: string): SessionManager {
    const scenario = this.deps.scenarios.load(scenarioId);
    const store = this.deps.stores.of(config.players);
    let deps: ReturnType<Hub["sessionDeps"]>;
    try {
      deps = this.sessionDeps(scenario, store, recordsAudio(config));
    } catch (e) {
      throw new CommandError((e as Error).message);
    }
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
    let deps: ReturnType<Hub["sessionDeps"]>;
    try {
      deps = this.sessionDeps(scenario, found.store, recordsAudio(JSON.parse(found.row.config_json)));
    } catch (e) {
      // e.g. consent.json lost its audio item: keep the attached session as it is
      throw new CommandError((e as Error).message);
    }
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
      (sock.data as PlayerSocketData).seat = null;
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
    const seated = [...entry.sockets].map((x) => (x.data as PlayerSocketData).seat).find((x) => x);
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
        const key = sock ? (sock.data as PlayerSocketData).terminalKey : undefined;
        if (sock && key && this.fakes.isFake(key)) {
          // a fake player only exists for its seat: unbinding it ends it
          this.seatSockets.delete(ev.payload.seat);
          this.dropFake(key);
        } else if (sock) {
          sock.emit("unbound", { reason: ev.payload.reason });
          (sock.data as PlayerSocketData).seat = null;
          this.seatSockets.delete(ev.payload.seat);
          sock.emit("terminal", { terminal: (sock.data as PlayerSocketData).terminal });
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
        const seated = [...t.sockets].map((x) => (x.data as PlayerSocketData).seat).find((x) => x);
        return {
          terminal: t.terminal,
          connected: t.sockets.size > 0,
          seat: seated ?? null,
          fake: this.fakes.isFake(key),
        };
      })
      .filter((t) => t.connected || t.seat !== null)
      .sort((a, b) => a.terminal - b.terminal);
    const audio = m?.state.audio.enabled ? m.state.audio : undefined;
    const stats: Record<number, SeatLiveStats> = {};
    for (const [seat, st] of this.stats)
      stats[seat] = audio && m ? { ...st, mic: this.micStats(m, seat) } : st;
    return {
      state: m?.state ?? null,
      serverTs: nowTs(),
      terminals,
      stats,
      live: Boolean(m && !m.isFinal),
      ...(audio ? { audio } : {}),
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

  private claimSeat(sock: Socket, seat: number) {
    const m = this.session;
    if (!m || !sock.connected) return;
    const prev = this.seatSockets.get(seat);
    if (prev && prev !== sock) {
      prev.emit("unbound", { reason: "This seat was opened in another window" });
      (prev.data as PlayerSocketData).seat = null;
    }
    this.seatSockets.set(seat, sock);
    (sock.data as PlayerSocketData).seat = seat;
    sock.emit("bound", { seat, sessionId: m.sessionId, seatToken: m.seatToken(seat) });
    const before = m.state.lastSeq;
    m.playerConnected(seat);
    if (m.state.lastSeq === before) this.pushAll(); // no event was appended → push manually
  }

  private onPlayer(sock: Socket) {
    const data = sock.data as PlayerSocketData;
    const helloTimeout = setTimeout(() => {
      if (data.terminal === undefined) sock.disconnect(true);
    }, 15_000);

    sock.on("hello", (raw, ack?: (a: unknown) => void) => {
      const msg = PlayerHello.safeParse(raw);
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

    sock.on("clock:ping", (raw, ack?: (a: unknown) => void) => {
      const msg = ClockPing.safeParse(raw);
      if (msg.success) ack?.({ t0: msg.data.t0, serverTs: nowTs() });
    });

    const seatCmd = <T>(
      name: string,
      schema: ZodType<T>,
      fn: (m: SessionManager, seat: number, msg: T) => unknown,
    ) => {
      sock.on(name, (raw, ack?: (a: Ack | unknown) => void) => {
        const m = this.session;
        const seat = data.seat;
        if (!m || seat === null || seat === undefined) return ack?.({ ok: false, error: "Not seated" });
        const msg = schema.safeParse(raw);
        if (!msg.success) return ack?.({ ok: false, error: "Invalid message" });
        try {
          const result = fn(m, seat, msg.data);
          ack?.(result ?? { ok: true });
        } catch (e) {
          if (e instanceof CommandError) return ack?.({ ok: false, error: e.message });
          this.deps.log.error({ err: e, msg: name }, "player command failed");
          ack?.({ ok: false, error: "Server error" });
        }
      });
    };

    /**
     * Audio uploads: like seatCmd, but every refusal says whether to retry (AudioAck). Not seated
     * (e.g. right after a reconnect, before hello) is transient; a bad payload is permanent.
     */
    const audioCmd = <T>(
      name: string,
      schema: ZodType<T>,
      fn: (m: SessionManager, seat: number, msg: T) => AudioAck<unknown> | Promise<AudioAck<unknown>>,
    ) => {
      sock.on(name, (raw, ack?: (a: AudioAck<unknown>) => void) => {
        const m = this.session;
        const seat = data.seat;
        if (!m || seat === null || seat === undefined)
          return ack?.({ ok: false, error: "Not seated", retry: true });
        const msg = schema.safeParse(raw);
        if (!msg.success)
          return ack?.({
            ok: false,
            error: `Invalid message: ${msg.error.issues[0]?.message ?? ""}`,
            retry: false,
          });
        Promise.resolve()
          .then(() => fn(m, seat, msg.data))
          .then(
            (a) => {
              ack?.(a);
              // stored audio changes the LIVE mic column (throttled)
              if (a.ok && this.session === m) this.schedulePush();
            },
            (e) => {
              if (e instanceof CommandError) return ack?.({ ok: false, error: e.message, retry: false });
              this.deps.log.error({ err: e, msg: name }, "audio upload failed");
              ack?.({ ok: false, error: "Server error", retry: true });
            },
          );
      });
    };

    seatCmd("consent:submit", ConsentSubmit, (m, seat, msg) => m.submitConsent(seat, msg));
    seatCmd("mic:check", MicCheckSubmit, (m, seat, msg) => m.submitMicCheck(seat, msg));
    audioCmd("audio:start", AudioStart, (m, seat, msg) => m.audio.start(seat, msg));
    audioCmd("audio:chunk", AudioChunk, (m, seat, msg) => m.audio.chunk(seat, msg));
    audioCmd("audio:stop", AudioStop, (m, seat, msg) => m.audio.stop(seat, msg));
    seatCmd("demographics:submit", DemographicsSubmit, (m, seat, msg) => m.submitDemographics(seat, msg));
    seatCmd("briefing:ack", BriefingAck, (m, seat, msg) => m.acknowledgeBriefing(seat, msg));
    seatCmd("intent", IntentMsg, (m, seat, msg) => m.intent(seat, msg));
    seatCmd("telemetry", TelemetryBatch, (m, seat, msg) => ({ stored: this.ingestTelemetry(m, seat, msg) }));

    sock.on("presence", (raw) => {
      const seat = data.seat;
      const msg = Presence.safeParse(raw);
      if (!msg.success || !seat) return;
      const st = this.stats.get(seat);
      if (st) st.hoverRegionId = msg.data.regionId;
      this.facilitator.volatile.emit("presence:live", { seat, regionId: msg.data.regionId });
    });

    // volatile meter reading for LIVE: never stored, dropped for seats that are not recorded
    sock.on("audio:level", (raw) => {
      const m = this.session;
      const seat = data.seat;
      if (!m || !seat || !m.state.audio.enabled) return;
      const s = m.state.seats[seat];
      if (!s?.bound || s.withdrawn || !micCheckApplies(m.state, s) || s.micCheck === "skipped") return;
      const msg = AudioLevel.safeParse(raw);
      if (!msg.success) return;
      const { state, rmsDb, peakDb, pendingChunks } = msg.data;
      this.micLevels.set(seat, { state, rmsDb, peakDb, pendingChunks });
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

  private onFacilitator(sock: Socket) {
    const m = this.session;
    sock.emit("scenario", m?.scenario ?? null);
    sock.emit("events", {
      events: m ? this.store.listEvents(m.sessionId).map(redactEvent) : [],
      reset: true,
    });
    sock.emit("telemetry:live", { items: this.liveTelemetry, reset: true });
    sock.emit("dashboard", this.dashboard());

    const cmd = <T>(name: string, schema: ZodType<T>, fn: (msg: T) => unknown, needsSession = true) => {
      sock.on(name, (raw, ack?: (a: Ack) => void) => {
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
          // some commands (fake:add) wait for network clients
          if (data instanceof Promise) data.then((d) => ack?.({ ok: true, data: d }), fail);
          else ack?.({ ok: true, data });
        } catch (e) {
          fail(e);
        }
      });
    };
    const s = () => this.session!;

    cmd(
      "session:create",
      SessionCreate,
      (msg) => ({ sessionId: this.createSession(msg.scenarioId, msg.config, msg.notes).sessionId }),
      false,
    );
    cmd(
      "session:resume",
      SessionResume,
      (msg) => ({ sessionId: this.resumeSession(msg.sessionId).sessionId }),
      false,
    );
    cmd("seat:bind", SeatBind, (msg) => this.bindTerminal(msg.terminal, msg.seat));
    cmd("fake:add", FakeAdd, (msg) => this.addFakePlayers(msg.seats, msg.pace));
    cmd("seat:unbind", SeatUnbind, (msg) => s().unbindSeat(msg.seat, msg.reason));
    cmd("labels:set", LabelsSet, (msg) => s().setLabels(msg.assignments, msg.pairing));
    cmd("labels:randomise", LabelsRandomise, (msg) => s().randomiseLabels(msg.pairing, msg.shuffleK));
    cmd("onboarding:start", Empty, () => s().startOnboarding());
    cmd("simulation:start", Empty, () => s().startSimulation());
    cmd("round:start", Empty, () => s().startRound("facilitator"));
    cmd("round:end", Empty, () => s().endRound());
    cmd("game:pause", Empty, () => s().pause());
    cmd("game:resume", Empty, () => s().resume());
    cmd("action:revoke", ActionRevoke, (msg) => s().revoke(msg.seq, msg.reason));
    cmd("broadcast", BroadcastMsg, (msg) => s().broadcast(msg.text));
    cmd("note", NoteMsg, (msg) => s().note(msg.text));
    cmd("participant:withdraw", WithdrawMsg, (msg) => s().withdraw(msg.seat));
    cmd("game:end", Empty, () => s().endGame());
    cmd("session:close", Empty, () => s().close());
    cmd("session:abort", AbortMsg, (msg) => s().abort(msg.reason));
    cmd("mic:skip", MicSkip, (msg) => s().skipMicCheck(msg.seat, msg.reason));
    cmd("calibration:start", Empty, () => s().startCalibration(false));
    cmd("calibration:redo", Empty, () => s().startCalibration(true));
    cmd("calibration:skip", CalibrationSkip, (msg) => s().skipCalibration(msg.reason));
    cmd("recording:pause", RecordingPause, (msg) => s().pauseRecording(msg.reason));
    cmd("recording:resume", Empty, () => s().resumeRecording());
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
