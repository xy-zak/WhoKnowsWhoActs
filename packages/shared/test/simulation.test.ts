import { describe, expect, it } from "vitest";
import {
  agentSeed,
  checkSimulationConfig,
  type GameState,
  generateSessionId,
  getPolicy,
  isSimulatedSessionId,
  listPolicies,
  normaliseForPlayers,
  type PlayerView,
  parseSessionConfig,
  playerView,
  randomPolicy,
  resolvePolicyParams,
  seatPolicyId,
  seededRandom,
} from "../src";
import { newSession, testScenario } from "./helpers";

/** A simulated session with agents in every seat, labelled, at round 1. */
const simulatedSession = (seatCount = 2) =>
  newSession({
    sessionId: "SIM-TEST-0001",
    agents: true,
    config: normaliseForPlayers(
      parseSessionConfig({ players: "simulated", seatCount, simulation: { seed: "S" } }),
    ),
  });

const view = (state: GameState, seat: number): PlayerView => playerView(state, testScenario, seat, null, 0);
const ctx = (seed = "x", params: Record<string, unknown> = { proposeBias: 0.5 }) => ({
  seat: 1,
  params: params as { proposeBias: number },
  random: seededRandom(seed),
  memory: {},
  now: 0,
});

describe("session config: players", () => {
  it("defaults to real players and leaves real sessions untouched", () => {
    const c = parseSessionConfig({});
    expect(c.players).toBe("real");
    expect(c.simulation).toMatchObject({ policy: "random", seed: null, minDelayMs: 800, maxDelayMs: 2500 });
    expect(normaliseForPlayers(c)).toBe(c);
  });

  it("switches off onboarding and pause-on-disconnect for simulated players", () => {
    const c = normaliseForPlayers(parseSessionConfig({ players: "simulated" }));
    expect(c.onboarding).toEqual({ consent: false, demographics: false, briefing: false });
    expect(c.pauseOnDisconnect).toBe(false);
  });

  it("gives simulated sessions a SIM- id", () => {
    const id = generateSessionId(new Date("2026-11-17T10:00:00Z"), "simulated");
    expect(id).toMatch(/^SIM-20261117-[0-9A-Z]{4}$/);
    expect(isSimulatedSessionId(id)).toBe(true);
    expect(isSimulatedSessionId(generateSessionId())).toBe(false);
  });
});

describe("agent policy registry", () => {
  it("has the built-in baselines", () => {
    expect(listPolicies().map((p) => p.id)).toEqual(expect.arrayContaining(["random", "idle"]));
    expect(getPolicy("random")).toBe(randomPolicy);
  });

  it("completes parameters with defaults and rejects invalid ones", () => {
    expect(resolvePolicyParams(getPolicy("random")!, undefined)).toEqual({ proposeBias: 0.5 });
    expect(resolvePolicyParams(getPolicy("random")!, { proposeBias: 0.9 })).toEqual({ proposeBias: 0.9 });
    expect(() => resolvePolicyParams(getPolicy("random")!, { proposeBias: 2 })).toThrow(/proposeBias/);
  });

  it("checks a session's simulation settings", () => {
    const sim = (patch: object) => parseSessionConfig({ simulation: patch }).simulation;
    expect(checkSimulationConfig(sim({}), 4)).toBeNull();
    expect(checkSimulationConfig(sim({ policy: "nope" }), 4)).toMatch(/Unknown policy 'nope'/);
    expect(checkSimulationConfig(sim({ seatPolicies: { "5": "idle" } }), 4)).toMatch(/seat 5/);
    expect(checkSimulationConfig(sim({ minDelayMs: 900, maxDelayMs: 100 }), 4)).toMatch(/pause/);
    expect(checkSimulationConfig(sim({ params: { random: { proposeBias: -1 } } }), 4)).toMatch(/proposeBias/);
  });

  it("resolves per-seat policies and seeds", () => {
    const sim = parseSessionConfig({ simulation: { seatPolicies: { "3": "idle" } } }).simulation;
    expect([1, 2, 3, 4].map((s) => seatPolicyId(sim, s))).toEqual(["random", "random", "idle", "random"]);
    expect(agentSeed("ABC", 2)).toBe("ABC:2");
  });
});

describe("AgentBound in the reducer", () => {
  it("binds an agent (policy, version, params, seed) without participant code or client, always connected", () => {
    const st = simulatedSession().state;
    for (const s of Object.values(st.seats)) {
      expect(s).toMatchObject({
        bound: true,
        agent: { policy: "random", policyVersion: "2", params: { proposeBias: 0.5 }, seed: `S:${s.seat}` },
        participantCode: null,
        terminal: null,
        connected: true,
        consent: "skipped",
      });
    }
  });
});

describe("random policy", () => {
  it("passes outside an active round", () => {
    const log = simulatedSession();
    expect(randomPolicy.act(view(log.state, 1), ctx())).toBeNull();
  });

  it("acts on the sub-square of its power type within its quota, and is reproducible from its seed", () => {
    const log = simulatedSession();
    log.push("RoundStarted", {
      round: 1,
      spec: log.state.config.defaultRound,
      startedBy: "facilitator",
    });
    const v = view(log.state, 1);
    const a = randomPolicy.act(v, ctx("seed-1"));
    expect(a).not.toBeNull();
    expect(["propose", "decide"]).toContain(a!.kind);
    expect(testScenario.regions.map((r) => r.id)).toContain(a!.regionId);
    expect(a!.regionId).toMatch(/-Ka$/); // seat 1 holds Pa → acts on Ka sub-squares
    const run = (seed: string) => {
      const c = ctx(seed);
      return Array.from({ length: 20 }, () => randomPolicy.act(v, c));
    };
    expect(run("seed-1")).toEqual(run("seed-1"));
    expect(run("seed-1")).not.toEqual(run("seed-2"));
  });

  it("follows proposeBias and stops when its quota is used", () => {
    const log = simulatedSession();
    log.push("RoundStarted", {
      round: 1,
      spec: { rule: "quota", quota: { propose: 1, decide: 0 }, timeLimitSec: null },
      startedBy: "facilitator",
    });
    // only proposals are possible, whatever the bias
    expect(randomPolicy.act(view(log.state, 1), ctx("x", { proposeBias: 0 }))?.kind).toBe("propose");
    log.push(
      "ProposalMade",
      {
        regionId: "A1-Ka",
        quotaUsed: 1,
        quotaLimit: 1,
        priorProposals: [],
        priorDecisions: [],
        msSinceRoundStart: 10,
      },
      { seat: 1, actor: "player" },
    );
    expect(randomPolicy.act(view(log.state, 1), ctx())).toBeNull();
  });
});
