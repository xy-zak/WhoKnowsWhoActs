import { readFileSync } from "node:fs";
import path from "node:path";
import type { StoredEvent } from "@wkwa/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { Bot, FacilitatorClient } from "../src/tools/botClient";
import { cleanup, PASSPHRASE, startTestServer, type TestServer } from "./harness";

const ROUND = { rule: "quota" as const, quota: { propose: 2, decide: 1 }, timeLimitSec: null };

describe("fake players (real sessions)", () => {
  let srv: TestServer;
  let fac: FacilitatorClient;
  let human: Bot;
  let sessionId: string;
  let closed = false;

  beforeAll(async () => {
    srv = await startTestServer();
    fac = new FacilitatorClient(srv.url);
    await fac.connected();
    ({ sessionId } = await fac.cmd("session:create", {
      scenarioId: "demo",
      config: { roundCount: 1, defaultRound: ROUND },
      notes: "fake player test",
    }));
    // seat 4: an ordinary client (stands in for a person's browser); seats 1–3: fake players
    human = new Bot({ url: srv.url, name: "human", minDelayMs: 5, maxDelayMs: 20 });
    const terminal = await human.waitForTerminal();
    await fac.cmd("seat:bind", { terminal, seat: 4 });
    const r = await fac.cmd("fake:add", { pace: "fast" });
    expect(r.seats).toEqual([1, 2, 3]);
    await fac.cmd("labels:randomise");
    await fac.cmd("onboarding:start");
    // only the real client goes through consent, demographics and briefing
    await fac.waitForDashboard((d) => d.state?.seats[4]?.briefing === true);
    await fac.cmd("round:start");
    await fac.waitForDashboard((d) => d.state?.phase === "game_complete", 20_000);
  }, 40_000);

  afterAll(async () => {
    human?.stop();
    fac?.close();
    if (!closed) await srv?.close();
    cleanup(srv.dir);
  });

  const events = () => srv.ctx.store.listEvents(sessionId);
  const bound = () =>
    events().filter((e): e is Extract<StoredEvent, { type: "SeatBound" }> => e.type === "SeatBound");

  it("stores the session in the participant database", () => {
    expect(srv.ctx.store.getSession(sessionId)).toBeDefined();
    expect(srv.ctx.stores.simulated.getSession(sessionId)).toBeUndefined();
  });

  it("logs which seats are fake, with no participant code for them", () => {
    const b = bound();
    expect(b.map((e) => [e.payload.seat, e.payload.fake])).toEqual([
      [4, false],
      [1, true],
      [2, true],
      [3, true],
    ]);
    for (const e of b) {
      if (e.payload.fake) {
        expect(e.participantCode).toBeNull();
        expect(e.payload.fakePace).toBe("fast");
      } else expect(e.participantCode).toMatch(/^WK-/);
    }
    const st = srv.ctx.hub.session!.state;
    expect([1, 2, 3, 4].map((s) => st.seats[s]!.fake)).toEqual([true, true, true, false]);
  });

  it("skips onboarding for fake players: no consent or demographics are made up", () => {
    const onboardingEvents = events().filter((e) =>
      ["ConsentRecorded", "DemographicsSubmitted", "BriefingAcknowledged"].includes(e.type),
    );
    expect(onboardingEvents.map((e) => e.seat)).toEqual([4, 4, 4]);
    const st = srv.ctx.hub.session!.state;
    for (const s of [1, 2, 3]) expect(st.seats[s]!.consent).toBe("skipped");
    expect(st.seats[4]!.consent).toBe("given");
  });

  it("fake players play over the network like a client and complete the round", () => {
    const actions = events().filter((e) => e.type === "ProposalMade" || e.type === "DecisionMade");
    expect(actions).toHaveLength(12);
    for (const seat of [1, 2, 3]) {
      expect(actions.filter((a) => a.seat === seat)).toHaveLength(3);
      expect(events().some((e) => e.type === "PlayerConnected" && e.seat === seat)).toBe(true);
    }
    // fake players send no telemetry
    expect(srv.ctx.store.listTelemetry(sessionId).every((t) => t.seat === 4)).toBe(true);
  });

  it("marks the session and the seats in listings and exports", async () => {
    expect(srv.ctx.store.listSessions().find((s) => s.id === sessionId)?.fakeSeats).toEqual([1, 2, 3]);
    const res = await fetch(`${srv.url}/api/sessions/${sessionId}/export`, { method: "POST" });
    const r = (await res.json()) as { dir: string };
    const session = JSON.parse(readFileSync(path.join(r.dir, "session.json"), "utf8"));
    expect(session.fakeSeats).toEqual([1, 2, 3]);
    const players = readFileSync(path.join(r.dir, "players.csv"), "utf8").trim().split("\n");
    const head = players[0]!.split(",");
    const rows = players.slice(1).map((l) => l.split(","));
    const col = (name: string) => rows.map((x) => x[head.indexOf(name)]);
    expect(col("seat")).toEqual(["1", "2", "3", "4"]);
    expect(col("fake_player")).toEqual(["1", "1", "1", "0"]);
    expect(col("consent_status")).toEqual(["skipped", "skipped", "skipped", "given"]);
    expect(col("participant_code").map((c) => c?.startsWith("WK-"))).toEqual([false, false, false, true]);
  });

  it("lists fake players on the key sheet without a code, and gives them no takedown card", async () => {
    const sheet = await (await fetch(`${srv.url}/api/sessions/${sessionId}/print/keysheet`)).text();
    expect(sheet.match(/FAKE PLAYER/g)).toHaveLength(3);
    const cards = (await (await fetch(`${srv.url}/api/sessions/${sessionId}/cards`)).json()) as {
      seats: number[];
    };
    expect(cards.seats).toEqual([4]);
  });

  it("refuses fake players outside the lobby, in simulated sessions and on bound seats", async () => {
    await expect(fac.cmd("fake:add", {})).rejects.toThrow(/lobby/);
    await fac.cmd("session:create", { scenarioId: "demo", config: { players: "simulated" } });
    await expect(fac.cmd("fake:add", {})).rejects.toThrow(/simulated session/);
    await fac.cmd("session:create", { scenarioId: "demo", config: { seatCount: 2 } });
    await fac.cmd("fake:add", { seats: [1] });
    await expect(fac.cmd("fake:add", { seats: [1] })).rejects.toThrow(/already bound/);
    await fac.cmd("session:abort", { reason: "test" });
  });

  it("only server-created clients count as fake; a fake seat ends with its unbinding", async () => {
    const { sessionId: id } = await fac.cmd("session:create", {
      scenarioId: "demo",
      config: { seatCount: 2 },
    });
    const browser = new Bot({ url: srv.url, name: "browser", autoPlay: false });
    const terminal = await browser.waitForTerminal();
    await fac.cmd("seat:bind", { terminal, seat: 1 });
    await fac.cmd("fake:add", { seats: [2] });
    const d = await fac.waitForDashboard((x) => x.terminals.filter((t) => t.seat !== null).length === 2);
    expect(d.terminals.find((t) => t.terminal === terminal)?.fake).toBe(false);
    expect(d.terminals.filter((t) => t.fake)).toHaveLength(1);
    await fac.cmd("seat:unbind", { seat: 2, reason: "test" });
    await fac.waitForDashboard((x) => x.terminals.every((t) => !t.fake));
    expect(srv.ctx.store.listSessions().find((s) => s.id === id)?.fakeSeats).toEqual([]);
    browser.stop();
    await fac.cmd("session:abort", { reason: "test" });
  });

  it("restores fake players after a server restart; they re-claim their seats", async () => {
    const { sessionId: id } = await fac.cmd("session:create", {
      scenarioId: "demo",
      config: { seatCount: 2, roundCount: 1, defaultRound: { ...ROUND, quota: { propose: 50, decide: 50 } } },
    });
    await fac.cmd("fake:add", { pace: "fast" });
    await fac.cmd("labels:randomise");
    await fac.cmd("onboarding:start");
    await fac.cmd("round:start");
    await fac.waitForDashboard((x) => (x.state?.actions.length ?? 0) >= 4, 10_000);
    fac.close();
    human.stop();
    await srv.close();
    closed = true;
    const ctx = await createApp(srv.runtime, PASSPHRASE);
    try {
      await ctx.app.listen({ host: "127.0.0.1", port: 0 });
      expect(ctx.hub.session?.sessionId).toBe(id);
      const st = () => ctx.hub.session!.state;
      const before = st().actions.length;
      const deadline = Date.now() + 10_000;
      while ((st().paused || st().actions.length <= before + 2) && Date.now() < deadline) {
        if (st().paused && Object.values(st().seats).every((s) => s.connected)) ctx.hub.session!.resume();
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(Object.values(st().seats).every((s) => s.connected && s.fake)).toBe(true);
      expect(st().actions.length).toBeGreaterThan(before + 2);
    } finally {
      await ctx.close();
    }
  }, 30_000);
});
