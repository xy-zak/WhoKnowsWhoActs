import { describe, expect, it } from "vitest";
import {
  afterReplay,
  DEFAULT_VALIDATORS,
  isOnboardingComplete,
  playerView,
  reduceEvents,
  roundIsComplete,
  roundRemainingMs,
  roundSpecFor,
  seatList,
  type Validator,
  validateIntent,
} from "../src";
import { act, readySession, startRound, testScenario } from "./helpers";

describe("session setup", () => {
  it("binds seats, assigns labels and completes onboarding", () => {
    const log = readySession();
    const s = log.state;
    expect(s.phase).toBe("onboarding");
    expect(seatList(s)).toHaveLength(4);
    for (const seat of seatList(s)) {
      expect(seat.bound).toBe(true);
      expect(seat.participantCode).toMatch(/^WK-/);
      expect(seat.k).toMatch(/^K[a-d]$/);
      expect(seat.p).toMatch(/^P[a-d]$/);
      expect(isOnboardingComplete(s, seat)).toBe(true);
    }
  });

  it("after a replay on load nobody is connected until their browser says hello (agents always are)", () => {
    const log = readySession();
    expect(seatList(log.state).every((x) => x.connected)).toBe(true);
    const agent = log.state.seats[2]!;
    agent.agent = { policy: "random", policyVersion: "1", params: {}, seed: "s" };
    afterReplay(log.state);
    expect(seatList(log.state).map((x) => x.connected)).toEqual([false, true, false, false]);
  });
});

describe("rounds and quotas (default: 5 propose + 5 decide, 3 rounds)", () => {
  it("rejects actions outside an active round", () => {
    const log = readySession();
    expect(validateIntent(log.state, 1, { kind: "propose", regionId: "A1-Ka" })).toMatchObject({
      ok: false,
      reason: "round_not_active",
    });
  });

  it("enforces quotas and completes the round when all quotas are used", () => {
    const log = readySession();
    startRound(log);
    for (let i = 0; i < 5; i++) {
      for (let seat = 1; seat <= 4; seat++) {
        expect(act(log, seat, "propose", "A1").ok).toBe(true);
        expect(act(log, seat, "decide", "B1").ok).toBe(true);
      }
      if (i < 4) expect(roundIsComplete(log.state)).toBe(false);
    }
    expect(roundIsComplete(log.state)).toBe(true);
    expect(act(log, 1, "propose", "A1")).toMatchObject({ ok: false, reason: "quota_exhausted" });
  });

  it("does not complete while one seat still has quota left", () => {
    const log = readySession();
    startRound(log);
    for (let i = 0; i < 5; i++)
      for (let seat = 1; seat <= 3; seat++) {
        act(log, seat, "propose", "A1");
        act(log, seat, "decide", "A1");
      }
    expect(roundIsComplete(log.state)).toBe(false);
  });

  it("revoking an action restores quota", () => {
    const log = readySession({ defaultRound: { quota: { propose: 1, decide: 1 } } });
    startRound(log);
    const ev = log.push(
      "ProposalMade",
      {
        regionId: "A1-Ka",
        quotaUsed: 1,
        quotaLimit: 1,
        priorProposals: [],
        priorDecisions: [],
        msSinceRoundStart: 1,
      },
      { seat: 1, actor: "player" },
    );
    expect(validateIntent(log.state, 1, { kind: "propose", regionId: "B1-Ka" }).ok).toBe(false);
    log.push(
      "ActionRevoked",
      { targetSeq: ev.seq, targetType: "ProposalMade", targetSeat: 1, regionId: "A1-Ka", reason: "misclick" },
      { actor: "facilitator" },
    );
    expect(validateIntent(log.state, 1, { kind: "propose", regionId: "B1-Ka" }).ok).toBe(true);
  });

  it("rejects while paused and for unknown sub-squares", () => {
    const log = readySession();
    startRound(log);
    log.push("GamePaused", { reason: "facilitator", seat: null }, { actor: "facilitator" });
    expect(validateIntent(log.state, 1, { kind: "propose", regionId: "A1-Ka" })).toMatchObject({
      reason: "paused",
    });
    log.push("GameResumed", { pausedMs: 1000 }, { actor: "facilitator" });
    expect(validateIntent(log.state, 1, { kind: "propose", regionId: "Z9-Ka" })).toMatchObject({
      reason: "unknown_region",
    });
  });

  it("'manual' rule never auto-completes; unlimited quotas allowed", () => {
    const log = readySession({ defaultRound: { rule: "manual", quota: { propose: null, decide: null } } });
    startRound(log);
    for (let i = 0; i < 20; i++) expect(act(log, 1, "propose", "A1").ok).toBe(true);
    expect(roundIsComplete(log.state)).toBe(false);
  });

  it("supports per-round overrides", () => {
    const log = readySession({ roundOverrides: { "3": { quota: { propose: 2, decide: 1 } } } });
    expect(roundSpecFor(log.state.config, 1).quota).toEqual({ propose: 5, decide: 5 });
    expect(roundSpecFor(log.state.config, 3).quota).toEqual({ propose: 2, decide: 1 });
  });

  it("withdrawn seats are excluded from completion and cannot act", () => {
    const log = readySession({ defaultRound: { quota: { propose: 1, decide: 1 } } });
    startRound(log);
    log.push("ParticipantWithdrawn", { seat: 4, by: "facilitator", phase: "round_active" }, { seat: 4 });
    for (let seat = 1; seat <= 3; seat++) {
      act(log, seat, "propose", "A1");
      act(log, seat, "decide", "A1");
    }
    expect(roundIsComplete(log.state)).toBe(true);
    expect(validateIntent(log.state, 4, { kind: "propose", regionId: "A1-Kd" })).toMatchObject({
      reason: "seat_inactive",
    });
  });

  it("custom validators can be added (game-design hook)", () => {
    const log = readySession();
    startRound(log);
    const decideOnlyProposed: Validator = (state, _seat, intent) =>
      intent.kind === "decide" &&
      !state.actions.some((a) => a.kind === "propose" && a.regionId === intent.regionId && !a.revoked)
        ? { ok: false, reason: "rule", detail: "Decide only on proposed sub-squares" }
        : { ok: true };
    const validators = [...DEFAULT_VALIDATORS, decideOnlyProposed];
    expect(validateIntent(log.state, 1, { kind: "decide", regionId: "A2-Ka" }, validators)).toMatchObject({
      reason: "rule",
    });
  });

  it("time limit excludes paused time", () => {
    const log = readySession({ defaultRound: { timeLimitSec: 60 } });
    startRound(log);
    const t0 = log.state.roundStartedTs!;
    expect(roundRemainingMs(log.state, t0 + 10_000)).toBe(50_000);
    log.push("GamePaused", { reason: "facilitator", seat: null }, { dt: 10_000 }); // paused at t0+10s
    expect(roundRemainingMs(log.state, t0 + 40_000)).toBe(50_000);
    log.push("GameResumed", { pausedMs: 30_000 }, { dt: 30_000 }); // resumed at t0+40s
    expect(roundRemainingMs(log.state, t0 + 50_000)).toBe(40_000);
  });
});

describe("replay determinism", () => {
  it("reduceEvents reproduces the live state and supports scrubbing", () => {
    const log = readySession();
    startRound(log);
    act(log, 1, "propose", "A1");
    act(log, 2, "decide", "B1");
    const replayed = reduceEvents(log.events);
    expect(replayed).toEqual(log.state);
    const partial = reduceEvents(log.events, log.events.length - 1);
    expect(partial.actions).toHaveLength(1);
  });
});

describe("player projection (information asymmetry)", () => {
  it("contains only the scores of the player's own knowledge type", () => {
    const log = readySession();
    startRound(log);
    for (let seat = 1; seat <= 4; seat++) {
      const view = playerView(log.state, testScenario, seat, null, Date.now());
      const own = (["Ka", "Kb", "Kc", "Kd"] as const)[seat - 1]!;
      const ids = Object.keys(view.scores);
      expect(ids).toHaveLength(4); // one per square of the 2 × 2 board
      expect(ids.every((id) => id.endsWith(`-${own}`))).toBe(true);
      expect(view.me.knows).toBe(own);
      // the only aggregate a player gets is the map score
      expect(view.mapScore).toBeCloseTo(75 / 16);
      // participant codes are not exposed during the game
      expect(JSON.stringify(view)).not.toMatch(/WK-TEST/);
    }
  });

  it("hides actors and other labels according to visibility config", () => {
    const log = readySession({ visibility: { showActorToPlayers: false, showOtherLabelsToPlayers: false } });
    startRound(log);
    act(log, 2, "propose", "A1");
    const v1 = playerView(log.state, testScenario, 1, null, Date.now());
    expect(v1.highlights[0]).toMatchObject({ regionId: "A1-Kb", seat: null, mine: false });
    expect(v1.others.every((o) => o.k === null && o.p === null)).toBe(true);
    const v2 = playerView(log.state, testScenario, 2, null, Date.now());
    expect(v2.highlights[0]).toMatchObject({ seat: 2, mine: true });
  });

  it("clears highlights between rounds when configured", () => {
    const log = readySession({ defaultRound: { quota: { propose: 1, decide: 0 } } });
    startRound(log);
    for (let seat = 1; seat <= 4; seat++) act(log, seat, "propose", "A1");
    log.push("RoundCompleted", {
      round: 1,
      reason: "quota_met",
      durationMs: 1,
      pausedMs: 0,
      actionCounts: {},
    });
    startRound(log, 2);
    expect(playerView(log.state, testScenario, 1, null, 0).highlights).toHaveLength(0);
  });

  it("reveals the participant code only at the end", () => {
    const log = readySession();
    log.push("GameCompleted", { roundsPlayed: 0, reason: "facilitator" });
    expect(playerView(log.state, testScenario, 1, null, 0).me.participantCode).toBe("WK-TEST-0001-X");
  });
});
