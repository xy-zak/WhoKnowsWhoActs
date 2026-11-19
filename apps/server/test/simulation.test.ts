import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  type AgentAction,
  definePolicy,
  getPolicy,
  type PlayerView,
  registerPolicy,
  type StoredEvent,
} from "@wkwa/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "../src/app";
import { Bot, FacilitatorClient } from "../src/tools/botClient";
import { cleanup, PASSPHRASE, startTestServer, type TestServer } from "./harness";

const FAST = { minDelayMs: 0, maxDelayMs: 0 };

/** Create a simulated session, label it, start it and wait until the game is complete. */
async function runSimulation(
  fac: FacilitatorClient,
  simulation: Record<string, unknown> = {},
  config: Record<string, unknown> = {},
): Promise<string> {
  const { sessionId } = await fac.cmd("session:create", {
    scenarioId: "demo",
    config: {
      players: "simulated",
      roundAdvance: "auto",
      autoAdvanceDelaySec: 0,
      simulation: { ...FAST, ...simulation },
      ...config,
    },
    notes: "simulation test",
  });
  await fac.waitForDashboard((d) => d.state?.sessionId === sessionId);
  await fac.cmd("labels:set", {
    assignments: [1, 2, 3, 4].map((seat, i) => ({ seat, k: (["Ka", "Kb", "Kc", "Kd"] as const)[i]! })),
    pairing: { mode: "aligned", id: null },
  });
  await fac.cmd("simulation:start");
  await fac.waitForDashboard((d) => d.state?.phase === "game_complete", 20_000);
  return sessionId;
}

const actionsOf = (events: StoredEvent[]) =>
  events
    .filter((e) => e.type === "ProposalMade" || e.type === "DecisionMade")
    .map((e) => `${e.round}:${e.seat}:${e.type === "ProposalMade" ? "P" : "D"}:${e.payload.regionId}`);

describe("simulated players", () => {
  let srv: TestServer;
  let fac: FacilitatorClient;
  let sessionId: string;
  let closed = false;

  beforeAll(async () => {
    srv = await startTestServer();
    fac = new FacilitatorClient(srv.url);
    await fac.connected();
    sessionId = await runSimulation(fac, { seed: "TESTSEED" });
  }, 30_000);

  afterAll(async () => {
    fac?.close();
    if (!closed) await srv?.close();
    cleanup(srv.dir);
  });

  it("plays a whole default game with agents: 3 rounds, 120 actions", () => {
    expect(sessionId).toMatch(/^SIM-\d{8}-[0-9A-Z]{4}$/);
    const events = srv.ctx.stores.simulated.listEvents(sessionId);
    expect(actionsOf(events)).toHaveLength(120);
    expect(events.filter((e) => e.type === "RoundCompleted").map((e) => e.payload)).toMatchObject([
      { round: 1, reason: "quota_met" },
      { round: 2, reason: "quota_met" },
      { round: 3, reason: "quota_met" },
    ]);
    expect(events.at(-1)?.type).toBe("GameCompleted");
  });

  it("stores the session only in the simulation database", () => {
    expect(srv.ctx.stores.simulated.getSession(sessionId)).toBeDefined();
    expect(srv.ctx.store.getSession(sessionId)).toBeUndefined();
    expect(srv.ctx.store.listSessions()).toHaveLength(0);
    expect(existsSync(path.join(srv.runtime.dataDir, "wkwa-sim.db"))).toBe(true);
  });

  it("logs one AgentBound per seat and skips binding, consent and participant codes", () => {
    const events = srv.ctx.stores.simulated.listEvents(sessionId);
    const bound = events.filter((e) => e.type === "AgentBound");
    expect(bound.map((e) => e.payload)).toEqual(
      [1, 2, 3, 4].map((seat) => ({
        seat,
        policy: "random",
        policyVersion: "2",
        params: { proposeBias: 0.5 },
        seed: `TESTSEED:${seat}`,
      })),
    );
    const types = new Set(events.map((e) => e.type));
    for (const t of ["SeatBound", "ConsentRecorded", "DemographicsSubmitted", "BriefingAcknowledged"])
      expect(types.has(t as StoredEvent["type"])).toBe(false);
    expect(events.find((e) => e.type === "OnboardingStarted")?.payload).toEqual({ steps: [] });
    for (const e of events) expect(e.participantCode).toBeNull();
    const created = events[0]!;
    expect(created.type === "SessionCreated" && created.payload.config).toMatchObject({
      players: "simulated",
      onboarding: { consent: false, demographics: false, briefing: false },
      simulation: { policy: "random", seed: "TESTSEED" },
    });
  });

  it("refuses to bind a browser to a simulated seat", async () => {
    const bot = new Bot({ url: srv.url, autoPlay: false });
    const terminal = await bot.waitForTerminal();
    const fresh = await fac.cmd("session:create", {
      scenarioId: "demo",
      config: { players: "simulated", simulation: FAST },
    });
    expect(fresh.sessionId).toMatch(/^SIM-/);
    await expect(fac.cmd("seat:bind", { terminal, seat: 1 })).rejects.toThrow(/simulated session/);
    await fac.cmd("session:abort", { reason: "test" });
    bot.stop();
  });

  it("repeats exactly from the same seed (zero pauses)", async () => {
    const again = await runSimulation(fac, { seed: "TESTSEED" });
    const other = await runSimulation(fac, { seed: "OTHERSEED" });
    const a = actionsOf(srv.ctx.stores.simulated.listEvents(sessionId));
    expect(actionsOf(srv.ctx.stores.simulated.listEvents(again))).toEqual(a);
    expect(actionsOf(srv.ctx.stores.simulated.listEvents(other))).not.toEqual(a);
  }, 30_000);

  it("draws and logs a seed when none is given", async () => {
    const id = await runSimulation(fac);
    const created = srv.ctx.stores.simulated.listEvents(id)[0]!;
    const seed = created.type === "SessionCreated" ? created.payload.config.simulation.seed : null;
    expect(seed).toMatch(/^[0-9A-Z]{8}$/);
  }, 30_000);

  it("uses per-seat policies; idle seats never act and the facilitator ends the round", async () => {
    const { sessionId: id } = await fac.cmd("session:create", {
      scenarioId: "demo",
      config: {
        players: "simulated",
        simulation: { ...FAST, seatPolicies: { "2": "idle" } },
      },
    });
    await fac.cmd("labels:randomise");
    await fac.cmd("simulation:start");
    // the three random agents use their quotas; the idle one keeps the round open
    await fac.waitForDashboard((d) => (d.state?.actions.length ?? 0) === 30, 10_000);
    expect(srv.ctx.hub.session!.state.phase).toBe("round_active");
    await fac.cmd("round:end");
    await fac.cmd("game:end");
    const events = srv.ctx.stores.simulated.listEvents(id);
    expect(events.filter((e) => e.type === "AgentBound").map((e) => e.payload.policy)).toEqual([
      "random",
      "idle",
      "random",
      "random",
    ]);
    expect(actionsOf(events).filter((a) => a.split(":")[1] === "2")).toEqual([]);
  });

  it("rejects unknown policies and invalid parameters when the session is created", async () => {
    await expect(
      fac.cmd("session:create", {
        scenarioId: "demo",
        config: { players: "simulated", simulation: { policy: "does-not-exist" } },
      }),
    ).rejects.toThrow(/Unknown policy 'does-not-exist'/);
    await expect(
      fac.cmd("session:create", {
        scenarioId: "demo",
        config: { players: "simulated", simulation: { params: { random: { proposeBias: 3 } } } },
      }),
    ).rejects.toThrow(/proposeBias/);
  });

  it("stops an agent whose policy keeps failing and notes it in the log", async () => {
    if (!getPolicy("test-broken")) {
      registerPolicy(
        definePolicy({
          id: "test-broken",
          version: "1",
          name: "Broken",
          description: "Throws on every turn (test only).",
          params: z.object({}),
          act: (): AgentAction | null => {
            throw new Error("boom");
          },
        }),
      );
    }
    const { sessionId: id } = await fac.cmd("session:create", {
      scenarioId: "demo",
      config: { players: "simulated", seatCount: 1, simulation: { ...FAST, policy: "test-broken" } },
    });
    await fac.cmd("labels:randomise");
    await fac.cmd("simulation:start");
    await fac.waitForDashboard((d) => (d.state?.notes.length ?? 0) > 0, 10_000);
    const note = srv.ctx.stores.simulated.listEvents(id).find((e) => e.type === "SessionNote")!;
    expect(note.actorKind).toBe("system");
    expect(note.type === "SessionNote" && note.payload.text).toMatch(/seat 1 .*test-broken.*boom/);
    await fac.cmd("game:end");
  });

  it("gives agents the same filtered view as a player (no other view's data)", async () => {
    const seen: PlayerView[] = [];
    if (!getPolicy("test-spy")) {
      registerPolicy(
        definePolicy({
          id: "test-spy",
          version: "1",
          name: "Spy",
          description: "Records what it sees (test only).",
          params: z.object({}),
          act: (view) => {
            seen.push(view);
            return null;
          },
        }),
      );
    }
    await fac.cmd("session:create", {
      scenarioId: "demo",
      config: { players: "simulated", seatCount: 2, simulation: { ...FAST, policy: "test-spy" } },
    });
    await fac.cmd("labels:set", {
      assignments: [
        { seat: 1, k: "Ka" },
        { seat: 2, k: "Kb" },
      ],
      pairing: { mode: "aligned", id: null },
    });
    await fac.cmd("simulation:start");
    await new Promise((r) => setTimeout(r, 300));
    await fac.cmd("game:end");
    const seat1 = seen.filter((v) => v.me.seat === 1);
    expect(seat1.length).toBeGreaterThan(0);
    const ids = Object.keys(seat1[0]!.scores);
    expect(ids).toHaveLength(100); // Ka's own scores, one per square
    expect(ids.every((id) => id.endsWith("-Ka"))).toBe(true); // never Kb's
  });

  it("exports simulated sessions into exports/simulations with the agent policy per seat", async () => {
    const res = await fetch(`${srv.url}/api/sessions/${sessionId}/export`, { method: "POST" });
    const r = (await res.json()) as { dir: string };
    expect(r.dir).toContain(path.join("exports", "simulations", sessionId));
    const players = readFileSync(path.join(r.dir, "players.csv"), "utf8").trim().split("\n");
    const header = players[0]!.split(",");
    const col = header.indexOf("agent_policy");
    expect(col).toBeGreaterThan(-1);
    expect(players.slice(1).map((l) => l.split(",")[col])).toEqual(["random", "random", "random", "random"]);
    expect(players.slice(1).map((l) => l.split(",")[header.indexOf("participant_code")])).toEqual([
      "",
      "",
      "",
      "",
    ]);
  });

  it("lists both databases over REST and refuses key sheets and cards for simulations", async () => {
    const list = (await (await fetch(`${srv.url}/api/sessions`)).json()) as Array<{
      id: string;
      players: string;
    }>;
    expect(list.find((s) => s.id === sessionId)?.players).toBe("simulated");
    expect((await fetch(`${srv.url}/api/sessions/${sessionId}/print/keysheet`)).status).toBe(400);
    expect((await fetch(`${srv.url}/api/sessions/${sessionId}/cards`)).status).toBe(400);
    expect((await fetch(`${srv.url}/api/sessions/${sessionId}/events`)).status).toBe(200);
  });

  it("resumes a simulated session after a restart and the agents carry on", async () => {
    const { sessionId: id } = await fac.cmd("session:create", {
      scenarioId: "demo",
      config: { players: "simulated", simulation: { minDelayMs: 40, maxDelayMs: 60 } },
    });
    await fac.cmd("labels:randomise");
    await fac.cmd("simulation:start");
    await fac.waitForDashboard((d) => (d.state?.actions.length ?? 0) >= 4, 10_000);
    fac.close();
    await srv.close();
    closed = true;
    // restart on the same data directory: the unfinished simulation is resumed automatically
    const ctx = await createApp(srv.runtime, PASSPHRASE);
    try {
      expect(ctx.hub.session?.sessionId).toBe(id);
      expect(ctx.hub.session?.simulated).toBe(true);
      const before = ctx.hub.session!.state.actions.length;
      await new Promise((r) => setTimeout(r, 600));
      expect(ctx.hub.session!.state.actions.length).toBeGreaterThan(before);
      expect(Object.values(ctx.hub.session!.state.seats).every((s) => s.connected && s.agent)).toBe(true);
    } finally {
      await ctx.close();
    }
  });
});
