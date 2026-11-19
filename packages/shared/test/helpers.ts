import {
  AUDIO_CONSENT_ITEM,
  applyEvent,
  cellId,
  cellsOf,
  type EventType,
  type GameState,
  initialState,
  type KLabel,
  type OnboardingStep,
  onboardingStepsFor,
  type PayloadOf,
  quotaUsed,
  regionsOf,
  roundSpecFor,
  type Scenario,
  type Scores,
  type SessionConfigInput,
  SessionConfigSchema,
  type StoredEvent,
  scoreChangesForIntent,
  standardRules,
  validateIntent,
} from "../src";

/** Builds a sequence of stored events for tests, with increasing seq and timestamps. */
export class EventLog {
  events: StoredEvent[] = [];
  state: GameState = initialState();
  private ts = 1_700_000_000_000;
  constructor(public sessionId = "S-TEST-0001") {}

  push<T extends EventType>(
    type: T,
    payload: PayloadOf<T>,
    opts: { seat?: number | null; code?: string | null; actor?: StoredEvent["actorKind"]; dt?: number } = {},
  ): StoredEvent {
    this.ts += opts.dt ?? 1000;
    const ev = {
      sessionId: this.sessionId,
      seq: this.events.length + 1,
      type,
      actorKind: opts.actor ?? "system",
      seat: opts.seat ?? null,
      participantCode: opts.code ?? null,
      round: this.state.round,
      serverTs: this.ts,
      serverWall: new Date(this.ts).toISOString(),
      clientTs: null,
      clientSeq: null,
      payload,
    } as StoredEvent;
    this.events.push(ev);
    applyEvent(this.state, ev);
    return ev;
  }
}

/** 2 × 2 squares (A1 B1 / A2 B2) = 16 sub-squares. */
export const TEST_BOARD = { cols: 2, rows: 2 };

/** Starting scores: 5 everywhere, except square A1 (Ka 5, Kb 9, Kc 0, Kd 1) for range tests. */
export const TEST_SCORES: Scores = {
  ...Object.fromEntries(cellsOf(TEST_BOARD).map((id) => [id, 5])),
  "A1-Ka": 5,
  "A1-Kb": 9,
  "A1-Kc": 0,
  "A1-Kd": 1,
};

export const testScenario: Scenario = {
  id: "test",
  title: "Test",
  version: "1",
  description: "",
  board: TEST_BOARD,
  views: {
    Ka: { name: "View A", description: "" },
    Kb: { name: "View B", description: "" },
    Kc: { name: "View C", description: "" },
    Kd: { name: "View D", description: "" },
  },
  regions: regionsOf(TEST_BOARD),
  initialScores: TEST_SCORES,
  hash: "test",
};

/** The board/scores/rules part of a SessionCreated payload for the test scenario. */
export const TEST_MAP = {
  regionIds: testScenario.regions.map((r) => r.id),
  board: TEST_BOARD,
  initialScores: TEST_SCORES,
  rules: { id: standardRules.id, version: standardRules.version },
};

export const code = (seat: number) => `WK-TEST-000${seat}-X`;

export interface SessionSetup {
  config?: SessionConfigInput;
  sessionId?: string;
  /** A random agent in every seat instead of real players. */
  agents?: boolean;
  /** Seats taken by fake players (no participant code, never connected). */
  fakeSeats?: number[];
  /** The OnboardingStarted steps (default: the ones the config asks for). */
  steps?: OnboardingStep[];
}

/** A session in onboarding: every seat bound, connected and labelled, no onboarding step done yet. */
export function newSession(setup: SessionSetup = {}): EventLog {
  const { agents = false, fakeSeats = [] } = setup;
  const log = new EventLog(setup.sessionId);
  const config = SessionConfigSchema.parse(setup.config ?? {});
  log.push(
    "SessionCreated",
    {
      config,
      scenario: { id: "test", title: "Test", version: "1", hash: "test" },
      ...TEST_MAP,
      viewIds: ["Ka", "Kb", "Kc", "Kd"],
      harness: { version: "0", gitCommit: "test" },
      notes: "",
    },
    { actor: "facilitator" },
  );
  for (let seat = 1; seat <= config.seatCount; seat++) {
    if (agents) {
      log.push(
        "AgentBound",
        { seat, policy: "random", policyVersion: "2", params: { proposeBias: 0.5 }, seed: `S:${seat}` },
        { seat },
      );
    } else if (fakeSeats.includes(seat)) {
      log.push(
        "SeatBound",
        { seat, terminal: seat, bindingId: `b${seat}`, fake: true },
        { seat, actor: "facilitator" },
      );
    } else {
      log.push(
        "SeatBound",
        { seat, terminal: seat, bindingId: `b${seat}` },
        { seat, code: code(seat), actor: "facilitator" },
      );
      log.push("PlayerConnected", { seat, reconnect: false }, { seat, code: code(seat) });
    }
  }
  const K = ["Ka", "Kb", "Kc", "Kd"] as const;
  const P = ["Pa", "Pb", "Pc", "Pd"] as const;
  log.push(
    "LabelsAssigned",
    {
      assignments: Array.from({ length: config.seatCount }, (_, i) => ({
        seat: i + 1,
        k: K[i]!,
        p: P[i]!,
        view: K[i]!,
      })),
      method: "manual",
      seed: null,
      pairing: { mode: "aligned", id: null },
    },
    { actor: "facilitator" },
  );
  log.push(
    "OnboardingStarted",
    { steps: setup.steps ?? onboardingStepsFor(config) },
    { actor: "facilitator" },
  );
  return log;
}

/** A session with every seat bound, labelled and onboarded, ready for round 1. */
export function readySession(config: SessionConfigInput = {}): EventLog {
  const log = newSession({ config });
  for (let seat = 1; seat <= log.state.config.seatCount; seat++) onboard(log, seat);
  return log;
}

export const FULL_CONSENT = { participate: true, [AUDIO_CONSENT_ITEM]: true };

export const MIC_OK = {
  passed: true,
  attempts: 1,
  durationMs: 9000,
  settings: { sampleRate: 48000, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  noiseFloorDb: -60,
  speechDb: -22,
  speechMs: 2500,
};

export function consent(
  log: EventLog,
  seat: number,
  answers: Record<string, boolean> = FULL_CONSENT,
  consented = true,
) {
  log.push(
    "ConsentRecorded",
    { formVersion: "1", textSha256: "x", answers, consented, durationMs: 1 },
    { seat, code: code(seat), actor: "player" },
  );
}

export function micCheck(log: EventLog, seat: number, passed = true) {
  log.push("MicCheckCompleted", { ...MIC_OK, passed }, { seat, code: code(seat), actor: "player" });
}

/** The onboarding steps after consent: mic check (if used), demographics and briefing. */
export function afterConsent(log: EventLog, seat: number) {
  if (log.state.onboardingSteps.includes("mic_check")) micCheck(log, seat);
  log.push(
    "DemographicsSubmitted",
    { formVersion: "1", answers: { age: "25_34" }, durationMs: 1 },
    { seat, code: code(seat), actor: "player" },
  );
  log.push(
    "BriefingAcknowledged",
    { textSha256: "y", durationMs: 1 },
    { seat, code: code(seat), actor: "player" },
  );
}

/** Full consent, then the rest of onboarding. */
export function onboard(log: EventLog, seat: number) {
  consent(log, seat);
  afterConsent(log, seat);
}

export function startRound(log: EventLog, round = 1) {
  log.push(
    "RoundStarted",
    { round, spec: roundSpecFor(log.state.config, round), startedBy: "facilitator" },
    { actor: "facilitator" },
  );
}

/** The sub-square of `square` that `seat` acts on (standard rules: its power type's letter). */
export function targetOf(log: EventLog, seat: number, square: string): string {
  const p = log.state.seats[seat]!.p!;
  return cellId(square, `K${p[1]}` as KLabel);
}

/** Validate and record an action on a square, the way the server does (score changes included). */
export function act(log: EventLog, seat: number, kind: "propose" | "decide", square: string) {
  const st = log.state;
  const regionId = square.includes("-") ? square : targetOf(log, seat, square);
  const v = validateIntent(st, seat, { kind, regionId });
  if (!v.ok) return v;
  const type = kind === "propose" ? "ProposalMade" : "DecisionMade";
  log.push(
    type,
    {
      regionId,
      quotaUsed: quotaUsed(st, seat, kind) + 1,
      quotaLimit: st.roundSpec!.quota[kind],
      priorProposals: [],
      priorDecisions: [],
      msSinceRoundStart: 0,
      scoreChanges: scoreChangesForIntent(st, seat, { kind, regionId }),
    },
    { seat, code: code(seat), actor: "player" },
  );
  return v;
}
