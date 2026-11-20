import type { Board, Scores } from "./board";
import { type FakePlayerPace, type RoundSpec, type SessionConfig, SessionConfigSchema } from "./config";
import type { ActionKind, KLabel, LabelPairing, PLabel } from "./labels";

export const PHASES = [
  "lobby",
  "onboarding",
  "round_active",
  "round_complete",
  "game_complete",
  "closed",
  "aborted",
] as const;
export type Phase = (typeof PHASES)[number];

export type ConsentStatus = "pending" | "given" | "declined" | "skipped";
/**
 * Every onboarding step, in the order a player of a new session does them. `mic_check` is used only
 * when the session records audio: it comes last, as part 1 of "Mic check & calibration", and opens
 * once every seat has finished the steps before it. (A session keeps the order it logged in
 * OnboardingStarted: sessions from before had the mic check right after consent.)
 */
export const ONBOARDING_STEPS = ["consent", "demographics", "briefing", "mic_check"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
/** Name of each onboarding step, as the player's stepper and the facilitator's summaries show it. */
export const STEP_LABEL: Record<OnboardingStep, string> = {
  consent: "Consent",
  mic_check: "Mic check & calibration",
  demographics: "About you",
  briefing: "Briefing",
};
/** A seat's own mic check: still to do, passed, or skipped by the facilitator (then the seat is not recorded). */
export type MicCheckStatus = "pending" | "passed" | "skipped";
export type CalibrationStatus = "pending" | "running" | "done" | "skipped";

/** The agent playing a seat of a simulated session, as logged in `AgentBound`. */
export interface AgentSeat {
  policy: string;
  policyVersion: string;
  params: Record<string, unknown>;
  seed: string;
}

export interface SeatState {
  seat: number;
  bound: boolean;
  participantCode: string | null;
  terminal: number | null;
  bindingId: string | null;
  bindingSeq: number | null;
  k: KLabel | null;
  p: PLabel | null;
  view: string | null;
  consent: ConsentStatus;
  demographics: boolean;
  briefing: boolean;
  connected: boolean;
  everConnected: boolean;
  reconnects: number;
  rejections: number;
  withdrawn: boolean;
  lastActionTs: number | null;
  /** The agent playing this seat (simulated sessions); null for a real participant or a fake player. */
  agent: AgentSeat | null;
  /** Played by a fake player: a test client the server created (no participant, no code, no onboarding). */
  fake: boolean;
  /** Pace of the fake player (null unless `fake`). */
  fakePace: FakePlayerPace | null;
  /** The seat's own mic check (audio sessions): pending, passed, or skipped by the facilitator. */
  micCheck: MicCheckStatus;
  /**
   * The participant permitted audio recording: consent was given AND the audio consent item
   * (`audio_recording`) was ticked. A consent of `skipped` never counts.
   */
  audioConsent: boolean;
}

export interface ActionRecord {
  seq: number;
  kind: ActionKind;
  seat: number;
  /** Target sub-square, e.g. "C7-Kb". */
  regionId: string;
  round: number;
  serverTs: number;
  revoked: boolean;
  /** The seat's knowledge type when it acted. */
  k: KLabel | null;
  /** The seat's power type when it acted. */
  p: PLabel | null;
}

export interface RoundRecord {
  round: number;
  spec: RoundSpec;
  startedTs: number;
  endedTs: number | null;
  reason: "quota_met" | "time_limit" | "facilitator" | null;
}

/** One seat's turn in the calibration (server clock). */
export interface CalibrationTurnRecord {
  seat: number;
  sentenceId: string;
  startTs: number;
  /** null while the turn is running (nominal end: startTs + turnMs). */
  endTs: number | null;
}

/** Quick quality check after the calibration: how much louder each seat's own voice is on its own mic. */
export interface CalibrationQuality {
  perSeat: Array<{
    seat: number;
    /** Level of the seat's own voice on its own mic during its turn (dBFS; null = no audio). */
    ownDb: number | null;
    /** Loudest level of that voice on another seat's mic (dBFS; null = no audio). */
    bestOtherDb: number | null;
    /** ownDb − bestOtherDb (dB); null when either is missing. */
    marginDb: number | null;
    ok: boolean;
  }>;
  ok: boolean;
  /** When the check was logged (server clock). */
  checkedTs: number;
}

export interface CalibrationState {
  status: CalibrationStatus;
  /** Seats in turn order (from CalibrationStarted). */
  order: number[];
  /** Sentence of each turn, parallel to `order`. */
  sentenceIds: string[];
  /** Length of one turn and of the gap between turns (ms; null before calibration started). */
  turnMs: number | null;
  gapMs: number | null;
  /** Index into `order` of the turn running now (null = no turn running). */
  turnIndex: number | null;
  turns: CalibrationTurnRecord[];
  startedTs: number | null;
  completedTs: number | null;
  quality: CalibrationQuality | null;
  /**
   * Seats that said they are ready for the next run (CalibrationReady), in the order they did; the
   * server starts the turns once every recorded seat is. Emptied when a run starts or is requested again.
   */
  ready: number[];
  /**
   * A run was asked for again (CalibrationRequested, or the server's cancel of a running one): in a
   * round break, the players are then asked to say they are ready (before round 1 they always are).
   */
  requested: boolean;
  /**
   * The server's cancel of the latest run (CalibrationSkipped with `cancelled`: status back to
   * pending), with its reason and time; null once a calibration starts again, or if none was cancelled.
   */
  lastCancel: { reason: string; ts: number } | null;
}

/** Audio recording state of the session (see audio.ts and recordingVerdict). */
export interface AudioState {
  /** The session records audio (config.audio.enabled; never for simulated sessions). */
  enabled: boolean;
  /** Round 1 waits for the calibration to be done or skipped. */
  requireCalibration: boolean;
  /** The facilitator paused recording for every seat. */
  recordingPaused: boolean;
  /** When the current pause began (server clock; null while recording is not paused). */
  pausedTs: number | null;
  /** The facilitator's reason for the current pause (null when none was given or not paused). */
  pauseReason: string | null;
  /**
   * Every recording pause so far (server clock), oldest first; `toTs` is null while it lasts (also
   * when the game completed during it). Audio captured in a pause is never stored.
   */
  pauses: Array<{ fromTs: number; toTs: number | null }>;
  /** When the game was complete (server clock; null before): audio captured from then on is never stored. */
  gameCompleteTs: number | null;
  /** How many calibrations were started (CalibrationStarted events): the number of the latest run. */
  calibrationRuns: number;
  calibration: CalibrationState;
}

/** A read-only view of a value, all the way down (functions are kept as they are). */
export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends ReadonlyArray<infer U>
    ? ReadonlyArray<DeepReadonly<U>>
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

/**
 * The game state as everything outside the reducer sees it: read-only. Only `applyEvent` (and
 * `afterReplay`) change a `GameState`; the server, projections, rules and UI read it.
 */
export type ReadonlyGameState = DeepReadonly<GameState>;
export type ReadonlySeatState = DeepReadonly<SeatState>;

export interface GameState {
  sessionId: string | null;
  createdTs: number | null;
  config: SessionConfig;
  scenario: { id: string; title: string; version: string; hash: string } | null;
  regionIds: string[];
  viewIds: string[];
  /** Grid map of the session (null for sessions recorded before the grid map). */
  board: Board | null;
  /** Game rules recorded at creation (see game/rules.ts and docs/GAME-RULES.md). */
  rules: { id: string; version: string } | null;
  /** Starting score of every sub-square (from the scenario). */
  initialScores: Scores;
  /** Current score of every sub-square: the starting scores plus every recorded score change. */
  scores: Scores;
  phase: Phase;
  onboardingSteps: OnboardingStep[];
  /** K–P pairing of the latest label assignment (null before labels are assigned). */
  labelPairing: LabelPairing | null;
  paused: boolean;
  pauseReason: "facilitator" | "disconnect" | null;
  pausedSince: number | null;
  round: number;
  roundSpec: RoundSpec | null;
  roundStartedTs: number | null;
  roundPausedMs: number;
  rounds: RoundRecord[];
  seats: Record<number, SeatState>;
  actions: ActionRecord[];
  broadcasts: Array<{ seq: number; text: string; serverTs: number }>;
  notes: Array<{ seq: number; text: string; serverTs: number }>;
  endReason: string | null;
  /** Microphone recording and calibration (inactive unless config.audio.enabled). */
  audio: AudioState;
  lastSeq: number;
  lastTs: number | null;
}

export function emptySeat(seat: number): SeatState {
  return {
    seat,
    bound: false,
    participantCode: null,
    terminal: null,
    bindingId: null,
    bindingSeq: null,
    k: null,
    p: null,
    view: null,
    consent: "pending",
    demographics: false,
    briefing: false,
    connected: false,
    everConnected: false,
    reconnects: 0,
    rejections: 0,
    withdrawn: false,
    lastActionTs: null,
    agent: null,
    fake: false,
    fakePace: null,
    micCheck: "pending",
    audioConsent: false,
  };
}

export function emptyCalibration(): CalibrationState {
  return {
    status: "pending",
    order: [],
    sentenceIds: [],
    turnMs: null,
    gapMs: null,
    turnIndex: null,
    turns: [],
    startedTs: null,
    completedTs: null,
    quality: null,
    ready: [],
    requested: false,
    lastCancel: null,
  };
}

/** Does a session with this config record audio? Never a simulated one. */
export function audioEnabled(config: Pick<SessionConfig, "players" | "audio">): boolean {
  return config.audio.enabled && config.players !== "simulated";
}

/** Audio state of a new session (recording is never on for simulated sessions). */
export function emptyAudioState(config: SessionConfig): AudioState {
  return {
    enabled: audioEnabled(config),
    requireCalibration: config.audio.requireCalibration,
    recordingPaused: false,
    pausedTs: null,
    pauseReason: null,
    pauses: [],
    gameCompleteTs: null,
    calibrationRuns: 0,
    calibration: emptyCalibration(),
  };
}

export function initialState(): GameState {
  const config = SessionConfigSchema.parse({});
  return {
    sessionId: null,
    createdTs: null,
    config,
    scenario: null,
    regionIds: [],
    viewIds: [],
    board: null,
    rules: null,
    initialScores: {},
    scores: {},
    phase: "lobby",
    onboardingSteps: [],
    labelPairing: null,
    paused: false,
    pauseReason: null,
    pausedSince: null,
    round: 0,
    roundSpec: null,
    roundStartedTs: null,
    roundPausedMs: 0,
    rounds: [],
    seats: {},
    actions: [],
    broadcasts: [],
    notes: [],
    endReason: null,
    audio: emptyAudioState(config),
    lastSeq: 0,
    lastTs: null,
  };
}

/* ─────────────────────────── Derived helpers ─────────────────────────── */

/**
 * The onboarding steps a session with this config uses, in ONBOARDING_STEPS order (logged in
 * OnboardingStarted). The mic check comes last when the session records audio (never for
 * simulated players): recording starts at each participant's own mic check.
 */
export function onboardingStepsFor(
  config: Pick<SessionConfig, "onboarding" | "audio" | "players">,
): OnboardingStep[] {
  const o = config.onboarding;
  const used: Record<OnboardingStep, boolean> = {
    consent: o.consent,
    mic_check: audioEnabled(config),
    demographics: o.demographics,
    briefing: o.briefing,
  };
  return ONBOARDING_STEPS.filter((step) => used[step]);
}

export function seatList(state: ReadonlyGameState): ReadonlySeatState[] {
  return Object.values(state.seats).sort((a, b) => a.seat - b.seat);
}

/** Is this a session with simulated players (agents) instead of participants? */
export function isSimulated(state: ReadonlyGameState): boolean {
  return state.config.players === "simulated";
}

/** Seats taking part in the game: bound and not withdrawn. */
export function activeSeats(state: ReadonlyGameState): ReadonlySeatState[] {
  return seatList(state).filter((s) => s.bound && !s.withdrawn);
}

/** Seats bound to fake players (test clients the server created), in seat order. */
export function fakeSeats(state: ReadonlyGameState): number[] {
  return seatList(state)
    .filter((s) => s.bound && s.fake)
    .map((s) => s.seat);
}

/** A seat held (or to be held) by a person: not a fake player and not an agent. */
export function isParticipant(seat: ReadonlySeatState): boolean {
  return !seat.fake && !seat.agent;
}

/** Is any bound seat held by a real participant (who has a code, a key-sheet line and a takedown card)? */
export function hasParticipants(state: ReadonlyGameState): boolean {
  return seatList(state).some((s) => s.bound && isParticipant(s));
}

/**
 * Does the mic check apply to this seat? Only when the session records audio and the participant
 * permitted it: nobody who refused (or was never asked) is asked to speak into the microphone.
 */
export function micCheckApplies(state: ReadonlyGameState, seat: ReadonlySeatState): boolean {
  return state.audio.enabled && isParticipant(seat) && seat.audioConsent;
}

/** The session's onboarding steps before its mic check, in its order (none without a mic check step). */
function stepsBeforeMicCheck(state: ReadonlyGameState): readonly OnboardingStep[] {
  const i = state.onboardingSteps.indexOf("mic_check");
  return i < 0 ? [] : state.onboardingSteps.slice(0, i);
}

/**
 * Seats that hold the mic checks: active real participants (bound, not withdrawn, not a fake player
 * or agent) that have not finished every step before the mic check yet: still in consent (or
 * declined), in the questionnaire or in the briefing. Empty unless the session has the mic check step.
 *
 * Every microphone in the room also hears the others, so NO seat may open its mic (start its mic
 * check, and so its recording) while anyone is still in consent: their voice would be recorded
 * before they agreed, or although they then decline. The mic checks and the calibration form one
 * part of the onboarding that the room does together, once every seat is ready (has finished the
 * briefing). To go on without a decliner, the facilitator withdraws that seat. (Sessions from before
 * this order had only consent before the mic check, so only consent holds them.)
 */
export function micCheckHoldSeats(state: ReadonlyGameState): number[] {
  if (!state.audio.enabled) return [];
  const before = stepsBeforeMicCheck(state);
  if (before.length === 0) return [];
  return seatList(state)
    .filter(
      (s) =>
        s.bound &&
        !s.withdrawn &&
        isParticipant(s) &&
        (s.consent !== "given" || before.some((step) => !stepDone(state, s, step))),
    )
    .map((s) => s.seat);
}

/** Are the mic checks held because a seat is still in consent (see micCheckHoldSeats)? */
export function isMicCheckHeld(state: ReadonlyGameState): boolean {
  return micCheckHoldSeats(state).length > 0;
}

/** Is this onboarding step done for the seat? (The mic check counts as done when passed or skipped.) */
function stepDone(state: ReadonlyGameState, seat: ReadonlySeatState, step: OnboardingStep): boolean {
  switch (step) {
    case "consent":
      return seat.consent === "given";
    case "mic_check":
      return !micCheckApplies(state, seat) || seat.micCheck !== "pending";
    case "demographics":
      return seat.demographics;
    case "briefing":
      return seat.briefing;
  }
}

/** Fake players and agents have no onboarding: there is nobody to inform or ask. */
export function isOnboardingComplete(state: ReadonlyGameState, seat: ReadonlySeatState): boolean {
  return nextOnboardingStep(state, seat) === null;
}

/**
 * The next onboarding step a seat still has to do (null = done), in the session's own order
 * (OnboardingStarted; for a new session consent → demographics → briefing → mic_check), skipping
 * the mic check for a participant who did not permit audio recording.
 */
export function nextOnboardingStep(state: ReadonlyGameState, seat: ReadonlySeatState): OnboardingStep | null {
  if (!isParticipant(seat)) return null;
  for (const step of state.onboardingSteps) {
    if (!stepDone(state, seat, step)) return step;
  }
  return null;
}

/** Is the session final in this phase: closed or aborted, so it takes no more events? */
export function isFinalPhase(phase: string): boolean {
  return phase === "closed" || phase === "aborted";
}

/** Has the game ended in this phase: complete, closed or aborted (nothing more is played)? */
export function hasEnded(phase: string): boolean {
  return phase === "game_complete" || isFinalPhase(phase);
}

/** Phases in which audio is recorded: from onboarding (the mic check) until the game is complete. */
export const RECORDING_PHASES: ReadonlySet<Phase> = new Set(["onboarding", "round_active", "round_complete"]);

/**
 * Audio gate for round 1: with audio and `requireCalibration` on, the calibration must be done
 * or skipped first. (The onboarding checks are separate: see isOnboardingComplete.)
 */
export function canStartFirstRound(state: ReadonlyGameState): boolean {
  if (!state.audio.enabled || !state.audio.requireCalibration) return true;
  const status = state.audio.calibration.status;
  return status === "done" || status === "skipped";
}

/**
 * Real seats the calibration waits for: active participants not through their onboarding yet (in a
 * round break: not past their mic check). The calibration only runs once every seat in the room is ready.
 */
export function calibrationWaitingSeats(state: ReadonlyGameState): ReadonlySeatState[] {
  return activeSeats(state).filter(
    (s) =>
      isParticipant(s) &&
      (state.phase === "onboarding"
        ? !isOnboardingComplete(state, s)
        : s.consent !== "given" || (micCheckApplies(state, s) && s.micCheck === "pending")),
  );
}

/** Seats in their own mic check now (onboarding, consent given, check pending): the facilitator may skip them. */
export function seatsInMicCheck(state: ReadonlyGameState): ReadonlySeatState[] {
  if (state.phase !== "onboarding") return [];
  return activeSeats(state).filter(
    (s) => micCheckApplies(state, s) && s.consent === "given" && s.micCheck === "pending",
  );
}

/**
 * The latest calibration turn while the calibration runs, or null. Its nominal end is
 * startTs + turnMs; the gap before the next turn has no event of its own.
 */
export function currentCalibrationTurn(state: ReadonlyGameState): DeepReadonly<CalibrationTurnRecord> | null {
  const c = state.audio.calibration;
  if (c.status !== "running" || c.turnIndex === null) return null;
  const turn = c.turns[c.turns.length - 1];
  return turn && turn.endTs === null ? turn : null;
}

/** Non-revoked actions of a seat (optionally of one kind) in a round. */
export function actionsOf(
  state: ReadonlyGameState,
  seat: number,
  round: number,
  kind?: ActionKind,
): readonly DeepReadonly<ActionRecord>[] {
  return state.actions.filter(
    (a) => a.seat === seat && a.round === round && !a.revoked && (kind === undefined || a.kind === kind),
  );
}

/** Live (non-revoked) actions currently shown on the map. */
export function visibleActions(state: ReadonlyGameState): readonly DeepReadonly<ActionRecord>[] {
  return state.actions.filter(
    (a) => !a.revoked && (!state.config.clearHighlightsEachRound || a.round === state.round),
  );
}

/** Milliseconds of active (un-paused) time elapsed in the current round at time `now`. */
export function roundActiveMs(state: ReadonlyGameState, now: number): number {
  if (state.roundStartedTs === null) return 0;
  const pausedNow = state.paused && state.pausedSince !== null ? now - state.pausedSince : 0;
  return Math.max(0, now - state.roundStartedTs - state.roundPausedMs - pausedNow);
}

/** Remaining ms of the round's time limit (null = no limit). */
export function roundRemainingMs(state: ReadonlyGameState, now: number): number | null {
  const limit = state.roundSpec?.timeLimitSec;
  if (!limit || state.phase !== "round_active") return null;
  return Math.max(0, limit * 1000 - roundActiveMs(state, now));
}
