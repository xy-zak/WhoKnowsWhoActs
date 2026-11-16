import { createHmac, timingSafeEqual } from "node:crypto";
import {
  type ActionKind,
  activeSeats,
  applyEvent,
  DEFAULT_VALIDATORS,
  type GameState,
  generateParticipantCode,
  generateSessionId,
  initialState,
  isOnboardingComplete,
  K_LABELS,
  type KLabel,
  type NewEvent,
  nextOnboardingStep,
  type OnboardingContent,
  type OnboardingStep,
  P_LABELS,
  type PayloadOf,
  type PLabel,
  quotaLimit,
  quotaUsed,
  randomCrockford,
  roundActiveMs,
  roundRemainingMs,
  roundSpecFor,
  ruleFor,
  type Scenario,
  type SessionConfig,
  type StoredEvent,
  seatList,
  type Validator,
  validateIntent,
} from "@wkwa/shared";
import type { Logger } from "pino";
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

type LabelAssignment = { seat: number; k: KLabel; p: PLabel; view?: string };

const FINAL_PHASES = new Set(["closed", "aborted"]);

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
  private lastClientSeq = new Map<number, number>();
  private ackCache = new Map<number, Map<number, IntentAck>>();
  private readonly clock: () => number;
  private readonly validators: Validator[];

  private constructor(
    readonly sessionId: string,
    private readonly deps: SessionDeps,
  ) {
    this.clock = deps.clock ?? nowTs;
    this.validators = deps.validators ?? DEFAULT_VALIDATORS;
  }

  get scenario(): Scenario {
    return this.deps.scenario;
  }
  get onboarding(): OnboardingContent {
    return this.deps.onboarding;
  }

  /* ═════════════════════════ lifecycle ═════════════════════════ */

  static create(deps: SessionDeps, config: SessionConfig, notes: string): SessionManager {
    for (const k of K_LABELS) {
      if (config.viewAssignment === "byKnowledgeType" && !deps.scenario.views[k]) {
        throw new CommandError(
          `Scenario '${deps.scenario.id}' has no view '${k}' (required for byKnowledgeType)`,
        );
      }
    }
    const sessionId = generateSessionId();
    const m = new SessionManager(sessionId, deps);
    const hv = harnessVersion();
    deps.store.insertSession({
      id: sessionId,
      created_wall: wall(m.clock()),
      scenario_id: deps.scenario.id,
      scenario_version: deps.scenario.version,
      scenario_hash: deps.scenario.hash,
      status: "lobby",
      condition: config.condition,
      notes,
      config_json: JSON.stringify(config),
      harness_version: hv.version,
      git_commit: hv.gitCommit,
    });
    m.run(() =>
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
          harness: hv,
          notes,
        },
      }),
    );
    return m;
  }

  /** Rebuild a session from its event log (e.g. after a server restart). */
  static load(deps: SessionDeps, sessionId: string): SessionManager {
    const m = new SessionManager(sessionId, deps);
    const events = deps.store.listEvents(sessionId);
    if (events.length === 0) throw new Error(`Session ${sessionId} has no events`);
    for (const ev of events) {
      applyEvent(m.state, ev);
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
    // connection status is not meaningful across restarts
    for (const s of seatList(m.state)) s.connected = false;
    m.armTimers();
    return m;
  }

  /** Stop timers (call when detaching or shutting down). */
  dispose() {
    if (this.roundTimer) clearTimeout(this.roundTimer);
    if (this.advanceTimer) clearTimeout(this.advanceTimer);
    this.roundTimer = null;
    this.advanceTimer = null;
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

  bindSeat(terminal: number, seat: number): { participantCode: string } {
    return this.run(() => {
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
      let code = generateParticipantCode();
      const inSession = new Set(seatList(this.state).map((x) => x.participantCode));
      while (inSession.has(code) || this.deps.store.codeExists(code)) code = generateParticipantCode();
      this.append({
        type: "SeatBound",
        actorKind: "facilitator",
        seat,
        participantCode: code,
        payload: { seat, terminal, bindingId: `b-${randomCrockford(6)}` },
      });
      return { participantCode: code };
    });
  }

  unbindSeat(seat: number, reason: string) {
    this.run(() => {
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

  setLabels(
    assignments: LabelAssignment[],
    method: "manual" | "random" = "manual",
    seed: string | null = null,
  ) {
    this.run(() => {
      this.requirePhase("lobby", "onboarding", "round_complete");
      const cfg = this.state.config;
      const seats = seatList(this.state).map((s) => s.seat);
      const given = assignments.map((a) => a.seat).sort((a, b) => a - b);
      if (given.length !== seats.length || given.some((s, i) => s !== seats[i])) {
        throw new CommandError(`Assign labels to every seat exactly once (seats ${seats.join(", ")})`);
      }
      if (!cfg.allowDuplicateLabels) {
        if (new Set(assignments.map((a) => a.k)).size !== assignments.length)
          throw new CommandError("Each K label may be used only once");
        if (new Set(assignments.map((a) => a.p)).size !== assignments.length)
          throw new CommandError("Each P label may be used only once");
      }
      const full = assignments.map((a) => {
        const view =
          cfg.viewAssignment === "byKnowledgeType" ? a.k : (a.view ?? this.state.seats[a.seat]?.view ?? a.k);
        if (!this.scenario.views[view]) throw new CommandError(`Scenario has no view '${view}'`);
        return { seat: a.seat, k: a.k, p: a.p, view };
      });
      this.append({
        type: "LabelsAssigned",
        actorKind: "facilitator",
        payload: { assignments: full, method, seed },
      });
    });
  }

  randomiseLabels() {
    const seed = randomCrockford(6);
    const rng = seededRandom(seed);
    const shuffle = <T>(arr: readonly T[]) => {
      const a = [...arr];
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [a[i], a[j]] = [a[j]!, a[i]!];
      }
      return a;
    };
    const ks = shuffle(K_LABELS);
    const ps = shuffle(P_LABELS);
    const assignments = seatList(this.state).map((s, i) => ({
      seat: s.seat,
      k: ks[i % ks.length]!,
      p: ps[i % ps.length]!,
      view: s.view ?? undefined,
    }));
    this.setLabels(assignments, "random", seed);
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
      const o = this.state.config.onboarding;
      const steps: OnboardingStep[] = [];
      if (o.consent) steps.push("consent");
      if (o.demographics) steps.push("demographics");
      if (o.briefing) steps.push("briefing");
      this.append({ type: "OnboardingStarted", actorKind: "facilitator", payload: { steps } });
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
      return null;
    }
    if (st.phase === "round_complete") {
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
      this.append({ type: "SessionClosed", actorKind: "facilitator", payload: {} });
      this.dispose();
    });
  }

  abort(reason: string) {
    this.run(() => {
      if (this.isFinal) throw new CommandError("Session has already ended");
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

  /* ═════════════════════════ intents ═════════════════════════ */

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

/** Small deterministic PRNG so random label assignments are reproducible from their logged seed. */
export function seededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
