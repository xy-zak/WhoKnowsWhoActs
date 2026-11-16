import { type RoundSpec, type SessionConfig, SessionConfigSchema } from "./config";
import type { ActionKind, KLabel, PLabel } from "./labels";

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
export type OnboardingStep = "consent" | "demographics" | "briefing";

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
}

export interface ActionRecord {
  seq: number;
  kind: ActionKind;
  seat: number;
  regionId: string;
  round: number;
  serverTs: number;
  revoked: boolean;
}

export interface RoundRecord {
  round: number;
  spec: RoundSpec;
  startedTs: number;
  endedTs: number | null;
  reason: "quota_met" | "time_limit" | "facilitator" | null;
}

export interface GameState {
  sessionId: string | null;
  createdTs: number | null;
  config: SessionConfig;
  scenario: { id: string; title: string; version: string; hash: string } | null;
  regionIds: string[];
  viewIds: string[];
  phase: Phase;
  onboardingSteps: OnboardingStep[];
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
    phase: "lobby",
    onboardingSteps: [],
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
    lastSeq: 0,
    lastTs: null,
  };
}

/* ─────────────────────────── Derived helpers ─────────────────────────── */

export function seatList(state: GameState): SeatState[] {
  return Object.values(state.seats).sort((a, b) => a.seat - b.seat);
}

/** Seats taking part in the game: bound and not withdrawn. */
export function activeSeats(state: GameState): SeatState[] {
  return seatList(state).filter((s) => s.bound && !s.withdrawn);
}

export function isOnboardingComplete(state: GameState, seat: SeatState): boolean {
  const steps = state.onboardingSteps;
  if (steps.includes("consent") && seat.consent !== "given") return false;
  if (steps.includes("demographics") && !seat.demographics) return false;
  if (steps.includes("briefing") && !seat.briefing) return false;
  return true;
}

/** The next onboarding step a seat still has to do (null = done). */
export function nextOnboardingStep(state: GameState, seat: SeatState): OnboardingStep | null {
  if (state.onboardingSteps.includes("consent") && seat.consent !== "given") return "consent";
  if (state.onboardingSteps.includes("demographics") && !seat.demographics) return "demographics";
  if (state.onboardingSteps.includes("briefing") && !seat.briefing) return "briefing";
  return null;
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
