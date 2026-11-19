import type { AudioStopReason } from "./audioReasons";
import {
  activeSeats,
  calibrationWaitingSeats,
  isMicCheckHeld,
  isOnboardingComplete,
  isParticipant,
  type Phase,
  RECORDING_PHASES,
  type ReadonlyGameState,
  type ReadonlySeatState,
} from "./state";

/* ═══════════════════════════════════════════════════════════════════════════
 * RECORDING VERDICT — does a seat's microphone record now, and if not, why.
 *
 * The one place the recording rule lives (docs/AUDIO.md: consent hold, mic
 * check, skip, pause, withdrawal). The server's projection sends the verdict
 * to the player (PlayerView.audio.record / notRecording); the facilitator
 * reads it from the state. Nobody rebuilds a reason from the raw fields.
 * ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Why a seat does not record, in precedence order: the verdict names the FIRST that applies.
 *
 * Seat reasons come first (the seat itself is not recorded in this session, or not yet):
 *  - `audio_off`: the session records no audio;
 *  - `unbound`: no client holds the seat;
 *  - `not_participant`: a fake player or an agent;
 *  - `withdrawn`: the participant withdrew;
 *  - `consent_declined`: the participant declined the consent form (not withdrawn yet);
 *  - `no_audio_consent`: consent was given without the audio item, or never asked (no consent step);
 *  - `consent_pending`: the participant has not finished the consent form yet;
 *  - `mic_check_skipped`: the facilitator skipped the seat's mic check;
 *  - `no_mic_check_step`: the session's onboarding has no mic check, where recording starts.
 *
 * Moment reasons follow (the seat takes part in the recording, just not now; see isRecordedSeat):
 *  - `not_started`: still in the lobby;
 *  - `game_complete` / `session_closed` / `session_aborted`: past the recording phases;
 *  - `mic_check_held`: a seat has not finished the steps before the mic check yet (micCheckHoldSeats);
 *  - `paused`: the facilitator paused recording. Always last: a verdict says `paused` only when the
 *    pause is the one thing stopping the seat, so it answers "would it record if not paused?".
 */
export const NOT_RECORDING_REASONS = [
  "audio_off",
  "unbound",
  "not_participant",
  "withdrawn",
  "consent_declined",
  "no_audio_consent",
  "consent_pending",
  "mic_check_skipped",
  "no_mic_check_step",
  "not_started",
  "game_complete",
  "session_closed",
  "session_aborted",
  "mic_check_held",
  "paused",
] as const;
export type NotRecordingReason = (typeof NOT_RECORDING_REASONS)[number];

/** Whether a seat records now, and if not, the single reason (see NOT_RECORDING_REASONS). */
export type RecordingVerdict = { record: true } | { record: false; reason: NotRecordingReason };

const RECORD: RecordingVerdict = { record: true };
const no = (reason: NotRecordingReason): RecordingVerdict => ({ record: false, reason });

/** Phases past the recording phases, and the reason each gives. */
const ENDED: Partial<Record<Phase, NotRecordingReason>> = {
  game_complete: "game_complete",
  closed: "session_closed",
  aborted: "session_aborted",
};

/**
 * Should this seat's microphone record now, and if not, why? It records only when the session
 * records audio, the seat is held by a real participant (not a fake player or an agent) who gave
 * consent including the audio item, has not withdrawn and whose mic check was not skipped, the
 * session's onboarding has a mic check, the phase is onboarding, round_active or round_complete
 * (breaks and game pauses are recorded too), no seat is still in consent (micCheckHoldSeats) and
 * recording is not paused by the facilitator.
 */
export function recordingVerdict(state: ReadonlyGameState, seat: ReadonlySeatState): RecordingVerdict {
  if (!state.audio.enabled) return no("audio_off");
  if (!seat.bound) return no("unbound");
  if (!isParticipant(seat)) return no("not_participant");
  if (seat.withdrawn) return no("withdrawn");
  if (seat.consent === "declined") return no("consent_declined");
  if (seat.consent === "skipped" || (seat.consent === "given" && !seat.audioConsent))
    return no("no_audio_consent");
  if (seat.consent !== "given") return no("consent_pending");
  if (seat.micCheck === "skipped") return no("mic_check_skipped");
  // Recording starts at the mic check, so a session without that step never records. The steps
  // before it hold every mic (micCheckHoldSeats) until each seat has done them, so with no hold the
  // seat has reached its mic check or is past it.
  if (!state.onboardingSteps.includes("mic_check")) return no("no_mic_check_step");
  if (!RECORDING_PHASES.has(state.phase)) return no(ENDED[state.phase] ?? "not_started");
  if (isMicCheckHeld(state)) return no("mic_check_held");
  if (state.audio.recordingPaused) return no("paused");
  return RECORD;
}

/** Should this seat's microphone be recording now? (The boolean of recordingVerdict.) */
export function shouldRecord(state: ReadonlyGameState, seat: ReadonlySeatState): boolean {
  return recordingVerdict(state, seat).record;
}

/** Seats the next calibration run reads in: the active seats that are recorded now, in seat order. */
export function calibrationSeats(state: ReadonlyGameState): number[] {
  return activeSeats(state)
    .filter((s) => shouldRecord(state, s))
    .map((s) => s.seat);
}

/** Recorded seats that have not said yet that they are ready for the next calibration run. */
export function calibrationNotReadySeats(state: ReadonlyGameState): number[] {
  const ready = new Set(state.audio.calibration.ready);
  return calibrationSeats(state).filter((seat) => !ready.has(seat));
}

/**
 * Does the calibration wait for the room in this phase? Always in the onboarding (before round 1);
 * in a round break only when a run was asked for again (a redo, or the server's cancel).
 */
export function calibrationWaitsIn(state: ReadonlyGameState): boolean {
  if (state.phase === "onboarding") return true;
  return state.phase === "round_complete" && state.audio.calibration.requested;
}

/**
 * Is the room ready for the calibration's turns? It is waiting (pending; in a round break only
 * after a redo, see calibrationWaitsIn), recording is not paused, every seat is through its onboarding (calibrationWaitingSeats)
 * and every recorded seat has said it is ready. The server then starts it at once.
 */
export function calibrationReadyToStart(state: ReadonlyGameState): boolean {
  const a = state.audio;
  if (!a.enabled || a.calibration.status !== "pending" || a.recordingPaused) return false;
  if (!calibrationWaitsIn(state)) return false;
  if (calibrationWaitingSeats(state).length > 0) return false;
  return calibrationSeats(state).length > 0 && calibrationNotReadySeats(state).length === 0;
}

/**
 * May this seat say it is ready for the calibration now? It is recorded, the calibration is waiting
 * (pending, see calibrationWaitsIn), and it has not said so yet. In the onboarding, the
 * seat is through it (its mic check passed).
 */
export function canSayCalibrationReady(state: ReadonlyGameState, seat: ReadonlySeatState): boolean {
  const a = state.audio;
  if (!a.enabled || a.calibration.status !== "pending" || a.calibration.ready.includes(seat.seat))
    return false;
  if (!calibrationWaitsIn(state)) return false;
  if (state.phase === "onboarding" && !isOnboardingComplete(state, seat)) return false;
  return shouldRecord(state, seat);
}

const MOMENT_REASONS: ReadonlySet<NotRecordingReason> = new Set([
  "not_started",
  "game_complete",
  "session_closed",
  "session_aborted",
  "mic_check_held",
  "paused",
]);

/**
 * Does the seat take part in the recording? True when it records now, or when only the moment
 * stops it (the phase, the consent hold, the facilitator's pause), not the seat itself: a seat
 * for which audio is expected in the stored session.
 */
export function isRecordedSeat(verdict: RecordingVerdict): boolean {
  return verdict.record || MOMENT_REASONS.has(verdict.reason);
}

/**
 * The stop reason a browser logs when its track stops because of this verdict reason. The one
 * mapping from the verdict to AudioStopReason. Reasons without a stop reason of their own
 * (e.g. `mic_check_held`, `consent_pending`) stop as `client_stop`.
 */
export const STOP_REASON_FOR: Readonly<Record<NotRecordingReason, AudioStopReason>> = {
  audio_off: "client_stop",
  unbound: "client_stop",
  not_participant: "client_stop",
  withdrawn: "withdrawn",
  consent_declined: "client_stop",
  no_audio_consent: "client_stop",
  consent_pending: "client_stop",
  mic_check_skipped: "skipped",
  no_mic_check_step: "client_stop",
  not_started: "client_stop",
  game_complete: "game_complete",
  session_closed: "closed",
  session_aborted: "aborted",
  mic_check_held: "client_stop",
  paused: "paused",
};
