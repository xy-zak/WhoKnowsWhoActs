import type { Board, Scores } from "./board";
import {
  AUDIO_CONFIG_DEFAULTS,
  type FakePlayerPace,
  type RoundSpec,
  type SessionConfig,
  SessionConfigSchema,
} from "./config";
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
/** Every onboarding step, in the order a player does them. `mic_check` is used only when the session records audio. */
export const ONBOARDING_STEPS = ["consent", "mic_check", "demographics", "briefing"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
/** Name of each onboarding step, as the player's stepper and the facilitator's summaries show it. */
export const STEP_LABEL: Record<OnboardingStep, string> = {
  consent: "Consent",
  mic_check: "Mic check",
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
   * The server's cancel of the latest run (CalibrationSkipped with `cancelled`: status back to
   * pending), with its reason and time; null once a calibration starts again, or if none was cancelled.
   */
  lastCancel: { reason: string; ts: number } | null;
}

/** Audio recording state of the session (see audio.ts and shouldRecord). */
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
  calibration: CalibrationState;
}

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
    lastCancel: null,
  };
}

/** Does a session with this config record audio? Never a simulated one. */
export function audioEnabled(config: Pick<SessionConfig, "players" | "audio">): boolean {
  return config.audio.enabled && config.players !== "simulated";
}

/** Audio state of a new session (recording is never on for simulated sessions). */
export function emptyAudioState(config?: SessionConfig): AudioState {
  return {
    enabled: config ? audioEnabled(config) : AUDIO_CONFIG_DEFAULTS.enabled,
    requireCalibration: config ? config.audio.requireCalibration : AUDIO_CONFIG_DEFAULTS.requireCalibration,
    recordingPaused: false,
    pausedTs: null,
    pauseReason: null,
    calibration: emptyCalibration(),
  };
}

export function initialState(): GameState {
  return {
    sessionId: null,
    createdTs: null,
    config: SessionConfigSchema.parse({}),
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
    audio: emptyAudioState(),
    lastSeq: 0,
    lastTs: null,
  };
}

/* ─────────────────────────── Derived helpers ─────────────────────────── */

/**
 * The onboarding steps a session with this config uses, in ONBOARDING_STEPS order (logged in
 * OnboardingStarted). The mic check comes right after consent when the session records audio
 * (never for simulated players): recording starts at each participant's own mic check.
 */
export function onboardingStepsFor(
  config: Pick<SessionConfig, "onboarding" | "audio" | "players">,
): OnboardingStep[] {
  const o = config.onboarding;
  const used: Record<OnboardingStep, boolean> = {
    consent: o.consent,
    mic_check: config.audio.enabled && config.players !== "simulated",
    demographics: o.demographics,
    briefing: o.briefing,
  };
  return ONBOARDING_STEPS.filter((step) => used[step]);
}

export function seatList(state: GameState): SeatState[] {
  return Object.values(state.seats).sort((a, b) => a.seat - b.seat);
}

/** Is this a session with simulated players (agents) instead of participants? */
export function isSimulated(state: GameState): boolean {
  return state.config.players === "simulated";
}

/** Seats taking part in the game: bound and not withdrawn. */
export function activeSeats(state: GameState): SeatState[] {
  return seatList(state).filter((s) => s.bound && !s.withdrawn);
}

/** Seats bound to fake players (test clients the server created), in seat order. */
export function fakeSeats(state: GameState): number[] {
  return seatList(state)
    .filter((s) => s.bound && s.fake)
    .map((s) => s.seat);
}

/** A seat held (or to be held) by a person: not a fake player and not an agent. */
export function isParticipant(seat: SeatState): boolean {
  return !seat.fake && !seat.agent;
}

/** Is any bound seat held by a real participant (who has a code, a key-sheet line and a takedown card)? */
export function hasParticipants(state: GameState): boolean {
  return seatList(state).some((s) => s.bound && isParticipant(s));
}

/**
 * Does the mic check apply to this seat? Only when the session records audio and the participant
 * permitted it: nobody who refused (or was never asked) is asked to speak into the microphone.
 */
export function micCheckApplies(state: GameState, seat: SeatState): boolean {
  return state.audio.enabled && isParticipant(seat) && seat.audioConsent;
}

/**
 * Seats that hold the mic checks: active real participants (bound, not withdrawn, not a fake player
 * or agent) whose consent is not `given` yet, i.e. still reading the form or declined. Empty unless
 * the session has the mic check step.
 *
 * Every microphone in the room also hears the others, so NO seat may open its mic (start its mic
 * check, and so its recording) while anyone is still in consent: their voice would be recorded
 * before they agreed, or although they then decline. To go on without a decliner, the facilitator
 * withdraws that seat.
 */
export function micCheckHoldSeats(state: GameState): number[] {
  if (!state.audio.enabled || !state.onboardingSteps.includes("mic_check")) return [];
  return seatList(state)
    .filter((s) => s.bound && !s.withdrawn && isParticipant(s) && s.consent !== "given")
    .map((s) => s.seat);
}

/** Are the mic checks held because a seat is still in consent (see micCheckHoldSeats)? */
export function isMicCheckHeld(state: GameState): boolean {
  return micCheckHoldSeats(state).length > 0;
}

/** Is this onboarding step done for the seat? (The mic check counts as done when passed or skipped.) */
function stepDone(state: GameState, seat: SeatState, step: OnboardingStep): boolean {
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
export function isOnboardingComplete(state: GameState, seat: SeatState): boolean {
  return nextOnboardingStep(state, seat) === null;
}

/**
 * The next onboarding step a seat still has to do (null = done), in the order
 * consent → mic_check → demographics → briefing, skipping steps the session does not use
 * (and the mic check for a participant who did not permit audio recording).
 */
export function nextOnboardingStep(state: GameState, seat: SeatState): OnboardingStep | null {
  if (!isParticipant(seat)) return null;
  for (const step of ONBOARDING_STEPS) {
    if (state.onboardingSteps.includes(step) && !stepDone(state, seat, step)) return step;
  }
  return null;
}

/** Phases in which audio is recorded: from onboarding (the mic check) until the game is complete. */
export const RECORDING_PHASES: ReadonlySet<Phase> = new Set(["onboarding", "round_active", "round_complete"]);

/**
 * Should this seat's microphone be recording now? True only when the session records audio,
 * the seat is held by a real participant (not a fake player or an agent) who gave consent
 * including the audio item, has not withdrawn, has reached the mic check (or is past it) and
 * whose mic check was not skipped, no other seat is still in consent (micCheckHoldSeats),
 * recording is not paused by the facilitator, and the phase is onboarding, round_active or
 * round_complete (breaks and game pauses are recorded too).
 */
export function shouldRecord(state: GameState, seat: SeatState): boolean {
  if (state.audio.recordingPaused || !RECORDING_PHASES.has(state.phase)) return false;
  if (!seat.bound || seat.withdrawn || !micCheckApplies(state, seat)) return false;
  if (seat.consent !== "given" || seat.micCheck === "skipped") return false;
  if (isMicCheckHeld(state)) return false;
  // Recording starts at the mic check, so a session without that step never records. Consent is
  // the only step before it: with consent given, the seat has reached the mic check or is past it.
  return state.onboardingSteps.includes("mic_check");
}

/**
 * Audio gate for round 1: with audio and `requireCalibration` on, the calibration must be done
 * or skipped first. (The onboarding checks are separate: see isOnboardingComplete.)
 */
export function canStartFirstRound(state: GameState): boolean {
  if (!state.audio.enabled || !state.audio.requireCalibration) return true;
  const status = state.audio.calibration.status;
  return status === "done" || status === "skipped";
}

/** Real seats the calibration waits for: active participants not past their mic check yet (consent included). */
export function calibrationWaitingSeats(state: GameState): SeatState[] {
  return activeSeats(state).filter(
    (s) =>
      isParticipant(s) && (s.consent !== "given" || (micCheckApplies(state, s) && s.micCheck === "pending")),
  );
}

/** Seats in their own mic check now (onboarding, consent given, check pending): the facilitator may skip them. */
export function seatsInMicCheck(state: GameState): SeatState[] {
  if (state.phase !== "onboarding") return [];
  return activeSeats(state).filter(
    (s) => micCheckApplies(state, s) && s.consent === "given" && s.micCheck === "pending",
  );
}

/**
 * The latest calibration turn while the calibration runs, or null. Its nominal end is
 * startTs + turnMs; the gap before the next turn has no event of its own.
 */
export function currentCalibrationTurn(state: GameState): CalibrationTurnRecord | null {
  const c = state.audio.calibration;
  if (c.status !== "running" || c.turnIndex === null) return null;
  const turn = c.turns[c.turns.length - 1];
  return turn && turn.endTs === null ? turn : null;
}

/** Non-revoked actions of a seat (optionally of one kind) in a round. */
export function actionsOf(state: GameState, seat: number, round: number, kind?: ActionKind): ActionRecord[] {
  return state.actions.filter(
    (a) => a.seat === seat && a.round === round && !a.revoked && (kind === undefined || a.kind === kind),
  );
}

/** Live (non-revoked) actions currently shown on the map. */
export function visibleActions(state: GameState): ActionRecord[] {
  return state.actions.filter(
    (a) => !a.revoked && (!state.config.clearHighlightsEachRound || a.round === state.round),
  );
}

/** Milliseconds of active (un-paused) time elapsed in the current round at time `now`. */
export function roundActiveMs(state: GameState, now: number): number {
  if (state.roundStartedTs === null) return 0;
  const pausedNow = state.paused && state.pausedSince !== null ? now - state.pausedSince : 0;
  return Math.max(0, now - state.roundStartedTs - state.roundPausedMs - pausedNow);
}

/** Remaining ms of the round's time limit (null = no limit). */
export function roundRemainingMs(state: GameState, now: number): number | null {
  const limit = state.roundSpec?.timeLimitSec;
  if (!limit || state.phase !== "round_active") return null;
  return Math.max(0, limit * 1000 - roundActiveMs(state, now));
}
