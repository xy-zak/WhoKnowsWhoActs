import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IntentAck } from "../src/session/SessionManager";
import { cleanup, setupSession, startTestServer, type TestServer } from "./harness";

describe("full game with 4 bot players (default rules: 3 rounds × 5 propose + 5 decide)", () => {
  let srv: TestServer;
  let result: Awaited<ReturnType<typeof setupSession>>;

  beforeAll(async () => {
    srv = await startTestServer();
    result = await setupSession(srv.url, {}, 4, { minDelayMs: 5, maxDelayMs: 20 });
    const { fac } = result;
    for (let round = 1; round <= 3; round++) {
      await fac.cmd("round:start");
      await fac.waitForDashboard(
        (d) => d.state?.phase === (round < 3 ? "round_complete" : "game_complete"),
        20_000,
      );
    }
    for (const b of result.bots) await b.flushTelemetry();
  }, 60_000);

  afterAll(async () => {
    for (const b of result?.bots ?? []) b.stop();
    result?.fac.close();
    await srv?.close();
    cleanup(srv.dir);
  });

  it("logs exactly 120 actions and the right round transitions", () => {
    const events = srv.ctx.store.listEvents(result.sessionId);
    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === "ProposalMade")).toHaveLength(60);
    expect(types.filter((t) => t === "DecisionMade")).toHaveLength(60);
    const rounds = events.filter((e) => e.type === "RoundCompleted");
    expect(rounds.map((e) => e.payload)).toMatchObject([
      { round: 1, reason: "quota_met" },
      { round: 2, reason: "quota_met" },
      { round: 3, reason: "quota_met" },
    ]);
    expect(types.at(-1)).toBe("GameCompleted");
    // seq is gap-free and every player event carries the participant code in the column
    events.forEach((e, i) => {
      expect(e.seq).toBe(i + 1);
    });
    for (const e of events.filter((x) => x.actorKind === "player")) expect(e.participantCode).toMatch(/^WK-/);
  });

  it("never puts participant codes inside payloads", () => {
    for (const e of srv.ctx.store.listEvents(result.sessionId)) {
      expect(JSON.stringify(e.payload)).not.toMatch(/WK-[0-9A-Z]{4}-/);
    }
  });

  it("each player only ever received its own knowledge type's scores", () => {
    const state = srv.ctx.hub.session!.state;
    for (const bot of result.bots) {
      const view = state.seats[bot.seat!]!.view!;
      expect(bot.states.length).toBeGreaterThan(10);
      for (const s of bot.states) {
        const ids = Object.keys(s.scores);
        if (s.phase === "round_active") expect(ids).toHaveLength(100); // one per square of the 10 × 10 demo
        for (const id of ids) expect(id.endsWith(`-${view}`)).toBe(true);
      }
      // participant code only revealed once the game is over
      for (const s of bot.states) {
        if (s.phase !== "game_complete") expect(s.me.participantCode).toBeNull();
      }
      expect(bot.states.at(-1)!.me.participantCode).toMatch(/^WK-/);
    }
  });

  it("stores telemetry under the right seat and code", () => {
    const tel = srv.ctx.store.listTelemetry(result.sessionId);
    expect(tel.length).toBeGreaterThan(100);
    const state = srv.ctx.hub.session!.state;
    for (const t of tel) expect(t.participantCode).toBe(state.seats[t.seat]!.participantCode);
    expect(new Set(tel.map((t) => t.type))).toEqual(
      new Set(["state_received", "region_hover", "tool_select", "action_draft"]),
    );
  });

  it("rejects and logs intents after the game ended", async () => {
    const bot = result.bots[0]!;
    const ack = await bot.emit<IntentAck>("intent", {
      clientSeq: 10_000,
      kind: "propose",
      regionId: "A1-Ka",
      clientTs: Date.now(),
    });
    expect(ack).toMatchObject({ ok: false, reason: "round_not_active" });
    const last = srv.ctx.store.listEvents(result.sessionId).at(-1)!;
    expect(last).toMatchObject({ type: "IntentRejected", seat: bot.seat, clientSeq: 10_000 });
  });

  it("writes no client IP addresses, user agents or query strings to the server log", async () => {
    await fetch(`${srv.url}/api/health?secret=querystring-value`, { headers: { "user-agent": "UA-MARKER" } });
    await fetch(`${srv.url}/api/sessions`);
    await new Promise((r) => setTimeout(r, 200)); // pino writes asynchronously
    const lines = readFileSync(path.join(srv.runtime.dataDir, "logs", "server.log"), "utf8")
      .split("\n")
      .filter((l) => l && !l.includes("Server listening at")); // the server's own bind address
    const requestLines = lines.filter((l) => l.includes('"req"'));
    expect(requestLines.length).toBeGreaterThan(0);
    const text = lines.join("\n");
    expect(text).not.toMatch(
      /127\.0\.0\.1|::1|remoteAddress|remotePort|hostname|UA-MARKER|querystring-value/i,
    );
  });
});

describe("robustness", () => {
  let srv: TestServer;
  beforeAll(async () => {
    srv = await startTestServer();
  });
  afterAll(async () => {
    await srv.close();
    cleanup(srv.dir);
  });

  it("deduplicates resent intents, auto-pauses on disconnect and keeps the seat on reconnect", async () => {
    const { fac, bots, sessionId } = await setupSession(srv.url, {}, 4, { autoPlay: false });
    await fac.cmd("round:start");
    const b = bots[1]!;
    await b.waitFor((v) => v.phase === "round_active");
    const target = b.states.at(-1)!.me.actsOn.propose!;
    const msg = { clientSeq: 1, kind: "propose", regionId: `C1-${target}`, clientTs: Date.now() };
    const a1 = await b.emit<IntentAck>("intent", msg);
    const a2 = await b.emit<IntentAck>("intent", msg);
    expect(a1).toMatchObject({ ok: true });
    expect(a2).toMatchObject({ ok: true, duplicate: true });
    expect(srv.ctx.store.listEvents(sessionId).filter((e) => e.type === "ProposalMade")).toHaveLength(1);

    const seat = b.seat;
    b.socket.disconnect();
    await fac.waitForDashboard((d) => d.state!.paused && d.state!.pauseReason === "disconnect");
    b.socket.connect();
    await b.waitFor((v) => v.me.seat === seat && v.paused);
    expect(b.seat).toBe(seat);
    await fac.cmd("game:resume");
    await b.waitFor((v) => !v.paused);
    const types = srv.ctx.store.listEvents(sessionId).map((e) => e.type);
    expect(types).toContain("PlayerDisconnected");
    expect(types.filter((t) => t === "PlayerConnected").length).toBe(5);
    expect(srv.ctx.hub.session!.state.seats[seat!]!.reconnects).toBe(1);

    // facilitator undo restores quota
    const seq = (a1 as { seq: number }).seq;
    await fac.cmd("action:revoke", { seq, reason: "test" });
    const v = await b.waitFor((x) => x.me.quota.propose.used === 0);
    expect(v.highlights.find((h) => h.seq === seq)).toBeUndefined();

    for (const x of bots) x.stop();
    fac.close();
  });

  it("resumes a session from the event log after a restart", async () => {
    const { fac, bots, sessionId } = await setupSession(srv.url, {}, 4, { autoPlay: false });
    await fac.cmd("round:start");
    const before = srv.ctx.hub.session!.state;
    const snapshot = JSON.parse(JSON.stringify(before));
    for (const x of bots) x.stop();
    fac.close();
    srv.ctx.hub.resumeSession(sessionId);
    const after = srv.ctx.hub.session!.state;
    expect(after.phase).toBe("round_active");
    expect(after.lastSeq).toBeGreaterThanOrEqual(snapshot.lastSeq);
    expect(Object.values(after.seats).map((s) => s.participantCode)).toEqual(
      Object.values(snapshot.seats as Record<string, { participantCode: string }>).map(
        (s) => s.participantCode,
      ),
    );
  });
});

describe("label pairings", () => {
  let srv: TestServer;
  beforeAll(async () => {
    srv = await startTestServer();
  });
  afterAll(async () => {
    await srv.close();
    cleanup(srv.dir);
  });

  it("derives P from the pairing; dissociated without a number picks D1–D6 and logs it", async () => {
    const { FacilitatorClient, Bot } = await import("../src/tools/botClient");
    const fac = new FacilitatorClient(srv.url);
    await fac.connected();
    await fac.cmd("session:create", { scenarioId: "demo", config: {}, notes: "" });
    const bots = Array.from({ length: 4 }, () => new Bot({ url: srv.url, autoPlay: false }));
    const terminals = await Promise.all(bots.map((b) => b.waitForTerminal()));
    for (let i = 0; i < 4; i++) await fac.cmd("seat:bind", { terminal: terminals[i], seat: i + 1 });
    const seats = () => Object.values(srv.ctx.hub.session!.state.seats).map((s) => `${s.k}${s.p}`);

    await fac.cmd("labels:set", {
      assignments: [1, 2, 3, 4].map((seat) => ({ seat, k: `K${"abcd"[seat - 1]}` })),
      pairing: { mode: "dissociated", id: 6 },
    });
    expect(seats()).toEqual(["KaPd", "KbPc", "KcPa", "KdPb"]);
    expect(srv.ctx.hub.session!.state.labelPairing).toEqual({ mode: "dissociated", id: 6 });

    await fac.cmd("labels:randomise", { pairing: { mode: "dissociated", id: null }, shuffleK: true });
    const st = srv.ctx.hub.session!.state;
    expect(st.labelPairing?.mode).toBe("dissociated");
    expect(st.labelPairing?.id).toBeGreaterThanOrEqual(1);
    for (const s of Object.values(st.seats)) expect(s.k!.slice(1)).not.toBe(s.p!.slice(1)); // never the same letter

    await fac.cmd("labels:randomise", { pairing: { mode: "aligned", id: null }, shuffleK: true });
    for (const s of Object.values(srv.ctx.hub.session!.state.seats))
      expect(s.k!.slice(1)).toBe(s.p!.slice(1));

    await expect(
      fac.cmd("labels:set", {
        assignments: [1, 2, 3, 4].map((seat) => ({ seat, k: "Ka" })),
        pairing: { mode: "aligned", id: null },
      }),
    ).rejects.toThrow(/only once/);
    const last = srv.ctx.store
      .listEvents(srv.ctx.hub.session!.sessionId)
      .filter((e) => e.type === "LabelsAssigned")
      .at(-1)!;
    expect(last.payload).toMatchObject({ method: "random", pairing: { mode: "aligned", id: null } });
    for (const b of bots) b.stop();
    fac.close();
  });
});
