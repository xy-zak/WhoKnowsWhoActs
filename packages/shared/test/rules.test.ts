import { describe, expect, it } from "vitest";
import {
  DEFAULT_VALIDATORS,
  type GameState,
  isOnboardingComplete,
  pathAnchor,
  playerView,
  quotaUsed,
  reduceEvents,
  roundRemainingMs,
  roundSpecFor,
  ruleFor,
  seatList,
  type Validator,
  validateIntent,
} from "../src";
import { type EventLog, readySession, testScenario } from "./helpers";

function startRound(log: EventLog, round: number) {
  log.push(
    "RoundStarted",
    { round, spec: roundSpecFor(log.state.config, round), startedBy: "facilitator" },
    { actor: "facilitator" },
  );
}

function act(log: EventLog, seat: number, kind: "propose" | "decide", regionId: string) {
  const st = log.state;
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
    },
    { seat, code: `WK-TEST-000${seat}-X`, actor: "player" },
  );
  return v;
}

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
});

describe("rounds and quotas (default: 5 propose + 5 decide, 3 rounds)", () => {
  it("rejects actions outside an active round", () => {
    const log = readySession();
    expect(validateIntent(log.state, 1, { kind: "propose", regionId: "A" })).toMatchObject({
      ok: false,
      reason: "round_not_active",
    });
  });

  it("enforces quotas and completes the round when all quotas are used", () => {
    const log = readySession();
    startRound(log, 1);
    const rule = ruleFor(log.state);
    for (let i = 0; i < 5; i++) {
      for (let seat = 1; seat <= 4; seat++) {
        expect(act(log, seat, "propose", "A").ok).toBe(true);
        expect(act(log, seat, "decide", "B").ok).toBe(true);
      }
      if (i < 4) expect(rule.isComplete(log.state)).toBe(false);
    }
    expect(rule.isComplete(log.state)).toBe(true);
    expect(act(log, 1, "propose", "A")).toMatchObject({ ok: false, reason: "quota_exhausted" });
  });

  it("does not complete while one seat still has quota left", () => {
    const log = readySession();
    startRound(log, 1);
    for (let i = 0; i < 5; i++)
      for (let seat = 1; seat <= 3; seat++) {
        act(log, seat, "propose", "A");
        act(log, seat, "decide", "A");
      }
    expect(ruleFor(log.state).isComplete(log.state)).toBe(false);
  });

  it("revoking an action restores quota", () => {
    const log = readySession({ defaultRound: { quota: { propose: 1, decide: 1 } } });
    startRound(log, 1);
    const ev = log.push(
      "ProposalMade",
      {
        regionId: "A",
        quotaUsed: 1,
        quotaLimit: 1,
        priorProposals: [],
        priorDecisions: [],
        msSinceRoundStart: 1,
      },
      { seat: 1, actor: "player" },
    );
    expect(validateIntent(log.state, 1, { kind: "propose", regionId: "B" }).ok).toBe(false);
    log.push(
      "ActionRevoked",
      { targetSeq: ev.seq, targetType: "ProposalMade", targetSeat: 1, regionId: "A", reason: "misclick" },
      { actor: "facilitator" },
    );
    expect(validateIntent(log.state, 1, { kind: "propose", regionId: "B" }).ok).toBe(true);
  });

  it("rejects while paused and for unknown regions", () => {
    const log = readySession();
    startRound(log, 1);
    log.push("GamePaused", { reason: "facilitator", seat: null }, { actor: "facilitator" });
    expect(validateIntent(log.state, 1, { kind: "propose", regionId: "A" })).toMatchObject({
      reason: "paused",
    });
    log.push("GameResumed", { pausedMs: 1000 }, { actor: "facilitator" });
    expect(validateIntent(log.state, 1, { kind: "propose", regionId: "ZZ" })).toMatchObject({
      reason: "unknown_region",
    });
  });

  it("'manual' rule never auto-completes; unlimited quotas allowed", () => {
    const log = readySession({ defaultRound: { rule: "manual", quota: { propose: null, decide: null } } });
    startRound(log, 1);
    for (let i = 0; i < 20; i++) expect(act(log, 1, "propose", "A").ok).toBe(true);
    expect(ruleFor(log.state).isComplete(log.state)).toBe(false);
  });

  it("supports per-round overrides", () => {
    const log = readySession({ roundOverrides: { "3": { quota: { propose: 2, decide: 1 } } } });
    expect(roundSpecFor(log.state.config, 1).quota).toEqual({ propose: 5, decide: 5 });
    expect(roundSpecFor(log.state.config, 3).quota).toEqual({ propose: 2, decide: 1 });
  });

  it("withdrawn seats are excluded from completion and cannot act", () => {
    const log = readySession({ defaultRound: { quota: { propose: 1, decide: 1 } } });
    startRound(log, 1);
    log.push("ParticipantWithdrawn", { seat: 4, by: "facilitator", phase: "round_active" }, { seat: 4 });
    for (let seat = 1; seat <= 3; seat++) {
      act(log, seat, "propose", "A");
      act(log, seat, "decide", "A");
    }
    expect(ruleFor(log.state).isComplete(log.state)).toBe(true);
    expect(validateIntent(log.state, 4, { kind: "propose", regionId: "A" })).toMatchObject({
      reason: "seat_inactive",
    });
  });

  it("custom validators can be added (game-design hook)", () => {
    const log = readySession();
    startRound(log, 1);
    const decideOnlyProposed: Validator = (state: GameState, _seat, intent) =>
      intent.kind === "decide" &&
      !state.actions.some((a) => a.kind === "propose" && a.regionId === intent.regionId && !a.revoked)
        ? { ok: false, reason: "rule", detail: "Decide only on proposed regions" }
        : { ok: true };
    const validators = [...DEFAULT_VALIDATORS, decideOnlyProposed];
    expect(validateIntent(log.state, 1, { kind: "decide", regionId: "C" }, validators)).toMatchObject({
      reason: "rule",
    });
  });

  it("time limit excludes paused time", () => {
    const log = readySession({ defaultRound: { timeLimitSec: 60 } });
    startRound(log, 1);
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
    startRound(log, 1);
    act(log, 1, "propose", "A");
    act(log, 2, "decide", "B");
    const replayed = reduceEvents(log.events);
    expect(replayed).toEqual(log.state);
    const partial = reduceEvents(log.events, log.events.length - 1);
    expect(partial.actions).toHaveLength(1);
  });
});

describe("player projection (information asymmetry)", () => {
  it("contains only the player's own view content", () => {
    const log = readySession();
    startRound(log, 1);
    for (let seat = 1; seat <= 4; seat++) {
      const view = playerView(log.state, testScenario, seat, null, Date.now());
      const json = JSON.stringify(view);
      const own = ["ka", "kb", "kc", "kd"][seat - 1]!;
      expect(json).toContain(`${own}-secret-A`);
      for (const other of ["ka", "kb", "kc", "kd"].filter((x) => x !== own)) {
        expect(json).not.toContain(`${other}-secret-A`);
      }
      // participant codes are not exposed during the game
      expect(json).not.toMatch(/WK-TEST/);
    }
  });

  it("hides actors and other labels according to visibility config", () => {
    const log = readySession({ visibility: { showActorToPlayers: false, showOtherLabelsToPlayers: false } });
    startRound(log, 1);
    act(log, 2, "propose", "A");
    const v1 = playerView(log.state, testScenario, 1, null, Date.now());
    expect(v1.highlights[0]).toMatchObject({ regionId: "A", seat: null, mine: false });
    expect(v1.others.every((o) => o.k === null && o.p === null)).toBe(true);
    const v2 = playerView(log.state, testScenario, 2, null, Date.now());
    expect(v2.highlights[0]).toMatchObject({ seat: 2, mine: true });
  });

  it("clears highlights between rounds when configured", () => {
    const log = readySession({ defaultRound: { quota: { propose: 1, decide: 0 } } });
    startRound(log, 1);
    for (let seat = 1; seat <= 4; seat++) act(log, seat, "propose", "A");
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

describe("geometry", () => {
  it("computes polygon centroids", () => {
    expect(pathAnchor("M0 0 L10 0 L10 10 L0 10 Z")).toEqual([5, 5]);
    expect(pathAnchor("M0 0 h10 v10 h-10 z")).toEqual([5, 5]);
  });
});
