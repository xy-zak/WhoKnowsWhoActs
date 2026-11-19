import { parseCellId, type Scores } from "./board";
import type { OnboardingContent, RoundSpec, StudyConfig } from "./config";
import { actorOf, mapScoreOf, rulesFor } from "./game/scoring";
import { type ActionKind, K_LABELS, type KLabel, type PLabel } from "./labels";
import { type NotRecordingReason, recordingVerdict } from "./recordingVerdict";
import { quotaLimit, quotaUsed } from "./rules/roundRules";
import type { MapGeometry, Scenario } from "./scenario";
import {
  type CalibrationStatus,
  type ConsentStatus,
  currentCalibrationTurn,
  type GameState,
  isMicCheckHeld,
  type MicCheckStatus,
  nextOnboardingStep,
  type OnboardingStep,
  type Phase,
  type ReadonlyGameState,
  type ReadonlySeatState,
  seatList,
  visibleActions,
} from "./state";

/* ═══════════════════════════════════════════════════════════════════════════
 * PROJECTIONS — what each recipient is allowed to see.
 *
 * Information asymmetry is enforced HERE, on the server: a player's
 * projection contains only the scores of their own view (one knowledge
 * type). Other knowledge types' scores never leave the server towards that
 * player; only the map score (one average) does.
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface QuotaStatus {
  used: number;
  limit: number | null;
}

/** Actions still allowed by a quota (Infinity when unlimited). */
export function quotaLeft(q: QuotaStatus): number {
  return q.limit === null ? Number.POSITIVE_INFINITY : Math.max(0, q.limit - q.used);
}

export interface Highlight {
  seq: number;
  kind: ActionKind;
  /** Sub-square, e.g. "C7-Kb". */
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
    /** Knowledge type whose scores this seat sees (its view). */
    knows: KLabel | null;
    /** Knowledge type of the sub-square this seat's proposals / decisions land on (from the game rules; null = cannot act). */
    actsOn: Record<ActionKind, KLabel | null>;
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
  /** Game rules of the session (id + version; look the rule set up with getGameRules). */
  rules: { id: string; version: string };
  /** Scores of THIS player's knowledge type only (sub-square id → score). */
  scores: Scores;
  /** Score of the whole map (null before the session has a board). */
  mapScore: number | null;
  highlights: Highlight[];
  broadcasts: Array<{ seq: number; text: string; serverTs: number }>;
  onboarding: OnboardingContent | null;
  /** Onboarding steps used in this session (for the player's wayfinding stepper). */
  onboardingSteps: OnboardingStep[];
  /** Study contact details, shown on the end/withdrawn screen next to the takedown code. */
  study: StudyConfig | null;
  visibility: GameState["config"]["visibility"];
  /** Microphone recording of this seat (sessions that record audio; `enabled` false otherwise). */
  audio: PlayerAudioView;
}

/** What a player's browser needs to drive its recorder, mic check and calibration screen. */
export interface PlayerAudioView {
  /** The session records audio. */
  enabled: boolean;
  /** This browser should be capturing and uploading now (see recordingVerdict). */
  record: boolean;
  /**
   * Why this browser does not record now (null while `record` is true): the server's verdict, the
   * first reason that applies in NOT_RECORDING_REASONS order. `paused` only when the facilitator's
   * pause is the one thing stopping it. The browser maps it to its stop reason (STOP_REASON_FOR)
   * and its recording indicator; it never rebuilds the reason from the other fields.
   */
  notRecording: NotRecordingReason | null;
  /** The facilitator paused recording for everyone. */
  paused: boolean;
  micCheck: MicCheckStatus;
  /**
   * The mic check is this seat's next step but is held: another seat is still reading the consent
   * form (or declined and was not withdrawn yet). Show "waiting for the others to finish consent"
   * and do NOT open the microphone; `mic:check` and `audio:start` are refused meanwhile.
   */
  micCheckHeld: boolean;
  /** Sentence to read aloud in the mic check (only while the mic check is this seat's next step). */
  micCheckPhrase?: string;
  /** Speech the mic check must hear before it passes (ms; with micCheckPhrase). */
  micCheckMinSpeechMs?: number;
  calibration: {
    status: CalibrationStatus;
    /** Seat whose turn it is (null = no turn running). */
    turnSeat: number | null;
    myTurn: boolean;
    /** Text of THIS seat's sentence, only while it is this seat's turn. */
    sentence: string | null;
    /** Nominal end of the running turn (server clock; null = no turn running). */
    turnEndsAt: number | null;
    /** Seats in turn order. */
    order: number[];
  };
}

/**
 * Onboarding content as sent to a player: without the audio texts. A player gets the mic-check
 * phrase and their own calibration sentence through `audio`, only when they need them.
 */
function withoutAudioTexts(onboarding: OnboardingContent | null): OnboardingContent | null {
  if (!onboarding?.audio) return onboarding;
  const { audio: _audio, ...rest } = onboarding;
  return rest;
}

function playerAudioView(
  state: ReadonlyGameState,
  seat: ReadonlySeatState,
  nextStep: OnboardingStep | null,
  onboarding: OnboardingContent | null,
): PlayerAudioView {
  const a = state.audio;
  const content = onboarding?.audio;
  const turn = currentCalibrationTurn(state);
  const myTurn = turn !== null && turn.seat === seat.seat;
  const check = a.enabled && nextStep === "mic_check" ? content?.micCheck : undefined;
  const verdict = recordingVerdict(state, seat);
  return {
    enabled: a.enabled,
    record: verdict.record,
    notRecording: verdict.record ? null : verdict.reason,
    paused: a.recordingPaused,
    micCheck: seat.micCheck,
    micCheckHeld: a.enabled && nextStep === "mic_check" && isMicCheckHeld(state),
    ...(check ? { micCheckPhrase: check.phrase, micCheckMinSpeechMs: check.minSpeechMs } : {}),
    calibration: {
      status: a.calibration.status,
      turnSeat: turn?.seat ?? null,
      myTurn,
      sentence: myTurn
        ? (content?.calibration.sentences.find((s) => s.id === turn.sentenceId)?.text ?? null)
        : null,
      turnEndsAt: turn && a.calibration.turnMs !== null ? turn.startTs + a.calibration.turnMs : null,
      order: [...a.calibration.order],
    },
  };
}

function quotaFor(state: ReadonlyGameState, seat: number): Record<ActionKind, QuotaStatus> {
  return {
    propose: { used: quotaUsed(state, seat, "propose"), limit: quotaLimit(state, "propose") },
    decide: { used: quotaUsed(state, seat, "decide"), limit: quotaLimit(state, "decide") },
  };
}

const END_PHASES: ReadonlySet<Phase> = new Set(["game_complete", "closed", "aborted"]);

export function playerView(
  state: ReadonlyGameState,
  scenario: Scenario,
  seatNo: number,
  onboarding: OnboardingContent | null,
  now: number,
): PlayerView {
  const seat = state.seats[seatNo];
  if (!seat) throw new Error(`No seat ${seatNo}`);
  const vis = state.config.visibility;
  const view = seat.view ? scenario.views[seat.view] : undefined;
  const knows =
    seat.view && (K_LABELS as readonly string[]).includes(seat.view) ? (seat.view as KLabel) : null;
  const rules = rulesFor(state);
  const scores: Scores = {};
  if (knows) {
    for (const [id, v] of Object.entries(state.scores)) if (parseCellId(id)?.k === knows) scores[id] = v;
  }
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
      knows,
      actsOn: {
        propose: rules.targetOf(actorOf(state, seat.seat), "propose"),
        decide: rules.targetOf(actorOf(state, seat.seat), "decide"),
      },
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
    map: { board: state.board ?? scenario.board, views: scenario.views },
    rules: { id: rules.id, version: state.rules?.version ?? rules.version },
    scores,
    mapScore: mapScoreOf(state),
    highlights: visibleActions(state).map((a) => ({
      seq: a.seq,
      kind: a.kind,
      regionId: a.regionId,
      round: a.round,
      seat: vis.showActorToPlayers || a.seat === seatNo ? a.seat : null,
      mine: a.seat === seatNo,
    })),
    broadcasts: state.broadcasts.slice(-5),
    onboarding: nextStep ? withoutAudioTexts(onboarding) : null,
    onboardingSteps: [...state.onboardingSteps],
    study: END_PHASES.has(state.phase) || seat.withdrawn ? (onboarding?.study ?? null) : null,
    visibility: vis,
    audio: playerAudioView(state, seat, nextStep, onboarding),
  };
}
