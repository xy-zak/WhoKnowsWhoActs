import { AUDIO_CONSENT_ITEM } from "../audio";
import { parseSessionConfig } from "../config";
import type { StoredEvent } from "../events";
import { applyScoreChanges } from "../game/rules";
import {
  type CalibrationState,
  emptyAudioState,
  emptyCalibration,
  emptySeat,
  type GameState,
  initialState,
  type SeatState,
} from "../state";

/**
 * Apply one event to the state (mutates `state` in place and returns it).
 *
 * The reducer is the ONLY place game state changes. It must stay pure with
 * respect to its inputs (no clocks, no randomness) so that replaying the
 * event log always reproduces exactly the same state — on the server, in
 * the facilitator's replay view, and in tests.
 */
export function applyEvent(state: GameState, ev: StoredEvent): GameState {
  state.lastSeq = ev.seq;
  state.lastTs = ev.serverTs;
  const seatOf = (n: number | null | undefined): SeatState | undefined =>
    n === null || n === undefined ? undefined : state.seats[n];

  switch (ev.type) {
    case "SessionCreated": {
      const p = ev.payload;
      state.sessionId = ev.sessionId;
      state.createdTs = ev.serverTs;
      // upgrade older configs (e.g. `condition` → `tags`) so replays of old sessions keep working
      state.config = parseSessionConfig(p.config);
      state.scenario = p.scenario;
      state.regionIds = p.regionIds;
      state.viewIds = p.viewIds;
      state.board = p.board ?? null;
      state.rules = p.rules ?? null;
      state.initialScores = { ...(p.initialScores ?? {}) };
      state.scores = { ...(p.initialScores ?? {}) };
      state.phase = "lobby";
      state.seats = {};
      for (let i = 1; i <= p.config.seatCount; i++) state.seats[i] = emptySeat(i);
      state.audio = emptyAudioState(state.config);
      break;
    }
    case "SessionNote":
      state.notes.push({ seq: ev.seq, text: ev.payload.text, serverTs: ev.serverTs });
      break;
    case "SeatBound": {
      const s = seatOf(ev.payload.seat);
      if (!s) break;
      const fake = ev.payload.fake === true;
      Object.assign(s, emptySeat(s.seat), {
        k: s.k,
        p: s.p,
        view: s.view,
        bound: true,
        participantCode: ev.participantCode,
        terminal: ev.payload.terminal,
        bindingId: ev.payload.bindingId,
        bindingSeq: ev.seq,
        // a fake player is nobody: no consent is asked or recorded
        fake,
        fakePace: fake ? (ev.payload.fakePace ?? "normal") : null,
        consent: fake ? "skipped" : "pending",
      });
      break;
    }
    case "SeatUnbound": {
      const s = seatOf(ev.payload.seat);
      if (!s) break;
      Object.assign(s, emptySeat(s.seat), { k: s.k, p: s.p, view: s.view });
      break;
    }
    case "AgentBound": {
      const s = seatOf(ev.payload.seat);
      if (!s) break;
      // an agent is always "there": bound and connected, with no participant code or client
      Object.assign(s, emptySeat(s.seat), {
        k: s.k,
        p: s.p,
        view: s.view,
        bound: true,
        bindingSeq: ev.seq,
        agent: {
          policy: ev.payload.policy,
          policyVersion: ev.payload.policyVersion,
          params: ev.payload.params,
          seed: ev.payload.seed,
        },
        connected: true,
        everConnected: true,
      });
      break;
    }
    case "LabelsAssigned":
      state.labelPairing = ev.payload.pairing ?? null;
      for (const a of ev.payload.assignments) {
        const s = seatOf(a.seat);
        if (!s) continue;
        s.k = a.k;
        s.p = a.p;
        s.view = a.view;
      }
      break;
    case "OnboardingStarted":
      state.phase = "onboarding";
      state.onboardingSteps = ev.payload.steps;
      for (const s of Object.values(state.seats)) {
        if (!ev.payload.steps.includes("consent")) s.consent = "skipped";
      }
      break;
    case "ConsentRecorded": {
      const s = seatOf(ev.seat);
      if (!s) break;
      s.consent = ev.payload.consented ? "given" : "declined";
      // audio needs its own item ticked as well; a skipped consent never permits recording
      s.audioConsent = ev.payload.consented && ev.payload.answers[AUDIO_CONSENT_ITEM] === true;
      break;
    }
    case "MicCheckCompleted": {
      const s = seatOf(ev.seat);
      // a failed check leaves the step open; a skipped one stays skipped
      if (s && ev.payload.passed && s.micCheck === "pending") s.micCheck = "passed";
      break;
    }
    case "MicCheckSkipped": {
      const s = seatOf(ev.payload.seat);
      if (s) s.micCheck = "skipped";
      break;
    }
    case "AudioTrackStarted":
    case "AudioTrackStopped":
      // audit trail only: tracks live in the audio store, not in the game state
      break;
    case "CalibrationStarted": {
      const p = ev.payload;
      state.audio.calibration = {
        ...emptyCalibration(),
        status: "running",
        order: [...p.order],
        sentenceIds: [...p.sentenceIds],
        turnMs: p.turnMs,
        gapMs: p.gapMs,
        startedTs: ev.serverTs,
      };
      break;
    }
    // Calibration events apply only in the matching status, so a late event of an earlier run
    // (e.g. a check arriving after a redo) never changes the current one.
    case "CalibrationTurn": {
      const c = state.audio.calibration;
      if (c.status !== "running") break;
      endRunningTurn(c, ev.serverTs);
      c.turnIndex = ev.payload.index;
      c.turns.push({
        seat: ev.payload.seat,
        sentenceId: ev.payload.sentenceId,
        startTs: ev.serverTs,
        endTs: null,
      });
      break;
    }
    case "CalibrationCompleted": {
      const c = state.audio.calibration;
      if (c.status !== "running") break;
      c.status = "done";
      c.turnIndex = null;
      c.turns = ev.payload.turns.map((t) => ({ ...t }));
      c.completedTs = ev.serverTs;
      break;
    }
    case "CalibrationChecked":
      if (state.audio.calibration.status !== "done") break;
      state.audio.calibration.quality = {
        perSeat: ev.payload.perSeat.map((r) => ({ ...r })),
        ok: ev.payload.ok,
        checkedTs: ev.serverTs,
      };
      break;
    case "CalibrationSkipped": {
      const c = state.audio.calibration;
      // a finished calibration stays done (its measurements are complete)
      if (c.status === "done") break;
      endRunningTurn(c, ev.serverTs);
      c.status = "skipped";
      c.turnIndex = null;
      c.completedTs = ev.serverTs;
      break;
    }
    case "RecordingPaused":
      state.audio.recordingPaused = true;
      break;
    case "RecordingResumed":
      state.audio.recordingPaused = false;
      break;
    case "DemographicsSubmitted": {
      const s = seatOf(ev.seat);
      if (s) s.demographics = true;
      break;
    }
    case "BriefingAcknowledged": {
      const s = seatOf(ev.seat);
      if (s) s.briefing = true;
      break;
    }
    case "PlayerConnected": {
      const s = seatOf(ev.payload.seat);
      if (!s) break;
      s.connected = true;
      if (ev.payload.reconnect) s.reconnects += 1;
      s.everConnected = true;
      break;
    }
    case "PlayerDisconnected": {
      const s = seatOf(ev.payload.seat);
      if (s) s.connected = false;
      break;
    }
    case "RoundStarted":
      state.phase = "round_active";
      state.round = ev.payload.round;
      state.roundSpec = ev.payload.spec;
      state.roundStartedTs = ev.serverTs;
      state.roundPausedMs = 0;
      state.paused = false;
      state.pauseReason = null;
      state.pausedSince = null;
      state.rounds.push({
        round: ev.payload.round,
        spec: ev.payload.spec,
        startedTs: ev.serverTs,
        endedTs: null,
        reason: null,
      });
      break;
    case "ProposalMade":
    case "DecisionMade": {
      const s = seatOf(ev.seat);
      state.actions.push({
        seq: ev.seq,
        kind: ev.type === "ProposalMade" ? "propose" : "decide",
        seat: ev.seat ?? 0,
        regionId: ev.payload.regionId,
        round: state.round,
        serverTs: ev.serverTs,
        revoked: false,
        k: s?.k ?? null,
        p: s?.p ?? null,
      });
      // the server applied the game rules when it accepted the action; replay what it recorded
      applyScoreChanges(state.scores, ev.payload.scoreChanges);
      if (s) s.lastActionTs = ev.serverTs;
      break;
    }
    case "IntentRejected": {
      const s = seatOf(ev.seat);
      if (s) s.rejections += 1;
      break;
    }
    case "ActionRevoked": {
      const a = state.actions.find((x) => x.seq === ev.payload.targetSeq);
      if (a) a.revoked = true;
      applyScoreChanges(state.scores, ev.payload.scoreChanges);
      break;
    }
    case "RoundCompleted": {
      if (state.paused && state.pausedSince !== null) state.roundPausedMs += ev.serverTs - state.pausedSince;
      state.paused = false;
      state.pauseReason = null;
      state.pausedSince = null;
      state.phase = "round_complete";
      const r = state.rounds.find((x) => x.round === ev.payload.round);
      if (r) {
        r.endedTs = ev.serverTs;
        r.reason = ev.payload.reason;
      }
      break;
    }
    case "GamePaused":
      state.paused = true;
      state.pauseReason = ev.payload.reason;
      state.pausedSince = ev.serverTs;
      break;
    case "GameResumed":
      if (state.pausedSince !== null) state.roundPausedMs += ev.serverTs - state.pausedSince;
      state.paused = false;
      state.pauseReason = null;
      state.pausedSince = null;
      break;
    case "FacilitatorBroadcast":
      state.broadcasts.push({ seq: ev.seq, text: ev.payload.text, serverTs: ev.serverTs });
      break;
    case "ParticipantWithdrawn": {
      const s = seatOf(ev.payload.seat);
      if (!s) break;
      s.withdrawn = true;
      s.connected = false;
      if (ev.payload.by === "erasure") s.participantCode = null;
      break;
    }
    case "GameCompleted":
      state.phase = "game_complete";
      state.endReason = ev.payload.reason;
      state.paused = false;
      break;
    case "SessionClosed":
      state.phase = "closed";
      state.paused = false;
      break;
    case "SessionAborted":
      state.phase = "aborted";
      state.endReason = ev.payload.reason;
      state.paused = false;
      break;
    default: {
      const _exhaustive: never = ev;
      void _exhaustive;
    }
  }
  return state;
}

/** Close the calibration's latest turn if still open: at its nominal end, or at `ts` if that is earlier. */
function endRunningTurn(c: CalibrationState, ts: number) {
  const last = c.turns[c.turns.length - 1];
  if (last && last.endTs === null) last.endTs = Math.min(last.startTs + (c.turnMs ?? 0), ts);
}

/** Fold a list of events into a fresh state (optionally only up to and including `uptoSeq`). */
export function reduceEvents(events: readonly StoredEvent[], uptoSeq = Number.POSITIVE_INFINITY): GameState {
  const state = initialState();
  for (const ev of events) {
    if (ev.seq > uptoSeq) break;
    applyEvent(state, ev);
  }
  return state;
}
