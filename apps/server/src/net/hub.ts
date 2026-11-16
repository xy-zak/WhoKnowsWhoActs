import { timingSafeEqual } from "node:crypto";
import {
  AbortMsg,
  type Ack,
  ActionRevoke,
  BriefingAck,
  BroadcastMsg,
  ClockPing,
  ConsentSubmit,
  type DashboardMsg,
  DemographicsSubmit,
  Empty,
  IntentMsg,
  LabelsRandomise,
  LabelsSet,
  LIVE_TELEMETRY_TYPES,
  NoteMsg,
  PlayerHello,
  Presence,
  parseTelemetryItem,
  playerView,
  REDACTED_EVENT_TYPES,
  type Scenario,
  SeatBind,
  type SeatLiveStats,
  SeatUnbind,
  type SessionConfig,
  SessionCreate,
  SessionResume,
  type StoredEvent,
  type StoredTelemetry,
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
import { nowTs } from "../runtime";
import { CommandError, SessionManager } from "../session/SessionManager";

interface TerminalEntry {
  terminal: number;
  sockets: Set<Socket>;
}

interface PlayerSocketData {
  terminalKey?: string;
  terminal?: number;
  seat?: number | null;
}

export interface HubDeps {
  io: Server;
  store: Store;
  scenarios: ScenarioLibrary;
  configDir: string;
  log: Logger;
  adminToken: string | null;
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
  private terminals = new Map<string, TerminalEntry>();
  private nextTerminal = 1;
  private seatSockets = new Map<number, Socket>();
  private stats = new Map<number, SeatLiveStats>();
  private liveTelemetry: StoredTelemetry[] = [];
  private statsTimer: NodeJS.Timeout | null = null;
  readonly player: Namespace;
  readonly facilitator: Namespace;
  private readonly secret: string;

  constructor(private readonly deps: HubDeps) {
    this.secret = getMeta(deps.store.db, "server_secret") ?? "";
    if (!this.secret) throw new Error("Database has no server secret");
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

  private sessionDeps(scenario: Scenario) {
    return {
      store: this.deps.store,
      scenario,
      onboarding: loadOnboardingContent(this.deps.configDir),
      serverSecret: this.secret,
      log: this.deps.log,
      onEvents: (evs: StoredEvent[]) => this.onEvents(evs),
    };
  }

  createSession(scenarioId: string, config: SessionConfig, notes: string): SessionManager {
    const scenario = this.deps.scenarios.load(scenarioId);
    this.detach("A new session was created");
    // this.session is null while creating, so the SessionCreated batch is delivered by afterAttach()
    const created = SessionManager.create(this.sessionDeps(scenario), config, notes);
    this.session = created;
    this.deps.log.info({ sessionId: created.sessionId, scenario: scenario.id }, "session created");
    this.afterAttach();
    return created;
  }

  resumeSession(sessionId: string): SessionManager {
    const row = this.deps.store.getSession(sessionId);
    if (!row) throw new CommandError(`Unknown session ${sessionId}`);
    const scenario = this.deps.scenarios.load(row.scenario_id);
    this.detach("Switching session");
    const m = SessionManager.load(this.sessionDeps(scenario), sessionId);
    this.session = m;
    this.deps.log.info({ sessionId }, "session resumed");
    this.afterAttach();
    return m;
  }

  /** Resume the most recent session that has not ended (used on server start). */
  autoResume() {
    const s = this.deps.store.listSessions().find((x) => !["closed", "aborted"].includes(x.status));
    if (s) {
      try {
        this.resumeSession(s.id);
      } catch (e) {
        this.deps.log.error({ err: e, sessionId: s.id }, "auto-resume failed");
      }
    }
  }

  private detach(reason: string) {
    if (!this.session) return;
    this.session.dispose();
    this.session = null;
    for (const [, sock] of this.seatSockets) {
      sock.emit("unbound", { reason });
      (sock.data as PlayerSocketData).seat = null;
    }
    this.seatSockets.clear();
    this.stats.clear();
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
      events: this.deps.store.listEvents(m.sessionId).map(redactEvent),
      reset: true,
    });
    this.facilitator.emit("telemetry:live", { items: [], reset: true });
    this.pushAll();
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
      } else if (ev.type === "SeatUnbound") {
        const sock = this.seatSockets.get(ev.payload.seat);
        if (sock) {
          sock.emit("unbound", { reason: ev.payload.reason });
          (sock.data as PlayerSocketData).seat = null;
          this.seatSockets.delete(ev.payload.seat);
          sock.emit("terminal", { terminal: (sock.data as PlayerSocketData).terminal });
        }
      }
    }
    this.facilitator.emit("events", { events: events.map(redactEvent), reset: false });
    this.pushAll();
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
    const terminals: TerminalInfo[] = [...this.terminals.values()]
      .map((t) => {
        const seated = [...t.sockets].map((x) => (x.data as PlayerSocketData).seat).find((x) => x);
        return { terminal: t.terminal, connected: t.sockets.size > 0, seat: seated ?? null };
      })
      .filter((t) => t.connected || t.seat !== null)
      .sort((a, b) => a.terminal - b.terminal);
    return {
      state: m?.state ?? null,
      serverTs: nowTs(),
      terminals,
      stats: Object.fromEntries(this.stats),
      live: Boolean(m && !m.isFinal),
    };
  }

  private pushDashboard() {
    if (this.statsTimer) clearTimeout(this.statsTimer);
    this.statsTimer = null;
    this.facilitator.emit("dashboard", this.dashboard());
  }

  /** Throttled dashboard refresh for telemetry-driven stats changes. */
  private schedulePush() {
    if (this.statsTimer) return;
    this.statsTimer = setTimeout(() => {
      this.statsTimer = null;
      this.facilitator.emit("dashboard", this.dashboard());
    }, 1000);
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

    seatCmd("consent:submit", ConsentSubmit, (m, seat, msg) => m.submitConsent(seat, msg));
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

    sock.on("disconnect", (reason) => {
      clearTimeout(helloTimeout);
      if (data.terminalKey) this.terminals.get(data.terminalKey)?.sockets.delete(sock);
      const seat = data.seat;
      if (seat && this.seatSockets.get(seat) === sock) {
        this.seatSockets.delete(seat);
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
    const stored = this.deps.store.insertTelemetry(
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
      events: m ? this.deps.store.listEvents(m.sessionId).map(redactEvent) : [],
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
        try {
          const data = fn(msg.data);
          ack?.({ ok: true, data });
        } catch (e) {
          if (e instanceof CommandError) return ack?.({ ok: false, error: e.message });
          this.deps.log.error({ err: e, msg: name }, "facilitator command failed");
          ack?.({ ok: false, error: (e as Error).message ?? "Server error" });
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
    cmd("seat:bind", SeatBind, (msg) => {
      const entry = [...this.terminals.values()].find(
        (t) => t.terminal === msg.terminal && t.sockets.size > 0,
      );
      if (!entry) throw new CommandError(`Client ${msg.terminal} is not connected`);
      const seated = [...entry.sockets].map((x) => (x.data as PlayerSocketData).seat).find((x) => x);
      if (seated && seated !== msg.seat)
        throw new CommandError(`Client ${msg.terminal} is already seat ${seated}`);
      return s().bindSeat(msg.terminal, msg.seat);
    });
    cmd("seat:unbind", SeatUnbind, (msg) => s().unbindSeat(msg.seat, msg.reason));
    cmd("labels:set", LabelsSet, (msg) => s().setLabels(msg.assignments, msg.pairing));
    cmd("labels:randomise", LabelsRandomise, (msg) => s().randomiseLabels(msg.pairing, msg.shuffleK));
    cmd("onboarding:start", Empty, () => s().startOnboarding());
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
    this.session?.dispose();
    if (this.statsTimer) clearTimeout(this.statsTimer);
  }
}
