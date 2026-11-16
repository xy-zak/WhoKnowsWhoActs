import type { OnboardingContent, RoundSpec, StudyConfig } from "./config";
import type { ActionKind, KLabel, PLabel } from "./labels";
import { quotaLimit, quotaUsed } from "./rules/roundRules";
import type { MapGeometry, RegionContent, Scenario } from "./scenario";
import {
  type ConsentStatus,
  type GameState,
  nextOnboardingStep,
  type OnboardingStep,
  type Phase,
  seatList,
  visibleActions,
} from "./state";

/* ═══════════════════════════════════════════════════════════════════════════
 * PROJECTIONS — what each recipient is allowed to see.
 *
 * Information asymmetry is enforced HERE, on the server: a player's
 * projection contains only their own view's region content. Other views'
 * data never leaves the server towards that player.
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface QuotaStatus {
  used: number;
  limit: number | null;
}

export interface Highlight {
  seq: number;
  kind: ActionKind;
  regionId: string;
  round: number;
  /** Seat that acted; null when the session hides actors from players. */
  seat: number | null;
  mine: boolean;
}

export interface PlayerView {
  seq: number;
  serverTs: number;
  sessionId: string;
  phase: Phase;
  paused: boolean;
  pauseReason: GameState["pauseReason"];
  pausedSince: number | null;
  round: number;
  roundCount: number;
  roundSpec: RoundSpec | null;
  roundStartedTs: number | null;
  roundPausedMs: number;
  me: {
    seat: number;
    terminal: number | null;
    k: KLabel | null;
    p: PLabel | null;
    viewName: string | null;
    consent: ConsentStatus;
    nextStep: OnboardingStep | null;
    withdrawn: boolean;
    quota: Record<ActionKind, QuotaStatus>;
    /** Only revealed on the end screen, so the participant can note it for takedown requests. */
    participantCode: string | null;
  };
  others: Array<{
    seat: number;
    connected: boolean;
    withdrawn: boolean;
    ready: boolean;
    k: KLabel | null;
    p: PLabel | null;
    progress: Record<ActionKind, QuotaStatus> | null;
  }>;
  map: MapGeometry;
  /** Region content of THIS player's view only. */
  content: Record<string, RegionContent>;
  highlights: Highlight[];
  broadcasts: Array<{ seq: number; text: string; serverTs: number }>;
  onboarding: OnboardingContent | null;
  /** Study contact details, shown on the end/withdrawn screen next to the takedown code. */
  study: StudyConfig | null;
  visibility: GameState["config"]["visibility"];
}

function quotaFor(state: GameState, seat: number): Record<ActionKind, QuotaStatus> {
  return {
    propose: { used: quotaUsed(state, seat, "propose"), limit: quotaLimit(state, "propose") },
    decide: { used: quotaUsed(state, seat, "decide"), limit: quotaLimit(state, "decide") },
  };
}

const END_PHASES: ReadonlySet<Phase> = new Set(["game_complete", "closed", "aborted"]);

export function playerView(
  state: GameState,
  scenario: Scenario,
  seatNo: number,
  onboarding: OnboardingContent | null,
  now: number,
): PlayerView {
  const seat = state.seats[seatNo];
  if (!seat) throw new Error(`No seat ${seatNo}`);
  const vis = state.config.visibility;
  const view = seat.view ? scenario.views[seat.view] : undefined;
  const inGame = state.round > 0;
  const nextStep = state.phase === "onboarding" ? nextOnboardingStep(state, seat) : null;

  return {
    seq: state.lastSeq,
    serverTs: now,
    sessionId: state.sessionId ?? "",
    phase: state.phase,
    paused: state.paused,
    pauseReason: state.pauseReason,
    pausedSince: state.pausedSince,
    round: state.round,
    roundCount: state.config.roundCount,
    roundSpec: state.roundSpec,
    roundStartedTs: state.roundStartedTs,
    roundPausedMs: state.roundPausedMs,
    me: {
      seat: seat.seat,
      terminal: seat.terminal,
      k: vis.showOwnLabels ? seat.k : null,
      p: vis.showOwnLabels ? seat.p : null,
      viewName: view?.name ?? null,
      consent: seat.consent,
      nextStep,
      withdrawn: seat.withdrawn,
      quota: quotaFor(state, seat.seat),
      participantCode: END_PHASES.has(state.phase) || seat.withdrawn ? seat.participantCode : null,
    },
    others: seatList(state)
      .filter((s) => s.seat !== seatNo && s.bound)
      .map((s) => ({
        seat: s.seat,
        connected: s.connected,
        withdrawn: s.withdrawn,
        ready: state.phase === "onboarding" ? nextOnboardingStep(state, s) === null : true,
        k: vis.showOtherLabelsToPlayers ? s.k : null,
        p: vis.showOtherLabelsToPlayers ? s.p : null,
        progress: vis.showOthersProgress && inGame ? quotaFor(state, s.seat) : null,
      })),
    map: { viewBox: scenario.viewBox, regions: scenario.regions, attributes: scenario.attributes },
    content: view?.regions ?? {},
    highlights: visibleActions(state).map((a) => ({
      seq: a.seq,
      kind: a.kind,
      regionId: a.regionId,
      round: a.round,
      seat: vis.showActorToPlayers || a.seat === seatNo ? a.seat : null,
      mine: a.seat === seatNo,
    })),
    broadcasts: state.broadcasts.slice(-5),
    onboarding: nextStep ? onboarding : null,
    study: END_PHASES.has(state.phase) || seat.withdrawn ? (onboarding?.study ?? null) : null,
    visibility: vis,
  };
}

/** The facilitator sees everything: full state + every view (the composite). */
export interface FacilitatorView {
  state: GameState;
  serverTs: number;
}

export function facilitatorView(state: GameState, now: number): FacilitatorView {
  return { state, serverTs: now };
}
