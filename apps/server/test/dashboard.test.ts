/**
 * The facilitator dashboard's live figures per seat (telemetry counts, focus, hover, round trip,
 * mic meter, the last live telemetry items): volatile, never stored, and always of the attached
 * session only. Driven over sockets, the way the facilitator page and the browsers see them.
 */
import { AUDIO_SILENCE_DB, parseSessionConfig, type SeatLiveStats, type StoredTelemetry } from "@wkwa/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Bot, FacilitatorClient } from "../src/tools/botClient";
import { cleanup, setupSession, startTestServer, type TestServer } from "./harness";

const AUDIO = { audio: { enabled: true }, roundCount: 1 };
const AUDIO_BOTS = { audio: true, audioChunkMs: 300, minDelayMs: 5, maxDelayMs: 20 };

const EMPTY = {
  focused: null,
  visible: null,
  idle: false,
  rttMs: null,
  offsetMs: null,
  hoverRegionId: null,
  screen: null,
  telemetryCount: 0,
  lastTelemetryTs: null,
};

describe("dashboard live figures (sockets)", () => {
  let srv: TestServer;
  const bots: Bot[] = [];
  const facs: FacilitatorClient[] = [];

  beforeAll(async () => {
    srv = await startTestServer();
  });

  afterAll(async () => {
    for (const b of bots) b.stop();
    for (const f of facs) f.close();
    await srv?.close();
    cleanup(srv.dir);
  });

  const stats = (seat: number): SeatLiveStats => srv.ctx.hub.dashboard().stats[seat]!;

  /** An audio session whose two seats are recording, with their meters on the dashboard. */
  async function recordingSession() {
    const r = await setupSession(srv.url, AUDIO, 2, AUDIO_BOTS);
    bots.push(...r.bots);
    facs.push(r.fac);
    await vi.waitFor(
      () => {
        for (const seat of [1, 2]) expect(stats(seat).mic?.state).toBe("recording");
      },
      { timeout: 10_000, interval: 50 },
    );
    return r;
  }

  const blank = (seat: number) =>
    expect(stats(seat).mic).toMatchObject({
      state: "idle",
      rmsDb: AUDIO_SILENCE_DB,
      peakDb: AUDIO_SILENCE_DB,
      pendingChunks: 0,
    });

  it("closing the session blanks every mic meter", async () => {
    const { fac } = await recordingSession();
    await fac.cmd("game:end");
    await fac.cmd("session:close");
    blank(1);
    blank(2);
  }, 30_000);

  it("aborting the session blanks every mic meter; the next session starts with nothing of it", async () => {
    const {
      fac,
      bots: [b1],
    } = await recordingSession();
    // a live telemetry item of seat 1 (stored: the seat has consented)
    expect(
      await b1!.emit("telemetry", {
        clockOffsetMs: 0,
        items: [{ type: "focus_change", clientTs: Date.now(), payload: { focused: false } }],
      }),
    ).toEqual({ stored: 1 });
    expect(stats(1)).toMatchObject({ focused: false });
    expect(stats(1).telemetryCount).toBeGreaterThan(0);
    await fac.cmd("session:abort", { reason: "test" });
    blank(1);
    blank(2);

    await fac.cmd("session:create", { scenarioId: "demo", config: { ...AUDIO, seatCount: 2 }, notes: "" });
    for (const seat of [1, 2]) {
      expect(stats(seat)).toMatchObject(EMPTY);
      expect(stats(seat).mic).toMatchObject({
        state: "idle",
        tracks: 0,
        recordedMs: 0,
        lastChunkServerTs: null,
      });
    }
    // a facilitator page opened now gets no live telemetry of the previous session
    const late = new FacilitatorClient(srv.url);
    facs.push(late);
    const live = new Promise<StoredTelemetry[]>((resolve) =>
      late.socket.once("telemetry:live", (m) => resolve(m.items)),
    );
    await late.connected();
    expect(await live).toEqual([]);
    await fac.cmd("session:abort", { reason: "test" });
  }, 30_000);

  it("unbinding a seat clears its live figures", async () => {
    const fac = new FacilitatorClient(srv.url);
    facs.push(fac);
    await fac.connected();
    await fac.cmd("session:create", { scenarioId: "demo", config: { seatCount: 2 }, notes: "" });
    const b = new Bot({ url: srv.url, name: "browser", autoPlay: false, telemetry: false });
    bots.push(b);
    await fac.cmd("seat:bind", { terminal: await b.waitForTerminal(), seat: 1 });
    await b.waitFor((v) => v.phase === "lobby");
    b.socket.emit("presence", { regionId: "A1-Ka" });
    await vi.waitFor(() => expect(stats(1).hoverRegionId).toBe("A1-Ka"), { interval: 20 });
    await fac.cmd("seat:unbind", { seat: 1, reason: "test" });
    expect(stats(1)).toMatchObject(EMPTY);
    await fac.cmd("session:abort", { reason: "test" });
  });
});

describe("dashboard refresh timer", () => {
  let srv: TestServer;
  beforeAll(async () => {
    srv = await startTestServer();
  });
  afterAll(async () => {
    await srv?.close();
    cleanup(srv.dir);
  });

  it("a dashboard refresh still pending when its session leaves is cancelled", async () => {
    const hub = srv.ctx.hub;
    // a simulated session's events schedule a dashboard refresh (agents act many times a second)
    const sim = hub.createSession(
      "demo",
      parseSessionConfig({ players: "simulated", seatCount: 2, roundCount: 1 }),
      "refresh test",
    );
    const emit = vi.spyOn(hub.facilitator, "emit");
    try {
      sim.randomiseLabels();
      sim.startSimulation();
      // a new session that fails after the old one left: nothing attached, and no refresh of it
      const unknownRules = parseSessionConfig({ rules: "no-such-rules" });
      expect(() => hub.createSession("demo", unknownRules, "")).toThrow(/Unknown game rules/);
      expect(hub.session).toBeNull();
      emit.mockClear();
      await new Promise((r) => setTimeout(r, 300));
      expect(emit.mock.calls.filter(([name]) => name === "dashboard")).toEqual([]);
    } finally {
      emit.mockRestore();
    }
  });
});
