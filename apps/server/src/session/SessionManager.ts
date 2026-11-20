import { createHmac, timingSafeEqual } from "node:crypto";
import {
  type ActionKind,
  type ActorKind,
  AUDIO_CONSENT_ITEM,
  type AudioAck,
  activeSeats,
  afterReplay,
  agentSeed,
  applyEvent,
  calibrationReadyToStart,
  canSayCalibrationReady,
  canStartFirstRound,
  checkSimulationConfig,
  DISSOCIATED_PAIRINGS,
  type EventType,
  type FakePlayerPace,
  type GameState,
  generateParticipantCode,
  generateSessionId,
  getGameRules,
  getPolicy,
  type IntentAck,
  initialState,
  isFinalPhase,
  isMicCheckHeld,
  isOnboardingComplete,
  isSimulated,
  K_LABELS,
  type KLabel,
  type LabelPairing,
  type MicCheckResult,
  micCheckApplies,
  type NewEvent,
  nextOnboardingStep,
  normaliseForPlayers,
  type OnboardingContent,
  type OnboardingStep,
  onboardingStepsFor,
  type PayloadOf,
  pairedP,
  parseSessionConfig,
  parseTelemetryItem,
  quotaLimit,
  quotaUsed,
  RECORDING_PHASES,
  type ReadonlyGameState,
  randomCrockford,
  resolvePolicyParams,
  roundActiveMs,
  roundIsComplete,
  roundRemainingMs,
  roundSpecFor,
  type Scenario,
  type SessionConfig,
  type StoredEvent,
  type StoredTelemetry,
  scoreChangesForIntent,
  scoreChangesForRevoke,
  seatList,
  seatPolicyId,
  seededRandom,
  type TelemetryItem,
  validateIntent,
} from "@wkwa/shared";
import type { Logger } from "pino";
import { type AudioChunkMsg, type AudioStartMsg, type AudioStopMsg, LiveAudio } from "../audio/live";
import type { Store } from "../db/store";
import { harnessVersion, nowTs, wall } from "../runtime";
import { CalibrationError, CalibrationRunner } from "./CalibrationRunner";
import { type MicLevelReading, SeatMonitor } from "./SeatMonitor";

export { CALIBRATION_CHECK_WAIT_MS } from "./CalibrationRunner";

/** Thrown for invalid facilitator commands / player submissions; the message is shown to the user. */
export class CommandError extends Error {}

/** Ack of an intent (shared with the clients: see @wkwa/shared socket.ts). */
export type { IntentAck } from "@wkwa/shared";

export interface SessionDeps {
  store: Store;
  scenario: Scenario;
  onboarding: OnboardingContent;
  serverSecret: string;
  log: Logger;
  /** Called once per command with every event appended during that command. */
  onEvents: (events: StoredEvent[]) => void;
  clock?: () => number;
}

type LabelAssignment = { seat: number; k: KLabel; view?: string };

/**
 * Answers to recent intents kept per seat. A browser resends only the intents it has no answer
 * for, so a handful would do; the cache is rebuilt from the event log when a session is loaded.
 */
const ACK_CACHE_SIZE = 50;

/** The answer an intent got, read back from its event (null for events that are not intents). */
function intentAckOf(ev: StoredEvent): IntentAck | null {
  if (ev.type === "ProposalMade" || ev.type === "DecisionMade") return { ok: true, seq: ev.seq };
  if (ev.type === "IntentRejected")
    return { ok: false, reason: ev.payload.reason, detail: ev.payload.detail };
  return null;
}

/**
 * Owns ONE session: validates commands and intents, appends events to the
 * store, applies them to the in-memory state via the shared reducer, and
 * notifies the network layer. All state changes go through `append`.
 */
export class SessionManager {
  /** Changed only by the reducer (`append`, `load`); everything else reads `state`. */
  private readonly game: GameState = initialState();
  get state(): ReadonlyGameState {
    return this.game;
  }
  private pending: StoredEvent[] = [];
  private depth = 0;
  private roundTimer: NodeJS.Timeout | null = null;
  private advanceTimer: NodeJS.Timeout | null = null;
  private lastClientSeq = new Map<number, number>();
  private ackCache = new Map<number, Map<number, IntentAck>>();
  private readonly clock: () => number;
  /** Live audio ingest: tracks, chunks and the calibration audio of this session (see audio/live.ts). */
  private readonly audio: LiveAudio;
  /**
   * The volatile per-seat figures of the facilitator's dashboard (see SeatMonitor.ts). The hub reads
   * them; they change only through this manager's submit* methods and the events it appends.
   */
  readonly monitor: SeatMonitor;
  /** The facilitator-led calibration of an audio session (see CalibrationRunner.ts). */
  private readonly calibration: CalibrationRunner;

  private constructor(
    readonly sessionId: string,
    private readonly deps: SessionDeps,
  ) {
    this.clock = deps.clock ?? nowTs;
    this.audio = new LiveAudio({
      sessionId,
      store: deps.store,
      clock: this.clock,
      log: deps.log,
      state: () => this.state,
      append: (ev) => this.append(ev),
      run: (fn) => this.run(fn),
      isFinal: () => this.isFinal,
    });
    this.calibration = new CalibrationRunner({
      sessionId,
      clock: this.clock,
      log: deps.log,
      state: () => this.state,
      append: (ev) => this.append(ev),
      run: (fn) => this.run(fn),
      isFinal: () => this.isFinal,
      audio: this.audio,
      content: () => this.onboarding.audio?.calibration,
    });
    this.monitor = new SeatMonitor({
      state: () => this.state,
      trackStats: (seat) => this.audio.seatStats(seat),
    });
  }

  get scenario(): Scenario {
    return this.deps.scenario;
  }
  get onboarding(): OnboardingContent {
    return this.deps.onboarding;
  }
  /** The database this session lives in (participant or simulation database). */
  get store(): Store {
    return this.deps.store;
  }
  /** Played by agents instead of participants? */
  get simulated(): boolean {
    return isSimulated(this.state);
  }

  /* ═════════════════════════ lifecycle ═════════════════════════ */

  /**
   * Create a session. A simulated session (config.players = "simulated") gets
   * a `SIM-` id, no onboarding, a logged seed, and one agent per seat
   * (`AgentBound`); `deps.store` must then be the simulation database.
   */
  static create(deps: SessionDeps, input: SessionConfig, notes: string): SessionManager {
    let config = normaliseForPlayers(parseSessionConfig(input)); // normalises tags
    const simulated = config.players === "simulated";
    if (simulated) {
      const problem = checkSimulationConfig(config.simulation, config.seatCount);
      if (problem) throw new CommandError(problem);
      // the effective seed is part of the logged config, so every run can be repeated
      if (!config.simulation.seed) {
        config = { ...config, simulation: { ...config.simulation, seed: randomCrockford(8) } };
      }
    }
    for (const k of K_LABELS) {
      if (config.viewAssignment === "byKnowledgeType" && !deps.scenario.views[k]) {
        throw new CommandError(
          `Scenario '${deps.scenario.id}' has no view '${k}' (required for byKnowledgeType)`,
        );
      }
    }
    if (config.audio.enabled) {
      // nobody is recorded without being asked: the consent step, with its required audio item
      if (!config.onboarding.consent)
        throw new CommandError("Recording audio needs the consent step (onboarding.consent)");
      if (!deps.onboarding.consent.items.some((i) => i.id === AUDIO_CONSENT_ITEM && i.required))
        throw new CommandError(
          `Recording audio needs the required consent item '${AUDIO_CONSENT_ITEM}' in config/consent.json`,
        );
      if (!deps.onboarding.audio)
        throw new CommandError(
          "Recording audio needs the mic check and calibration texts (config/audio.json)",
        );
      if (!deps.store.audioFiles) throw new CommandError("This database cannot store audio");
    }
    const rules = getGameRules(config.rules);
    if (!rules) throw new CommandError(`Unknown game rules '${config.rules}'`);
    const { min, max } = rules.scoreRange;
    const outOfRange = Object.entries(deps.scenario.initialScores).find(([, v]) => v < min || v > max);
    if (outOfRange) {
      throw new CommandError(
        `Scenario '${deps.scenario.id}': the starting score of ${outOfRange[0]} (${outOfRange[1]}) is outside the range of the '${rules.id}' rules (${min}–${max})`,
      );
    }
    const sessionId = generateSessionId(new Date(), config.players);
    const m = new SessionManager(sessionId, deps);
    const hv = harnessVersion();
    deps.store.insertSession({
      id: sessionId,
      created_wall: wall(m.clock()),
      scenario_id: deps.scenario.id,
      scenario_version: deps.scenario.version,
      scenario_hash: deps.scenario.hash,
      status: "lobby",
      tags_json: JSON.stringify(config.tags),
      notes,
      config_json: JSON.stringify(config),
      harness_version: hv.version,
      git_commit: hv.gitCommit,
    });
    m.run(() => {
      m.append({
        type: "SessionCreated",
        actorKind: "facilitator",
        payload: {
          config,
          scenario: {
            id: deps.scenario.id,
            title: deps.scenario.title,
            version: deps.scenario.version,
            hash: deps.scenario.hash,
          },
          regionIds: deps.scenario.regions.map((r) => r.id),
          viewIds: Object.keys(deps.scenario.views),
          board: deps.scenario.board,
          initialScores: deps.scenario.initialScores,
          rules: { id: rules.id, version: rules.version },
          harness: hv,
          notes,
        },
      });
      if (simulated) m.bindAgents();
    });
    return m;
  }

  /** Put one agent in every seat (simulated sessions; called once, at creation). */
  private bindAgents() {
    const sim = this.state.config.simulation;
    for (const s of seatList(this.state)) {
      const policy = getPolicy(seatPolicyId(sim, s.seat));
      if (!policy) throw new CommandError(`Unknown policy for seat ${s.seat}`);
      this.append({
        type: "AgentBound",
        actorKind: "system",
        seat: s.seat,
        payload: {
          seat: s.seat,
          policy: policy.id,
          policyVersion: policy.version,
          params: resolvePolicyParams(policy, sim.params[policy.id]),
          seed: agentSeed(sim.seed ?? "", s.seat),
        },
      });
    }
  }

  /** Rebuild a session from its event log (e.g. after a server restart). */
  static load(deps: SessionDeps, sessionId: string): SessionManager {
    const m = new SessionManager(sessionId, deps);
    const events = deps.store.listEvents(sessionId);
    if (events.length === 0) throw new Error(`Session ${sessionId} has no events`);
    for (const ev of events) {
      applyEvent(m.game, ev);
      if (ev.clientSeq !== null && ev.seat !== null) {
        m.lastClientSeq.set(ev.seat, Math.max(m.lastClientSeq.get(ev.seat) ?? 0, ev.clientSeq));
        // the answers to recent intents, so a browser's resend after a restart gets the same one
        const ack = intentAckOf(ev);
        if (ack) m.rememberAck(ev.seat, ev.clientSeq, ack);
      }
    }
    if (m.state.scenario && m.state.scenario.hash !== deps.scenario.hash) {
      deps.log.warn(
        { sessionId, expected: m.state.scenario.hash, actual: deps.scenario.hash },
        "scenario files changed since the session was created",
      );
    }
    if (m.state.rules) {
      const now = getGameRules(m.state.rules.id);
      if (!now || now.version !== m.state.rules.version) {
        deps.log.warn(
          { sessionId, recorded: m.state.rules, current: now ? { id: now.id, version: now.version } : null },
          "game rules changed since the session was created; recorded scores stay as they were, new actions use the current rules",
        );
      }
    }
    afterReplay(m.game);
    m.run(() => {
      m.audio.recover();
      // the calibration's timers did not survive the restart: end that run (the facilitator can redo it)
      m.calibration.cancel("The server restarted during the calibration (run it again)");
    });
    m.armTimers();
    return m;
  }

  /** Stop timers (call when detaching or shutting down). */
  dispose() {
    if (this.roundTimer) clearTimeout(this.roundTimer);
    if (this.advanceTimer) clearTimeout(this.advanceTimer);
    this.roundTimer = null;
    this.advanceTimer = null;
    this.calibration.dispose();
  }

  /** Close every open audio track (e.g. `interrupted` when the hub switches to another session). */
  closeAudioTracks(reason: "interrupted") {
    this.run(() => {
      if (!this.isFinal) this.audio.closeAll(reason);
    });
  }

  get isFinal(): boolean {
    return isFinalPhase(this.state.phase);
  }

  /* ═════════════════════════ internals ═════════════════════════ */

  /**
   * Run a command; all events appended inside are delivered to onEvents in one batch. At the end of
   * the outermost command, a calibration the room is now ready for starts (autoStartCalibration).
   */
  private run<T>(fn: () => T): T {
    this.depth++;
    try {
      const out = fn();
      if (this.depth === 1) this.autoStartCalibration();
      return out;
    } finally {
      this.depth--;
      if (this.depth === 0 && this.pending.length > 0) {
        const batch = this.pending;
        this.pending = [];
        try {
          this.deps.onEvents(batch);
        } catch (e) {
          this.deps.log.error({ err: e }, "onEvents handler failed");
        }
      }
    }
  }

  private append(ev: NewEvent): StoredEvent {
    const before = this.state.phase;
    const round = ev.type === "RoundStarted" ? ev.payload.round : this.state.round;
    const stored = this.deps.store.appendEvent(this.sessionId, ev, round, this.clock());
    applyEvent(this.game, stored);
    this.pending.push(stored);
    if (this.state.phase !== before) this.deps.store.setSessionStatus(this.sessionId, this.state.phase);
    // close audio tracks the event ends (pause, withdrawal, disconnect, game complete, ...)
    this.audio.observe(stored);
    // and clear the live figures it ends (unbinding, withdrawal, mic check skipped, end of session)
    this.monitor.observe(stored);
    return stored;
  }

  /** An event of a seat: the seat's participant code is recorded with it (and the browser's clientTs/clientSeq). */
  private seatEvent<K extends EventType>(
    seat: number,
    type: K,
    actorKind: ActorKind,
    payload: PayloadOf<K>,
    clientTs?: number,
    clientSeq?: number,
  ): StoredEvent {
    const participantCode = this.state.seats[seat]?.participantCode ?? null;
    return this.append({ type, actorKind, seat, participantCode, clientTs, clientSeq, payload } as NewEvent);
  }

  private requirePhase(...phases: GameState["phase"][]) {
    if (!phases.includes(this.state.phase)) {
      throw new CommandError(`Not possible in phase '${this.state.phase}' (needs: ${phases.join(", ")})`);
    }
  }

  private requireSeat(seat: number) {
    const s = this.state.seats[seat];
    if (!s) throw new CommandError(`Seat ${seat} does not exist in this session`);
    return s;
  }

  /* ═════════════════════════ seats & tokens ═════════════════════════ */

  seatToken(seat: number): string | null {
    const s = this.state.seats[seat];
    if (!s?.bound || !s.bindingId) return null;
    return createHmac("sha256", this.deps.serverSecret)
      .update(`${this.sessionId}:${seat}:${s.bindingId}`)
      .digest("hex");
  }

  /** Which seat does this reconnect token belong to (constant-time compare)? */
  seatForToken(token: string | null | undefined): number | null {
    if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
    const given = Buffer.from(token, "hex");
    for (const s of seatList(this.state)) {
      const expected = this.seatToken(s.seat);
      if (expected && timingSafeEqual(Buffer.from(expected, "hex"), given)) return s.seat;
    }
    return null;
  }

  seatOfTerminal(terminal: number): number | null {
    return seatList(this.state).find((s) => s.bound && s.terminal === terminal)?.seat ?? null;
  }

  private requireReal(what: string) {
    if (this.simulated)
      throw new CommandError(`${what} is not possible in a simulated session: agents take every seat`);
  }

  /**
   * Why a fake player may not take this seat now (null = it may): only in a session with real
   * players, in the lobby (before onboarding), on a seat that exists and is not bound. Stricter than
   * `bindSeat` for a real client, which replaces the client in a bound seat.
   */
  fakePlayerRefusal(seat: number): string | null {
    const s = this.state.seats[seat];
    return (
      this.fakeSessionRefusal() ??
      (!s ? `Seat ${seat} does not exist in this session` : null) ??
      (s?.bound ? `Seat ${seat} is already bound; unbind it first` : null)
    );
  }

  /** The part of fakePlayerRefusal that holds for every seat. */
  private fakeSessionRefusal(): string | null {
    if (this.simulated)
      return "Fake players are for sessions with real players; a simulated session already has an agent in every seat";
    if (this.state.phase !== "lobby")
      return "Fake players can only be added in the lobby (setup step 08), before onboarding";
    return null;
  }

  /**
   * The seats to start fake players for: the given ones, or (null) every unbound seat. Throws a
   * CommandError when there is none, or when one of them may not have a fake player.
   */
  fakePlayerSeats(requested: readonly number[] | null): number[] {
    const why = this.fakeSessionRefusal();
    if (why) throw new CommandError(why);
    const seats = requested
      ? [...requested]
      : seatList(this.state)
          .filter((s) => !s.bound)
          .map((s) => s.seat);
    if (seats.length === 0) throw new CommandError("Every seat is already bound");
    for (const seat of seats) {
      const refused = this.fakePlayerRefusal(seat);
      if (refused) throw new CommandError(refused);
    }
    return seats;
  }

  /**
   * Bind a connected client to a seat. A real client gets a new participant
   * code (and replaces the client in a bound seat). A fake player (a test client
   * the server created, `fake: true`) gets none: it is not a participant, so it
   * never appears on the key sheet, on a takedown card or in an erasure; it may
   * only take a free seat (fakePlayerRefusal).
   */
  bindSeat(
    terminal: number,
    seat: number,
    opts: { fake?: boolean; fakePace?: FakePlayerPace } = {},
  ): { participantCode: string | null; fake: boolean } {
    return this.run(() => {
      this.requireReal("Binding a client");
      this.requirePhase("lobby");
      const s = this.requireSeat(seat);
      const fakeRefused = opts.fake ? this.fakePlayerRefusal(seat) : null;
      if (fakeRefused) throw new CommandError(fakeRefused);
      if (s.bound) {
        this.seatEvent(seat, "SeatUnbound", "facilitator", { seat, reason: "replaced" });
      }
      const fake = opts.fake === true;
      let code: string | null = null;
      if (!fake) {
        code = generateParticipantCode();
        const inSession = new Set(seatList(this.state).map((x) => x.participantCode));
        while (inSession.has(code) || this.deps.store.codeExists(code)) code = generateParticipantCode();
      }
      this.append({
        type: "SeatBound",
        actorKind: "facilitator",
        seat,
        participantCode: code,
        payload: {
          seat,
          terminal,
          bindingId: `b-${randomCrockford(6)}`,
          fake,
          ...(fake ? { fakePace: opts.fakePace ?? "normal" } : {}),
        },
      });
      return { participantCode: code, fake };
    });
  }

  unbindSeat(seat: number, reason: string) {
    this.run(() => {
      this.requireReal("Unbinding a seat");
      this.requirePhase("lobby");
      const s = this.requireSeat(seat);
      if (!s.bound) throw new CommandError(`Seat ${seat} is not bound`);
      this.seatEvent(seat, "SeatUnbound", "facilitator", { seat, reason });
    });
  }

  /* ═════════════════════════ labels ═════════════════════════ */

  /**
   * Assign K labels (each at most once) and a K–P pairing. P is always derived
   * from the pairing — aligned (Ka–Pa …) or one of the six fully dissociative
   * pairings D1–D6 — so no other K/P combination can ever occur.
   * A dissociated pairing without a number gets a random one (seed logged).
   */
  setLabels(
    assignments: LabelAssignment[],
    pairingIn: LabelPairing = { mode: "aligned", id: null },
    method: "manual" | "random" = "manual",
    seedIn: string | null = null,
  ) {
    this.run(() => {
      this.requirePhase("lobby", "onboarding", "round_complete");
      const cfg = this.state.config;
      const seats = seatList(this.state).map((s) => s.seat);
      const given = assignments.map((a) => a.seat).sort((a, b) => a - b);
      if (given.length !== seats.length || given.some((s, i) => s !== seats[i])) {
        throw new CommandError(`Assign labels to every seat exactly once (seats ${seats.join(", ")})`);
      }
      if (new Set(assignments.map((a) => a.k)).size !== assignments.length) {
        throw new CommandError("Each K label may be used only once");
      }
      let seed = seedIn;
      let pairing: LabelPairing;
      if (pairingIn.mode === "aligned") pairing = { mode: "aligned", id: null };
      else if (pairingIn.id !== null) pairing = { mode: "dissociated", id: pairingIn.id };
      else {
        seed = seed ?? randomCrockford(6);
        const rng = seededRandom(`${seed}:pairing`);
        pairing = { mode: "dissociated", id: 1 + Math.floor(rng() * DISSOCIATED_PAIRINGS.length) };
        method = "random";
      }
      const full = assignments.map((a) => {
        const view =
          cfg.viewAssignment === "byKnowledgeType" ? a.k : (a.view ?? this.state.seats[a.seat]?.view ?? a.k);
        if (!this.scenario.views[view]) throw new CommandError(`Scenario has no view '${view}'`);
        return { seat: a.seat, k: a.k, p: pairedP(a.k, pairing), view };
      });
      this.append({
        type: "LabelsAssigned",
        actorKind: "facilitator",
        payload: { assignments: full, method, seed, pairing },
      });
    });
  }

  /** Shuffle which seat gets which K (or keep seat order) and apply a pairing. Seed is logged. */
  randomiseLabels(pairing: LabelPairing = { mode: "aligned", id: null }, shuffleK = true) {
    const seed = randomCrockford(6);
    const rng = seededRandom(seed);
    const ks = [...K_LABELS];
    if (shuffleK) {
      for (let i = ks.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [ks[i], ks[j]] = [ks[j]!, ks[i]!];
      }
    }
    const assignments = seatList(this.state).map((s, i) => ({
      seat: s.seat,
      k: ks[i % ks.length]!,
      view: s.view ?? undefined,
    }));
    this.setLabels(assignments, pairing, "random", seed);
  }

  /* ═════════════════════════ flow ═════════════════════════ */

  startOnboarding() {
    this.run(() => {
      this.requirePhase("lobby");
      const seats = seatList(this.state);
      const unbound = seats.filter((s) => !s.bound).map((s) => s.seat);
      if (unbound.length) throw new CommandError(`Bind all seats first (unbound: ${unbound.join(", ")})`);
      const unlabelled = seats.filter((s) => !s.k || !s.p || !s.view).map((s) => s.seat);
      if (unlabelled.length)
        throw new CommandError(`Assign labels first (missing: seat ${unlabelled.join(", ")})`);
      // recording starts at each participant's own mic check, right after consent
      const steps = onboardingStepsFor(this.state.config);
      this.append({ type: "OnboardingStarted", actorKind: "facilitator", payload: { steps } });
    });
  }

  /**
   * Simulated sessions: lock the seats and start round 1 in one step. There is
   * no onboarding (OnboardingStarted is logged with no steps); from then on
   * the agents play and rounds advance as configured.
   */
  startSimulation() {
    this.run(() => {
      if (!this.simulated) throw new CommandError("Not a simulated session: start onboarding instead");
      this.startOnboarding();
      this.startRound("facilitator");
    });
  }

  /** Can the next round start? Returns null if yes, else the reason. */
  canStartRound(): string | null {
    const st = this.state;
    if (st.phase === "onboarding") {
      const active = activeSeats(st);
      if (active.length === 0) return "No active seats";
      const waiting = active.filter((s) => !isOnboardingComplete(st, s)).map((s) => s.seat);
      if (waiting.length) return `Waiting for onboarding of seat ${waiting.join(", ")}`;
      if (st.audio.calibration.status === "running") return "Wait for the calibration to finish (or skip it)";
      if (!canStartFirstRound(st)) return "Run the calibration first (or skip it)";
      return null;
    }
    if (st.phase === "round_complete") {
      if (st.audio.calibration.status === "running") return "Wait for the calibration to finish (or skip it)";
      return st.round < st.config.roundCount ? null : "All rounds have been played";
    }
    return `Not possible in phase '${st.phase}'`;
  }

  startRound(by: "facilitator" | "auto" = "facilitator") {
    this.run(() => {
      const why = this.canStartRound();
      if (why) throw new CommandError(why);
      if (this.advanceTimer) clearTimeout(this.advanceTimer);
      this.advanceTimer = null;
      const round = this.state.round + 1;
      this.append({
        type: "RoundStarted",
        actorKind: by === "auto" ? "system" : "facilitator",
        payload: { round, spec: roundSpecFor(this.state.config, round), startedBy: by },
      });
      this.armTimers();
    });
  }

  endRound() {
    this.run(() => {
      this.requirePhase("round_active");
      this.completeRound("facilitator", false);
    });
  }

  private completeRound(reason: "quota_met" | "time_limit" | "facilitator", forceGameEnd: boolean) {
    const st = this.state;
    const now = this.clock();
    const actionCounts: Record<string, { propose: number; decide: number }> = {};
    for (const s of activeSeats(st)) {
      actionCounts[String(s.seat)] = {
        propose: quotaUsed(st, s.seat, "propose"),
        decide: quotaUsed(st, s.seat, "decide"),
      };
    }
    const pausedNow = st.paused && st.pausedSince !== null ? now - st.pausedSince : 0;
    if (this.roundTimer) clearTimeout(this.roundTimer);
    this.roundTimer = null;
    this.append({
      type: "RoundCompleted",
      actorKind: reason === "facilitator" ? "facilitator" : "system",
      payload: {
        round: st.round,
        reason,
        durationMs: Math.max(0, now - (st.roundStartedTs ?? now)),
        pausedMs: st.roundPausedMs + pausedNow,
        actionCounts,
      },
    });
    if (forceGameEnd) {
      this.append({
        type: "GameCompleted",
        actorKind: "facilitator",
        payload: { roundsPlayed: st.round, reason: "facilitator" },
      });
    } else if (st.round >= st.config.roundCount) {
      this.append({
        type: "GameCompleted",
        actorKind: "system",
        payload: { roundsPlayed: st.round, reason: "all_rounds" },
      });
    } else {
      this.armTimers();
    }
  }

  pause() {
    this.run(() => {
      this.requirePhase("round_active");
      if (this.state.paused) throw new CommandError("Already paused");
      this.append({
        type: "GamePaused",
        actorKind: "facilitator",
        payload: { reason: "facilitator", seat: null },
      });
      this.armTimers();
    });
  }

  resume() {
    this.run(() => {
      if (!this.state.paused) throw new CommandError("The game is not paused");
      const pausedMs = Math.max(0, this.clock() - (this.state.pausedSince ?? this.clock()));
      this.append({ type: "GameResumed", actorKind: "facilitator", payload: { pausedMs } });
      this.armTimers();
    });
  }

  revoke(seq: number, reason: string) {
    this.run(() => {
      this.requirePhase("round_active");
      const a = this.state.actions.find((x) => x.seq === seq);
      if (!a) throw new CommandError(`No proposal/decision with seq ${seq}`);
      if (a.revoked) throw new CommandError("Already revoked");
      if (a.round !== this.state.round)
        throw new CommandError("Only actions of the current round can be revoked");
      this.seatEvent(a.seat, "ActionRevoked", "facilitator", {
        targetSeq: seq,
        targetType: a.kind === "propose" ? "ProposalMade" : "DecisionMade",
        targetSeat: a.seat,
        regionId: a.regionId,
        reason,
        scoreChanges: scoreChangesForRevoke(this.state, seq),
      });
    });
  }

  broadcast(text: string) {
    this.run(() => {
      if (this.isFinal) throw new CommandError("Session has ended");
      this.append({ type: "FacilitatorBroadcast", actorKind: "facilitator", payload: { text } });
    });
  }

  note(text: string) {
    this.run(() => this.append({ type: "SessionNote", actorKind: "facilitator", payload: { text } }));
  }

  /** A note written by the server itself (e.g. the simulation runner stopping a failing agent). */
  systemNote(text: string) {
    this.run(() => {
      if (this.isFinal) return;
      this.append({ type: "SessionNote", actorKind: "system", payload: { text: text.slice(0, 500) } });
    });
  }

  withdraw(seat: number) {
    this.run(() => {
      this.requirePhase("onboarding", "round_active", "round_complete", "game_complete");
      const s = this.requireSeat(seat);
      if (!s.bound) throw new CommandError(`Seat ${seat} is not bound`);
      if (s.withdrawn) throw new CommandError(`Seat ${seat} already withdrawn`);
      this.seatEvent(seat, "ParticipantWithdrawn", "facilitator", {
        seat,
        by: "facilitator",
        phase: this.state.phase,
      });
      this.afterAction();
    });
  }

  endGame() {
    this.run(() => {
      this.requirePhase("onboarding", "round_active", "round_complete");
      if (this.state.phase === "round_active") {
        this.completeRound("facilitator", true);
      } else {
        this.append({
          type: "GameCompleted",
          actorKind: "facilitator",
          payload: { roundsPlayed: this.state.round, reason: "facilitator" },
        });
      }
      this.dispose();
    });
  }

  close() {
    this.run(() => {
      this.requirePhase("game_complete");
      this.audio.beforeFinal("closed");
      this.append({ type: "SessionClosed", actorKind: "facilitator", payload: {} });
      this.dispose();
    });
  }

  abort(reason: string) {
    this.run(() => {
      if (this.isFinal) throw new CommandError("Session has already ended");
      this.audio.beforeFinal("aborted");
      this.append({ type: "SessionAborted", actorKind: "facilitator", payload: { reason } });
      this.dispose();
    });
  }

  /* ═════════════════════════ player connection ═════════════════════════ */

  playerConnected(seat: number) {
    this.run(() => {
      const s = this.state.seats[seat];
      if (!s?.bound || s.withdrawn || s.connected || this.isFinal) return;
      this.seatEvent(seat, "PlayerConnected", "system", { seat, reconnect: s.everConnected });
    });
  }

  /** The seat's browser disconnected (its socket was the seat's): its live figures go blank, then it is logged. */
  playerDisconnected(seat: number, reason: string) {
    this.monitor.disconnected(seat);
    this.run(() => {
      const s = this.state.seats[seat];
      if (!s?.bound || !s.connected || this.isFinal) return;
      this.seatEvent(seat, "PlayerDisconnected", "system", { seat, reason });
      const st = this.state;
      if (st.phase === "round_active" && !st.paused && st.config.pauseOnDisconnect && !s.withdrawn) {
        this.append({ type: "GamePaused", actorKind: "system", payload: { reason: "disconnect", seat } });
        this.armTimers();
      }
    });
  }

  /* ═════════════════════════ onboarding submissions ═════════════════════════ */

  private requireStep(seat: number, step: OnboardingStep) {
    this.requirePhase("onboarding");
    const s = this.requireSeat(seat);
    if (!s.bound || s.withdrawn) throw new CommandError("Seat is not active");
    const next = nextOnboardingStep(this.state, s);
    if (next !== step)
      throw new CommandError(next ? `Please complete '${next}' first` : "Onboarding already complete");
    return s;
  }

  submitConsent(
    seat: number,
    msg: {
      formVersion: string;
      textSha256: string;
      answers: Record<string, boolean>;
      durationMs: number;
      clientTs: number;
    },
  ) {
    this.run(() => {
      const s = this.requireStep(seat, "consent");
      if (s.consent === "declined") throw new CommandError("Consent was declined; ask the facilitator");
      const c = this.onboarding.consent;
      if (msg.formVersion !== c.version || msg.textSha256 !== c.sha256) {
        throw new CommandError("The consent text has changed — please reload the page");
      }
      const ids = new Set(c.items.map((i) => i.id));
      for (const k of Object.keys(msg.answers))
        if (!ids.has(k)) throw new CommandError(`Unknown consent item '${k}'`);
      const answers: Record<string, boolean> = {};
      for (const item of c.items) answers[item.id] = msg.answers[item.id] === true;
      const consented = c.items.every((i) => !i.required || answers[i.id]);
      this.seatEvent(
        seat,
        "ConsentRecorded",
        "player",
        {
          formVersion: c.version,
          textSha256: c.sha256,
          answers,
          consented,
          durationMs: msg.durationMs,
        },
        msg.clientTs,
      );
    });
  }

  submitDemographics(
    seat: number,
    msg: { formVersion: string; answers: Record<string, string>; durationMs: number; clientTs: number },
  ) {
    this.run(() => {
      this.requireStep(seat, "demographics");
      const form = this.onboarding.demographics;
      if (msg.formVersion !== form.version)
        throw new CommandError("The questionnaire has changed — please reload");
      const answers: Record<string, string> = {};
      for (const q of form.questions) {
        const v = msg.answers[q.id];
        if (v === undefined) throw new CommandError(`Please answer: ${q.text}`);
        if (!q.options.some((o) => o.value === v)) throw new CommandError(`Invalid answer for '${q.id}'`);
        answers[q.id] = v;
      }
      if (Object.keys(msg.answers).length !== form.questions.length)
        throw new CommandError("Unexpected answers");
      this.seatEvent(
        seat,
        "DemographicsSubmitted",
        "player",
        { formVersion: form.version, answers, durationMs: msg.durationMs },
        msg.clientTs,
      );
    });
  }

  acknowledgeBriefing(seat: number, msg: { textSha256: string; durationMs: number; clientTs: number }) {
    this.run(() => {
      this.requireStep(seat, "briefing");
      if (msg.textSha256 !== this.onboarding.briefing.sha256) {
        throw new CommandError("The briefing has changed — please reload the page");
      }
      this.seatEvent(
        seat,
        "BriefingAcknowledged",
        "player",
        { textSha256: msg.textSha256, durationMs: msg.durationMs },
        msg.clientTs,
      );
    });
  }

  /* ═════════════════════════ audio: mic check ═════════════════════════ */

  private requireAudio() {
    if (!this.state.audio.enabled) throw new CommandError("This session does not record audio");
  }

  /**
   * The player's own mic check (the last onboarding step, part 1 of "Mic check & calibration").
   * Held while any real seat has not finished the steps before it (see micCheckHoldSeats): no
   * microphone opens before everyone has agreed and is ready.
   */
  submitMicCheck(seat: number, msg: MicCheckResult) {
    this.run(() => {
      this.requireAudio();
      this.requireStep(seat, "mic_check");
      if (isMicCheckHeld(this.state))
        throw new CommandError("Please wait: the others have not finished the briefing yet");
      this.seatEvent(
        seat,
        "MicCheckCompleted",
        "player",
        {
          passed: msg.passed,
          attempts: msg.attempts,
          durationMs: msg.durationMs,
          settings: msg.settings,
          noiseFloorDb: msg.noiseFloorDb,
          speechDb: msg.speechDb,
          speechMs: msg.speechMs,
        },
        msg.clientTs,
      );
    });
  }

  /** Facilitator: skip a seat's mic check (e.g. no working microphone). The seat is then not recorded. */
  skipMicCheck(seat: number, reason: string) {
    this.run(() => {
      this.requireAudio();
      this.requirePhase("onboarding");
      const s = this.requireSeat(seat);
      if (!s.bound || s.withdrawn) throw new CommandError(`Seat ${seat} is not active`);
      if (!micCheckApplies(this.state, s))
        throw new CommandError(`The mic check does not apply to seat ${seat} (no audio consent)`);
      if (s.micCheck !== "pending")
        throw new CommandError(`The mic check of seat ${seat} is already ${s.micCheck}`);
      this.seatEvent(seat, "MicCheckSkipped", "facilitator", { seat, reason });
    });
  }

  /* ═════════════════════════ audio: live ingest ═════════════════════════ */

  /** A seat's browser starts a track (`audio:start`; gates and acks: see audio/live.ts). */
  submitAudioStart(seat: number, msg: AudioStartMsg): Promise<AudioAck> {
    return this.audio.start(seat, msg);
  }

  /** A chunk of a seat's track (`audio:chunk`). */
  submitAudioChunk(seat: number, msg: AudioChunkMsg): ReturnType<LiveAudio["chunk"]> {
    return this.audio.chunk(seat, msg);
  }

  /** A seat's browser stopped a track (`audio:stop`). */
  submitAudioStop(seat: number, msg: AudioStopMsg): AudioAck {
    return this.audio.stop(seat, msg);
  }

  /**
   * A seat's mic meter reading (`audio:level`, volatile): kept in the seat monitor only while the
   * seat may be recorded at all. Returns whether it was kept.
   */
  submitMicLevel(seat: number, level: MicLevelReading): boolean {
    if (this.audio.refusal(seat) !== null) return false;
    this.monitor.micLevel(seat, level);
    return true;
  }

  /* ═════════════════════════ audio: recording pause ═════════════════════════ */

  /**
   * Facilitator: pause recording for every seat. The server closes every open track at once
   * (reason `paused`) and from now on stores nothing captured after this moment: chunks still in
   * flight are kept up to the pause and cut there (see audio/live.ts). A running calibration ends.
   */
  pauseRecording(reason?: string) {
    this.run(() => {
      this.requireAudio();
      if (!RECORDING_PHASES.has(this.state.phase))
        throw new CommandError(`Nothing is recorded in phase '${this.state.phase}'`);
      if (this.state.audio.recordingPaused) throw new CommandError("Recording is already paused");
      this.append({
        type: "RecordingPaused",
        actorKind: "facilitator",
        payload: reason ? { reason } : {},
      });
      this.calibration.cancel("Recording was paused during the calibration (run it again)");
    });
  }

  /** Facilitator: resume recording; every recorded seat's browser starts a new track (reason `resume`). */
  resumeRecording() {
    this.run(() => {
      this.requireAudio();
      if (this.isFinal) throw new CommandError("Session has ended");
      if (!this.state.audio.recordingPaused) throw new CommandError("Recording is not paused");
      this.append({ type: "RecordingResumed", actorKind: "facilitator", payload: {} });
    });
  }

  /* ═════════════════════════ audio: calibration ═════════════════════════ */

  /**
   * Player: ready for the calibration (part 2 of "Mic check & calibration"), so its turns never start
   * by surprise. When this was the last recorded seat, the calibration starts (see run).
   */
  sayCalibrationReady(seat: number, msg: { clientTs: number }) {
    this.run(() => {
      this.requireAudio();
      const s = this.requireSeat(seat);
      if (!canSayCalibrationReady(this.state, s)) {
        if (this.state.audio.calibration.ready.includes(seat)) return; // a resend: already ready
        throw new CommandError("The calibration is not waiting for you now");
      }
      this.seatEvent(seat, "CalibrationReady", "player", {}, msg.clientTs);
    });
  }

  /**
   * Facilitator: start the waiting calibration now, in the onboarding or between rounds. It also
   * starts by itself (autoStartCalibration); either way only once every recorded seat is ready.
   * The turns, their timing and the quick check: see CalibrationRunner.
   */
  startCalibration() {
    this.run(() => {
      this.requireAudio();
      this.requirePhase("onboarding", "round_complete");
      this.calibrationCommand(() => this.calibration.start("facilitator"));
    });
  }

  /** Facilitator: run the calibration again; everyone says again that they are ready (see CalibrationRunner.redo). */
  redoCalibration() {
    this.run(() => {
      this.requireAudio();
      this.requirePhase("onboarding", "round_complete");
      this.calibrationCommand(() => this.calibration.redo());
    });
  }

  /**
   * Start the calibration once the room is ready for it (calibrationReadyToStart): the last seat
   * said it is ready, or what it waited for went away (a seat withdrew, its mic check was skipped,
   * recording resumed). Inside the outermost command, so its events go out in the same batch.
   */
  private autoStartCalibration() {
    if (this.isFinal || !calibrationReadyToStart(this.state)) return;
    try {
      this.calibration.start("system");
    } catch (e) {
      if (!(e instanceof CalibrationError)) throw e;
      this.deps.log.warn({ sessionId: this.sessionId, reason: e.message }, "calibration did not start");
    }
  }

  /** Facilitator: skip the calibration, or cancel a running one (round 1 may then start without it). */
  skipCalibration(reason: string) {
    this.run(() => {
      this.requireAudio();
      if (this.isFinal) throw new CommandError("Session has ended");
      this.calibrationCommand(() => this.calibration.skip(reason));
    });
  }

  /** A calibration refusal is a command refusal (shown to the facilitator). */
  private calibrationCommand(fn: () => void) {
    try {
      fn();
    } catch (e) {
      if (e instanceof CalibrationError) throw new CommandError(e.message);
      throw e;
    }
  }

  /* ═════════════════════════ telemetry and presence ═════════════════════════ */

  /**
   * A seat's telemetry batch: stored only for a participant whose consent was given or skipped and
   * who has not withdrawn, while the session has not ended; items that do not parse are dropped. Returns how many items
   * were stored and the live ones among them (for the facilitator pages open now).
   */
  submitTelemetry(
    seat: number,
    batch: { clockOffsetMs: number; items: readonly unknown[] },
  ): { stored: number; live: StoredTelemetry[] } {
    const none = { stored: 0, live: [] };
    const code = this.collectsInteraction(seat);
    if (!code) return none;
    const items: TelemetryItem[] = [];
    for (const raw of batch.items) {
      const it = parseTelemetryItem(raw);
      if (it) items.push(it);
    }
    if (items.length === 0) return none;
    const stored = this.deps.store.insertTelemetry(
      this.sessionId,
      seat,
      code,
      this.state.round,
      batch.clockOffsetMs,
      items,
    );
    return { stored: stored.length, live: this.monitor.telemetry(seat, items, stored, this.clock()) };
  }

  /**
   * The region a seat's player points at now (`presence`, volatile: never stored). Kept and shown
   * live under the same rule as telemetry. Returns whether it was kept (the hub relays it then).
   */
  submitPresence(seat: number, regionId: string | null): boolean {
    if (!this.collectsInteraction(seat)) return false;
    this.monitor.hover(seat, regionId);
    return true;
  }

  /**
   * The participant code of a seat whose interaction (telemetry, hover) may be collected now, or
   * null: only after consent was given or skipped, never after withdrawal, while the session runs.
   */
  private collectsInteraction(seat: number): string | null {
    const s = this.state.seats[seat];
    if (!s?.participantCode || this.isFinal) return null;
    if (s.consent !== "given" && s.consent !== "skipped") return null;
    if (s.withdrawn) return null;
    return s.participantCode;
  }

  /* ═════════════════════════ intents ═════════════════════════ */

  /** The next unused clientSeq of a seat (for intents that do not come from a browser, i.e. agents). */
  nextClientSeq(seat: number): number {
    return (this.lastClientSeq.get(seat) ?? 0) + 1;
  }

  intent(
    seat: number,
    msg: { clientSeq: number; kind: ActionKind; regionId: string; clientTs: number },
  ): IntentAck {
    return this.run(() => {
      const last = this.lastClientSeq.get(seat) ?? 0;
      if (msg.clientSeq <= last) {
        const cached = this.ackCache.get(seat)?.get(msg.clientSeq);
        return cached
          ? { ...cached, duplicate: true }
          : { ok: false, reason: "duplicate", detail: "Already processed", duplicate: true };
      }
      this.lastClientSeq.set(seat, msg.clientSeq);
      const stored = this.pending.length;
      let ack: IntentAck;
      try {
        ack = this.processIntent(seat, msg);
      } catch (e) {
        // nothing logged for it (e.g. SQLITE_BUSY): the browser's resend must be processed, not refused as a duplicate
        if (this.pending.length === stored) this.lastClientSeq.set(seat, last);
        throw e;
      }
      this.rememberAck(seat, msg.clientSeq, ack);
      return ack;
    });
  }

  /** Keep the answer to an intent for resends (the last ACK_CACHE_SIZE per seat). */
  private rememberAck(seat: number, clientSeq: number, ack: IntentAck) {
    let cache = this.ackCache.get(seat);
    if (!cache) {
      cache = new Map();
      this.ackCache.set(seat, cache);
    }
    cache.set(clientSeq, ack);
    if (cache.size > ACK_CACHE_SIZE) cache.delete(cache.keys().next().value!);
  }

  private processIntent(
    seat: number,
    msg: { clientSeq: number; kind: ActionKind; regionId: string; clientTs: number },
  ): IntentAck {
    const st = this.state;
    const v = validateIntent(st, seat, { kind: msg.kind, regionId: msg.regionId });
    if (!v.ok) {
      this.seatEvent(
        seat,
        "IntentRejected",
        "player",
        { kind: msg.kind, regionId: msg.regionId, reason: v.reason, detail: v.detail },
        msg.clientTs,
        msg.clientSeq,
      );
      return { ok: false, reason: v.reason, detail: v.detail };
    }
    const onRegion = st.actions.filter(
      (a) => a.round === st.round && !a.revoked && a.regionId === msg.regionId,
    );
    const seatsWith = (kind: ActionKind) =>
      [...new Set(onRegion.filter((a) => a.kind === kind).map((a) => a.seat))].sort((a, b) => a - b);
    const payload: PayloadOf<"ProposalMade"> = {
      regionId: msg.regionId,
      quotaUsed: quotaUsed(st, seat, msg.kind) + 1,
      quotaLimit: quotaLimit(st, msg.kind),
      priorProposals: seatsWith("propose"),
      priorDecisions: seatsWith("decide"),
      msSinceRoundStart: Math.round(roundActiveMs(st, this.clock())),
      // the game rules run once, here; the event records their effect (see game/rules.ts)
      scoreChanges: scoreChangesForIntent(st, seat, { kind: msg.kind, regionId: msg.regionId }),
    };
    const type = msg.kind === "propose" ? "ProposalMade" : "DecisionMade";
    const ev = this.seatEvent(seat, type, "player", payload, msg.clientTs, msg.clientSeq);
    this.afterAction();
    return { ok: true, seq: ev.seq };
  }

  /** Check round completion after anything that may complete it. */
  private afterAction() {
    if (this.state.phase === "round_active" && roundIsComplete(this.state)) {
      this.completeRound("quota_met", false);
    }
  }

  /* ═════════════════════════ timers ═════════════════════════ */

  private armTimers() {
    if (this.roundTimer) clearTimeout(this.roundTimer);
    this.roundTimer = null;
    const st = this.state;
    if (st.phase === "round_active" && !st.paused) {
      const remaining = roundRemainingMs(st, this.clock());
      if (remaining !== null) {
        const round = st.round;
        this.roundTimer = setTimeout(() => {
          this.roundTimer = null;
          try {
            this.run(() => {
              if (this.state.phase === "round_active" && this.state.round === round && !this.state.paused) {
                this.completeRound("time_limit", false);
              }
            });
          } catch (e) {
            this.deps.log.error({ err: e }, "round timer failed");
          }
        }, remaining);
      }
    }
    if (
      st.phase === "round_complete" &&
      st.config.roundAdvance === "auto" &&
      st.round < st.config.roundCount
    ) {
      if (this.advanceTimer) clearTimeout(this.advanceTimer);
      const endedTs = st.rounds.at(-1)?.endedTs ?? this.clock();
      const delay = Math.max(0, endedTs + st.config.autoAdvanceDelaySec * 1000 - this.clock());
      this.advanceTimer = setTimeout(() => {
        this.advanceTimer = null;
        try {
          if (this.state.phase === "round_complete") this.startRound("auto");
        } catch (e) {
          this.deps.log.error({ err: e }, "auto-advance failed");
        }
      }, delay);
    }
  }
}
