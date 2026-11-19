import { createHmac, timingSafeEqual } from "node:crypto";
import {
  type ActionKind,
  AUDIO_CONSENT_ITEM,
  type AudioSettings,
  activeSeats,
  agentSeed,
  applyEvent,
  calibrationWaitingSeats,
  canStartFirstRound,
  checkSimulationConfig,
  DEFAULT_VALIDATORS,
  DISSOCIATED_PAIRINGS,
  type FakePlayerPace,
  type GameState,
  generateParticipantCode,
  generateSessionId,
  getGameRules,
  getPolicy,
  initialState,
  isMicCheckHeld,
  isOnboardingComplete,
  isSimulated,
  K_LABELS,
  type KLabel,
  type LabelPairing,
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
  quotaLimit,
  quotaUsed,
  RECORDING_PHASES,
  randomCrockford,
  resolvePolicyParams,
  roundActiveMs,
  roundRemainingMs,
  roundSpecFor,
  ruleFor,
  type Scenario,
  type SessionConfig,
  type StoredEvent,
  scoreChangesForIntent,
  scoreChangesForRevoke,
  seatList,
  seatPolicyId,
  seededRandom,
  shouldRecord,
  type Validator,
  validateIntent,
} from "@wkwa/shared";
import type { Logger } from "pino";
import { calibrationCheckedPayload } from "../audio/calibration";
import { LiveAudio } from "../audio/live";
import type { Store } from "../db/store";
import { harnessVersion, nowTs, wall } from "../runtime";

/** Thrown for invalid facilitator commands / player submissions; the message is shown to the user. */
export class CommandError extends Error {}

export type IntentAck =
  | { ok: true; seq: number; duplicate?: boolean }
  | { ok: false; reason: string; detail: string; duplicate?: boolean };

export interface SessionDeps {
  store: Store;
  scenario: Scenario;
  onboarding: OnboardingContent;
  serverSecret: string;
  log: Logger;
  /** Called once per command with every event appended during that command. */
  onEvents: (events: StoredEvent[]) => void;
  clock?: () => number;
  validators?: Validator[];
}

type LabelAssignment = { seat: number; k: KLabel; view?: string };

const FINAL_PHASES = new Set(["closed", "aborted"]);

/** How often the calibration check looks whether the last turn's audio has arrived (ms). */
const CALIBRATION_CHECK_POLL_MS = 500;
/**
 * Longest wait for the calibration audio after the last turn (ms): a 5 s chunk is uploaded once it
 * is complete, so the last turn's audio arrives up to about 5 s later. The check then runs with
 * what arrived; a seat without audio is reported as such.
 */
export const CALIBRATION_CHECK_WAIT_MS = 15_000;

/** The mic check result, as it is logged (MicCheckCompleted). */
export interface MicCheckResult {
  passed: boolean;
  attempts: number;
  durationMs: number;
  settings: AudioSettings;
  noiseFloorDb: number;
  speechDb: number;
  speechMs: number;
  clientTs: number;
}

/**
 * Owns ONE session: validates commands and intents, appends events to the
 * store, applies them to the in-memory state via the shared reducer, and
 * notifies the network layer. All state changes go through `append`.
 */
export class SessionManager {
  readonly state: GameState = initialState();
  private pending: StoredEvent[] = [];
  private depth = 0;
  private roundTimer: NodeJS.Timeout | null = null;
  private advanceTimer: NodeJS.Timeout | null = null;
  private calibrationTimer: NodeJS.Timeout | null = null;
  /** Counts calibration runs; a timer of an earlier run (after a redo or skip) does nothing. */
  private calibrationRun = 0;
  private lastClientSeq = new Map<number, number>();
  private ackCache = new Map<number, Map<number, IntentAck>>();
  private readonly clock: () => number;
  private readonly validators: Validator[];
  /** Live audio ingest: tracks, chunks and the calibration audio of this session (see audio/live.ts). */
  readonly audio: LiveAudio;

  private constructor(
    readonly sessionId: string,
    private readonly deps: SessionDeps,
  ) {
    this.clock = deps.clock ?? nowTs;
    this.validators = deps.validators ?? DEFAULT_VALIDATORS;
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
      applyEvent(m.state, ev);
      m.audio.observe(ev, true);
      if (ev.type === "CalibrationStarted") m.calibrationRun++;
      if (ev.clientSeq !== null && ev.seat !== null) {
        m.lastClientSeq.set(ev.seat, Math.max(m.lastClientSeq.get(ev.seat) ?? 0, ev.clientSeq));
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
    // connection status is not meaningful across restarts (agents are always there)
    for (const s of seatList(m.state)) if (!s.agent) s.connected = false;
    m.run(() => {
      m.audio.recover();
      // the calibration's timers did not survive the restart: end that run (the facilitator can redo it)
      if (m.state.audio.calibration.status === "running" && !m.isFinal) {
        m.append({
          type: "CalibrationSkipped",
          actorKind: "system",
          payload: { reason: "The server restarted during the calibration (run it again)", cancelled: true },
        });
      }
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
    this.clearCalibrationTimer();
    this.audio.endCalibration();
  }

  /** Close every open audio track (e.g. `interrupted` when the hub switches to another session). */
  closeAudioTracks(reason: "interrupted") {
    this.run(() => {
      if (!this.isFinal) this.audio.closeAll(reason);
    });
  }

  get isFinal(): boolean {
    return FINAL_PHASES.has(this.state.phase);
  }

  /* ═════════════════════════ internals ═════════════════════════ */

  /** Run a command; all events appended inside are delivered to onEvents in one batch. */
  private run<T>(fn: () => T): T {
    this.depth++;
    try {
      return fn();
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
    applyEvent(this.state, stored);
    this.pending.push(stored);
    if (this.state.phase !== before) this.deps.store.setSessionStatus(this.sessionId, this.state.phase);
    // close audio tracks the event ends (pause, withdrawal, disconnect, game complete, ...)
    this.audio.observe(stored);
    return stored;
  }

  private codeOf(seat: number): string | null {
    return this.state.seats[seat]?.participantCode ?? null;
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
   * Bind a connected client to a seat. A real client gets a new participant
   * code. A fake player (a test client the server created, `fake: true`) gets
   * none: it is not a participant, so it never appears on the key sheet, on a
   * takedown card or in an erasure.
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
      if (s.bound) {
        this.append({
          type: "SeatUnbound",
          actorKind: "facilitator",
          seat,
          participantCode: s.participantCode,
          payload: { seat, reason: "replaced" },
        });
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
      this.append({
        type: "SeatUnbound",
        actorKind: "facilitator",
        seat,
        participantCode: s.participantCode,
        payload: { seat, reason },
      });
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
    pairingIn: { mode: "aligned" | "dissociated"; id: number | null } = { mode: "aligned", id: null },
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
  randomiseLabels(
    pairing: { mode: "aligned" | "dissociated"; id: number | null } = { mode: "aligned", id: null },
    shuffleK = true,
  ) {
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
      this.append({
        type: "ActionRevoked",
        actorKind: "facilitator",
        seat: a.seat,
        participantCode: this.codeOf(a.seat),
        payload: {
          targetSeq: seq,
          targetType: a.kind === "propose" ? "ProposalMade" : "DecisionMade",
          targetSeat: a.seat,
          regionId: a.regionId,
          reason,
          scoreChanges: scoreChangesForRevoke(this.state, seq),
        },
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
      this.append({
        type: "ParticipantWithdrawn",
        actorKind: "facilitator",
        seat,
        participantCode: s.participantCode,
        payload: { seat, by: "facilitator", phase: this.state.phase },
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
      this.audio.closeAll("closed");
      this.append({ type: "SessionClosed", actorKind: "facilitator", payload: {} });
      this.dispose();
    });
  }

  abort(reason: string) {
    this.run(() => {
      if (this.isFinal) throw new CommandError("Session has already ended");
      this.audio.closeAll("aborted");
      this.append({ type: "SessionAborted", actorKind: "facilitator", payload: { reason } });
      this.dispose();
    });
  }

  /* ═════════════════════════ player connection ═════════════════════════ */

  playerConnected(seat: number) {
    this.run(() => {
      const s = this.state.seats[seat];
      if (!s?.bound || s.withdrawn || s.connected || this.isFinal) return;
      this.append({
        type: "PlayerConnected",
        actorKind: "system",
        seat,
        participantCode: s.participantCode,
        payload: { seat, reconnect: s.everConnected },
      });
    });
  }

  playerDisconnected(seat: number, reason: string) {
    this.run(() => {
      const s = this.state.seats[seat];
      if (!s?.bound || !s.connected || this.isFinal) return;
      this.append({
        type: "PlayerDisconnected",
        actorKind: "system",
        seat,
        participantCode: s.participantCode,
        payload: { seat, reason },
      });
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
      this.append({
        type: "ConsentRecorded",
        actorKind: "player",
        seat,
        participantCode: s.participantCode,
        clientTs: msg.clientTs,
        payload: {
          formVersion: c.version,
          textSha256: c.sha256,
          answers,
          consented,
          durationMs: msg.durationMs,
        },
      });
    });
  }

  submitDemographics(
    seat: number,
    msg: { formVersion: string; answers: Record<string, string>; durationMs: number; clientTs: number },
  ) {
    this.run(() => {
      const s = this.requireStep(seat, "demographics");
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
      this.append({
        type: "DemographicsSubmitted",
        actorKind: "player",
        seat,
        participantCode: s.participantCode,
        clientTs: msg.clientTs,
        payload: { formVersion: form.version, answers, durationMs: msg.durationMs },
      });
    });
  }

  acknowledgeBriefing(seat: number, msg: { textSha256: string; durationMs: number; clientTs: number }) {
    this.run(() => {
      const s = this.requireStep(seat, "briefing");
      if (msg.textSha256 !== this.onboarding.briefing.sha256) {
        throw new CommandError("The briefing has changed — please reload the page");
      }
      this.append({
        type: "BriefingAcknowledged",
        actorKind: "player",
        seat,
        participantCode: s.participantCode,
        clientTs: msg.clientTs,
        payload: { textSha256: msg.textSha256, durationMs: msg.durationMs },
      });
    });
  }

  /* ═════════════════════════ audio: mic check ═════════════════════════ */

  private requireAudio() {
    if (!this.state.audio.enabled) throw new CommandError("This session does not record audio");
  }

  /**
   * The player's own mic check (the step after consent). Held while any real seat is still in
   * consent (see micCheckHoldSeats): no microphone opens before everyone has agreed.
   */
  submitMicCheck(seat: number, msg: MicCheckResult) {
    this.run(() => {
      this.requireAudio();
      const s = this.requireStep(seat, "mic_check");
      if (isMicCheckHeld(this.state))
        throw new CommandError("Please wait: the others are still reading the consent form");
      this.append({
        type: "MicCheckCompleted",
        actorKind: "player",
        seat,
        participantCode: s.participantCode,
        clientTs: msg.clientTs,
        payload: {
          passed: msg.passed,
          attempts: msg.attempts,
          durationMs: msg.durationMs,
          settings: msg.settings,
          noiseFloorDb: msg.noiseFloorDb,
          speechDb: msg.speechDb,
          speechMs: msg.speechMs,
        },
      });
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
      this.append({
        type: "MicCheckSkipped",
        actorKind: "facilitator",
        seat,
        participantCode: s.participantCode,
        payload: { seat, reason },
      });
    });
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
      if (this.state.audio.calibration.status === "running") {
        this.clearCalibrationTimer();
        this.audio.endCalibration();
        this.append({
          type: "CalibrationSkipped",
          actorKind: "system",
          payload: { reason: "Recording was paused during the calibration (run it again)", cancelled: true },
        });
      }
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
   * Facilitator: start the calibration (or run it again with `redo`). Possible once every real
   * seat is past its mic check. Each recorded seat in seat order gets a turn of `turnMs` to read
   * its sentence, then `gapMs` of silence; the server times the turns (CalibrationTurn), logs
   * CalibrationCompleted after the last one and then the quick leakage check (CalibrationChecked)
   * once the turns' audio has arrived. A redo cancels a running calibration and starts afresh.
   */
  startCalibration(redo = false) {
    this.run(() => {
      this.requireAudio();
      this.requirePhase("onboarding", "round_complete");
      const st = this.state;
      const c = st.audio.calibration;
      if (!redo && c.status === "running") throw new CommandError("The calibration is already running");
      if (!redo && c.status !== "pending")
        throw new CommandError(`The calibration was already ${c.status}: use 'redo' to run it again`);
      if (st.audio.recordingPaused) throw new CommandError("Recording is paused: resume recording first");
      const waiting = calibrationWaitingSeats(st).map((s) => s.seat);
      if (waiting.length) throw new CommandError(`Waiting for the mic check of seat ${waiting.join(", ")}`);
      const order = activeSeats(st)
        .filter((s) => shouldRecord(st, s))
        .map((s) => s.seat);
      if (order.length === 0) throw new CommandError("No seat is recorded: skip the calibration instead");
      const content = this.onboarding.audio?.calibration;
      if (!content) throw new CommandError("No calibration texts (config/audio.json)");
      this.clearCalibrationTimer();
      const run = ++this.calibrationRun;
      // a redo reads other sentences than the run before, where there are enough
      const offset = ((run - 1) * order.length) % content.sentences.length;
      const sentenceIds = order.map((_, i) => content.sentences[(offset + i) % content.sentences.length]!.id);
      const { turnMs, gapMs } = content;
      this.append({
        type: "CalibrationStarted",
        actorKind: "facilitator",
        payload: { order, sentenceIds, turnMs, gapMs },
      });
      const start = this.clock();
      this.audio.beginCalibration(run, order, start);
      this.calibrationTurn(run, 0);
    });
  }

  /** Facilitator: skip the calibration, or cancel a running one (round 1 may then start without it). */
  skipCalibration(reason: string) {
    this.run(() => {
      this.requireAudio();
      if (this.isFinal) throw new CommandError("Session has ended");
      const status = this.state.audio.calibration.status;
      if (status === "done" || status === "skipped")
        throw new CommandError(`The calibration was already ${status}`);
      this.clearCalibrationTimer();
      this.audio.endCalibration();
      this.append({ type: "CalibrationSkipped", actorKind: "facilitator", payload: { reason } });
    });
  }

  private clearCalibrationTimer() {
    if (this.calibrationTimer) clearTimeout(this.calibrationTimer);
    this.calibrationTimer = null;
  }

  /** Is calibration run `run` still the one running? (Timers of an earlier run then do nothing.) */
  private calibrationCurrent(run: number, status: "running" | "done" = "running"): boolean {
    return this.calibrationRun === run && this.state.audio.calibration.status === status && !this.isFinal;
  }

  private calibrationTimeout(fn: () => void, ms: number) {
    this.clearCalibrationTimer();
    this.calibrationTimer = setTimeout(() => {
      this.calibrationTimer = null;
      try {
        this.run(fn);
      } catch (e) {
        this.deps.log.error({ err: e, sessionId: this.sessionId }, "calibration timer failed");
      }
    }, ms);
  }

  /** Log turn `index` of run `run` and time the next step (inside a command). */
  private calibrationTurn(run: number, index: number) {
    const c = this.state.audio.calibration;
    const seat = c.order[index]!;
    this.append({
      type: "CalibrationTurn",
      actorKind: "system",
      seat,
      participantCode: this.codeOf(seat),
      payload: { index, seat, sentenceId: c.sentenceIds[index]! },
    });
    const turnMs = c.turnMs ?? 0;
    const last = index >= c.order.length - 1;
    this.calibrationTimeout(
      () => {
        if (!this.calibrationCurrent(run)) return;
        if (last) this.completeCalibration(run);
        else this.calibrationTurn(run, index + 1);
      },
      last ? turnMs : turnMs + (c.gapMs ?? 0),
    );
  }

  /** The last turn is over: log CalibrationCompleted, then wait for the audio and check it (inside a command). */
  private completeCalibration(run: number) {
    const c = this.state.audio.calibration;
    const turnMs = c.turnMs ?? 0;
    const turns = c.turns.map((t) => ({
      seat: t.seat,
      sentenceId: t.sentenceId,
      startTs: t.startTs,
      endTs: t.endTs ?? t.startTs + turnMs,
    }));
    this.append({ type: "CalibrationCompleted", actorKind: "system", payload: { turns } });
    const lastEnd = Math.max(...turns.map((t) => t.endTs));
    const deadline = this.clock() + CALIBRATION_CHECK_WAIT_MS;
    const poll = () => {
      if (!this.calibrationCurrent(run, "done")) return;
      const collector = this.audio.calibration(run);
      if (!collector) return;
      if (!collector.complete(lastEnd) && this.clock() < deadline) {
        this.calibrationTimeout(poll, CALIBRATION_CHECK_POLL_MS);
        return;
      }
      try {
        const report = collector.check(turns);
        this.append({
          type: "CalibrationChecked",
          actorKind: "system",
          payload: calibrationCheckedPayload(report, c.order),
        });
      } finally {
        this.audio.endCalibration(run);
      }
    };
    this.calibrationTimeout(poll, CALIBRATION_CHECK_POLL_MS);
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
      const ack = this.processIntent(seat, msg);
      let cache = this.ackCache.get(seat);
      if (!cache) {
        cache = new Map();
        this.ackCache.set(seat, cache);
      }
      cache.set(msg.clientSeq, ack);
      if (cache.size > 50) cache.delete(cache.keys().next().value!);
      return ack;
    });
  }

  private processIntent(
    seat: number,
    msg: { clientSeq: number; kind: ActionKind; regionId: string; clientTs: number },
  ): IntentAck {
    const st = this.state;
    const code = this.codeOf(seat);
    const v = validateIntent(st, seat, { kind: msg.kind, regionId: msg.regionId }, this.validators);
    if (!v.ok) {
      this.append({
        type: "IntentRejected",
        actorKind: "player",
        seat,
        participantCode: code,
        clientTs: msg.clientTs,
        clientSeq: msg.clientSeq,
        payload: { kind: msg.kind, regionId: msg.regionId, reason: v.reason, detail: v.detail },
      });
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
    const ev = this.append(
      msg.kind === "propose"
        ? {
            type: "ProposalMade",
            actorKind: "player",
            seat,
            participantCode: code,
            clientTs: msg.clientTs,
            clientSeq: msg.clientSeq,
            payload,
          }
        : {
            type: "DecisionMade",
            actorKind: "player",
            seat,
            participantCode: code,
            clientTs: msg.clientTs,
            clientSeq: msg.clientSeq,
            payload,
          },
    );
    this.afterAction();
    return { ok: true, seq: ev.seq };
  }

  /** Check round completion after anything that may complete it. */
  private afterAction() {
    if (this.state.phase === "round_active" && ruleFor(this.state).isComplete(this.state)) {
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
