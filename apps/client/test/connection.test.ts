import type { PlayerView } from "@wkwa/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryStorage } from "../src/net/storage";
import { INTENT_DEADLINE_MS, PlayerConnection } from "../src/player/connection";
import { FakeSocket } from "./fakeSocket";

/* ─── fixtures ─── */

const SEAT_KEY = "wkwa.seat";

function setup(storage = { local: memoryStorage(), session: memoryStorage() }) {
  const socket = new FakeSocket();
  const conn = new PlayerConnection({
    socket: socket.asSocket(),
    ...storage,
    createRecorder: () => {
      throw new Error("these sessions do not record audio");
    },
  });
  live.push(conn);
  return { socket, conn, ...storage };
}

/** Connections made by the current test (their timers are stopped after it). */
let live: PlayerConnection[] = [];

/** Connects, answers hello without a seat, then binds `seat` (a first binding by the facilitator). */
function bind(socket: FakeSocket, seat = 2, sessionId = "s1") {
  socket.connect();
  socket.answer("hello", { ok: true, terminal: 1, seat: null });
  socket.server("bound", { seat, sessionId, seatToken: `token-${seat}` });
}

/** Reconnects and answers hello with the seat (the token re-claims it). */
function reconnect(socket: FakeSocket, seat: number | null = 2) {
  socket.disconnect();
  socket.connect();
  socket.answer("hello", { ok: true, terminal: 1, seat });
}

function view(consent: "pending" | "given" = "given", seq = 5): PlayerView {
  return {
    seq,
    phase: "onboarding",
    me: { seat: 2, consent, nextStep: "demographics", withdrawn: false },
    audio: { enabled: false, record: false },
  } as unknown as PlayerView;
}

const intentPayloads = (socket: FakeSocket) => socket.sent("intent").map((e) => e.payload);

beforeEach(() => {
  vi.useFakeTimers();
  live = [];
});
afterEach(() => {
  for (const c of live) {
    c.telemetry.dispose();
    c.clock.stop();
  }
  vi.useRealTimers();
});

/* ─── the seat lifecycle ─── */

describe("PlayerConnection: seat lifecycle", () => {
  it("says hello on connect, is seated by `bound`, and re-claims the seat with its token after a reconnect", () => {
    const { socket, conn, local } = setup();
    socket.connect();
    const hello = socket.last("hello").payload;
    expect(hello).toEqual({ terminalKey: expect.stringMatching(/^[0-9a-f]{32}$/), seatToken: null });
    expect(conn.store.get()).toMatchObject({ connected: true, seated: false });

    socket.answer("hello", { ok: true, terminal: 3, seat: null });
    expect(conn.store.get()).toMatchObject({ terminal: 3, seated: false, seat: null });

    socket.server("bound", { seat: 2, sessionId: "s1", seatToken: "token-2" });
    expect(conn.store.get()).toMatchObject({ seated: true, seat: 2, sessionId: "s1" });
    expect(JSON.parse(local.getItem(SEAT_KEY)!)).toEqual({ sessionId: "s1", seatToken: "token-2" });

    socket.disconnect();
    expect(conn.store.get()).toMatchObject({ connected: false, seated: false, seat: 2 });

    socket.connect();
    expect(socket.sent("hello").map((e) => e.payload)).toEqual([
      hello,
      { terminalKey: hello.terminalKey, seatToken: "token-2" },
    ]);
    expect(conn.store.get().seated).toBe(false); // not before the server answered
    socket.answer("hello", { ok: true, terminal: 3, seat: 2 });
    expect(conn.store.get()).toMatchObject({ connected: true, seated: true });
  });

  it("keeps the terminal key and seat token across a reload of the page", () => {
    const first = setup();
    bind(first.socket);
    const key = first.socket.last("hello").payload.terminalKey;
    const second = setup({ local: first.local, session: first.session });
    second.socket.connect();
    expect(second.socket.last("hello").payload).toEqual({ terminalKey: key, seatToken: "token-2" });
  });

  it("syncs the clock on every connect, seat or not", () => {
    const { socket } = setup();
    socket.connect();
    expect(socket.sent("clock:ping")).toHaveLength(1);
    expect(socket.last("clock:ping").payload).toEqual({ t0: expect.any(Number) });
  });

  it("detached: drops the seat and view but keeps the token, so `rehello` re-claims the seat", () => {
    const { socket, conn, local } = setup();
    bind(socket);
    socket.server("state", view());
    socket.server("detached", { reason: "The session was switched" });
    expect(conn.store.get()).toMatchObject({
      seated: false,
      seat: null,
      view: null,
      sessionId: "s1",
      notice: "The session was switched",
    });
    expect(conn.telemetry.enabled).toBe(false);
    expect(local.getItem(SEAT_KEY)).not.toBeNull();

    socket.server("rehello");
    expect(socket.last("hello").payload.seatToken).toBe("token-2");
    socket.answer("hello", { ok: true, terminal: 1, seat: 2 });
    socket.server("bound", { seat: 2, sessionId: "s1", seatToken: "token-2" });
    expect(conn.store.get()).toMatchObject({ seated: true, seat: 2, notice: null });
  });

  it("unbound: forgets the seat token and clears the seat, view and telemetry backlog", async () => {
    const { socket, conn, local, session } = setup();
    bind(socket);
    socket.server("state", view());
    conn.track("screen_view", { screen: "consent" });
    socket.server("unbound", { reason: "The facilitator released this seat" });
    expect(conn.store.get()).toMatchObject({
      seated: false,
      seat: null,
      sessionId: null,
      view: null,
      notice: "The facilitator released this seat",
    });
    expect(local.getItem(SEAT_KEY)).toBeNull();
    expect(conn.telemetry.enabled).toBe(false);
    expect(JSON.parse(session.getItem("wkwa.telemetry.pending")!)).toEqual([]);

    reconnect(socket, null);
    expect(socket.last("hello").payload.seatToken).toBeNull();
    await vi.advanceTimersByTimeAsync(2000);
    expect(socket.sent("telemetry")).toHaveLength(0);
  });
});

/* ─── intents: `resend` ─── */

describe("PlayerConnection: intents", () => {
  it("holds an intent made while unseated (never handed to Socket.IO's buffer) and sends it once bound", async () => {
    const { socket, conn } = setup();
    socket.connect();
    const p = conn.intent("propose", "C7-Kb");
    expect(socket.sent("intent")).toHaveLength(0);

    socket.answer("hello", { ok: true, terminal: 1, seat: null });
    expect(socket.sent("intent")).toHaveLength(0);
    socket.server("bound", { seat: 2, sessionId: "s1", seatToken: "token-2" });
    expect(intentPayloads(socket)).toEqual([
      { clientSeq: expect.any(Number), kind: "propose", regionId: "C7-Kb", clientTs: expect.any(Number) },
    ]);
    expect(socket.last("intent").buffered).toBe(false);

    socket.answer("intent", { ok: true, seq: 58 });
    await expect(p).resolves.toEqual({ ok: true, seq: 58 });
  });

  it("sends at once while seated, and only once when hello's answer and `bound` both report the seat", async () => {
    const { socket, conn } = setup();
    void conn.intent("propose", "A1");
    socket.connect();
    socket.answer("hello", { ok: true, terminal: 1, seat: 2 });
    socket.server("bound", { seat: 2, sessionId: "s1", seatToken: "token-2" });
    expect(socket.sent("intent")).toHaveLength(1);

    const p = conn.intent("decide", "A2");
    expect(socket.sent("intent")).toHaveLength(2);
    socket.answer("intent", { ok: false, reason: "quota_exhausted", detail: "No decisions left" });
    await expect(p).resolves.toEqual({ ok: false, reason: "quota_exhausted", detail: "No decisions left" });
  });

  it("resends an unanswered intent unchanged after a reconnect", async () => {
    const { socket, conn } = setup();
    bind(socket);
    const p = conn.intent("propose", "C7-Kb");
    reconnect(socket);
    const [first, again] = intentPayloads(socket);
    expect(again).toEqual(first);
    socket.answer("intent", { ok: true, seq: 58, duplicate: true });
    await expect(p).resolves.toEqual({ ok: true, seq: 58, duplicate: true });
  });

  it("takes the first answer: a late answer to an earlier send is ignored", async () => {
    const { socket, conn } = setup();
    bind(socket);
    const p = conn.intent("propose", "C7-Kb");
    const lost = socket.last("intent");
    // the session is detached and attached again: same connection, so the first send can still be answered
    socket.server("detached", { reason: "switched" });
    socket.server("rehello");
    socket.answer("hello", { ok: true, terminal: 1, seat: 2 });
    expect(socket.sent("intent")).toHaveLength(2);
    socket.answer("intent", { ok: true, seq: 58, duplicate: true });
    lost.ack!({ ok: false, reason: "paused", detail: "late" });
    await expect(p).resolves.toEqual({ ok: true, seq: 58, duplicate: true });
  });

  it("resends every unanswered intent in clientSeq order", () => {
    const { socket, conn } = setup();
    void conn.intent("propose", "A1");
    void conn.intent("propose", "A2");
    void conn.intent("decide", "A3");
    bind(socket);
    const seqs = intentPayloads(socket).map((x) => x.clientSeq);
    expect(seqs).toHaveLength(3);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(intentPayloads(socket).map((x) => x.regionId)).toEqual(["A1", "A2", "A3"]);
  });

  it("keeps an intent refused with retry (not seated yet) and sends it again once seated again", async () => {
    const { socket, conn } = setup();
    bind(socket);
    const p = conn.intent("propose", "A1");
    socket.answer("intent", { ok: false, error: "Not seated", retry: true });
    reconnect(socket);
    expect(socket.sent("intent")).toHaveLength(2);
    socket.answer("intent", { ok: true, seq: 9 });
    await expect(p).resolves.toEqual({ ok: true, seq: 9 });
  });

  it("sends an intent refused with retry while still seated (a server error) again after a pause", async () => {
    const { socket, conn } = setup();
    bind(socket);
    const p = conn.intent("propose", "A1");
    socket.answer("intent", { ok: false, error: "Server error", retry: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(intentPayloads(socket)).toHaveLength(2);
    expect(intentPayloads(socket)[1]).toEqual(intentPayloads(socket)[0]);
    socket.answer("intent", { ok: true, seq: 4 });
    await expect(p).resolves.toEqual({ ok: true, seq: 4 });
  });

  it("rejects on a permanent refusal", async () => {
    const { socket, conn } = setup();
    bind(socket);
    const p = conn.intent("propose", "A1");
    socket.answer("intent", { ok: false, error: "Invalid message: regionId", retry: false });
    await expect(p).rejects.toThrow("Invalid message: regionId");
  });

  it("gives up after its deadline and never sends that intent again", async () => {
    const { socket, conn } = setup();
    socket.connect();
    const caught = conn.intent("propose", "A1").catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(INTENT_DEADLINE_MS);
    expect(await caught).toMatch(/did not confirm/);
    socket.answer("hello", { ok: true, terminal: 1, seat: 2 });
    expect(socket.sent("intent")).toHaveLength(0);
  });

  it("fails every unanswered intent when the seat is released", async () => {
    const { socket, conn } = setup();
    bind(socket);
    const sent = conn.intent("propose", "A1");
    socket.disconnect();
    const waiting = conn.intent("propose", "A2");
    socket.connect();
    socket.server("unbound", { reason: "This seat was opened in another window" });
    await expect(sent).rejects.toThrow("Your seat was released");
    await expect(waiting).rejects.toThrow("Your seat was released");
    socket.answer("hello", { ok: true, terminal: 1, seat: null });
    socket.server("bound", { seat: 3, sessionId: "s1", seatToken: "token-3" });
    expect(socket.sent("intent")).toHaveLength(1);
  });
});

/* ─── requests ─── */

describe("PlayerConnection: requests", () => {
  const consent = {
    formVersion: "v1",
    textSha256: "a".repeat(64),
    answers: { data: true },
    durationMs: 1200,
    clientTs: 1,
  };

  it("waits for the seat, then sends once and resolves with the answer", async () => {
    const { socket, conn } = setup();
    socket.connect();
    const p = conn.request("consent:submit", consent);
    expect(socket.sent("consent:submit")).toHaveLength(0);
    socket.answer("hello", { ok: true, terminal: 1, seat: 2 });
    expect(socket.last("consent:submit").payload).toEqual(consent);
    socket.answer("consent:submit", { ok: true });
    await expect(p).resolves.toEqual({ ok: true });
  });

  it("rejects with the server's error on a permanent refusal", async () => {
    const { socket, conn } = setup();
    bind(socket);
    const p = conn.request("consent:submit", consent);
    socket.answer("consent:submit", { ok: false, error: "The consent text has changed", retry: false });
    await expect(p).rejects.toThrow("The consent text has changed");
  });

  it("says whether the server did not answer or the seat never came", async () => {
    const { socket, conn } = setup();
    socket.connect();
    const unseated = conn.request("briefing:ack", { textSha256: "b".repeat(64), durationMs: 1, clientTs: 1 });
    const c1 = unseated.catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(8000);
    expect(await c1).toMatch(/Not connected/);

    socket.answer("hello", { ok: true, terminal: 1, seat: 2 });
    expect(socket.sent("briefing:ack")).toHaveLength(0); // given up: never sent late
    const c2 = conn.request("consent:submit", consent).catch((e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(8000);
    expect(await c2).toMatch(/did not respond/);
  });

  it("a refusal with retry in a reconnect race is sent again once seated again, not shown as an error", async () => {
    const { socket, conn } = setup();
    bind(socket);
    const p = conn.request("consent:submit", consent);
    // the server lost this socket's seat before the client heard of it
    socket.answer("consent:submit", { ok: false, error: "Not seated", retry: true });
    socket.disconnect();
    socket.connect();
    await vi.advanceTimersByTimeAsync(1000);
    expect(socket.sent("consent:submit")).toHaveLength(1); // not before hello's answer
    socket.answer("hello", { ok: true, terminal: 1, seat: 2 });
    expect(socket.sent("consent:submit").map((e) => e.payload)).toEqual([consent, consent]);
    socket.answer("consent:submit", { ok: true });
    await expect(p).resolves.toEqual({ ok: true });
  });

  it("a refusal with retry while still seated (a server error) is sent again after a pause", async () => {
    const { socket, conn } = setup();
    bind(socket);
    const p = conn.request("mic:check", { passed: true } as never);
    socket.answer("mic:check", { ok: false, error: "Server error", retry: true });
    await vi.advanceTimersByTimeAsync(999);
    expect(socket.sent("mic:check")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.sent("mic:check")).toHaveLength(2);
    socket.answer("mic:check", { ok: true });
    await expect(p).resolves.toEqual({ ok: true });
  });

  it("keeps retrying only until its deadline", async () => {
    const { socket, conn } = setup();
    bind(socket);
    const caught = conn.request("consent:submit", consent, 3000).catch((e: Error) => e.message);
    for (let i = 0; i < 3; i++) {
      socket.answer("consent:submit", { ok: false, error: "Server error", retry: true });
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(await caught).toMatch(/did not respond/);
    expect(socket.sent("consent:submit")).toHaveLength(3);
  });

  it("does not send an unanswered request again after a reconnect (requests are not idempotent)", () => {
    const { socket, conn } = setup();
    bind(socket);
    void conn.request("consent:submit", consent).catch(() => {});
    reconnect(socket);
    expect(socket.sent("consent:submit")).toHaveLength(1);
  });
});

/* ─── telemetry: `whileSeated` ─── */

describe("PlayerConnection: telemetry", () => {
  it("records nothing before consent", async () => {
    const { socket, conn } = setup();
    bind(socket);
    socket.server("state", view("pending"));
    conn.track("screen_view", { screen: "consent" });
    await vi.advanceTimersByTimeAsync(2000);
    expect(socket.sent("telemetry")).toHaveLength(0);
  });

  it("sends a batch every 2 s while seated, with the clock offset", async () => {
    const { socket, conn } = setup();
    bind(socket);
    socket.server("state", view("given", 7));
    conn.track("screen_view", { screen: "game" });
    await vi.advanceTimersByTimeAsync(2000);
    const batch = socket.last("telemetry").payload;
    expect(batch.clockOffsetMs).toEqual(expect.any(Number));
    expect(batch.items.map((i: { type: string; payload: unknown }) => [i.type, i.payload])).toEqual([
      ["state_received", { seq: 7 }],
      ["screen_view", { screen: "game" }],
    ]);
  });

  it("keeps what it records while unseated and sends it once seated again (not before hello's answer)", async () => {
    const { socket, conn } = setup();
    bind(socket);
    socket.server("state", view());
    await vi.advanceTimersByTimeAsync(2000);
    socket.answer("telemetry", { stored: 1 });
    socket.disconnect();
    conn.track("focus_change", { focused: false });
    await vi.advanceTimersByTimeAsync(4000);
    socket.connect();
    await vi.advanceTimersByTimeAsync(4000);
    expect(socket.sent("telemetry")).toHaveLength(1);

    socket.answer("hello", { ok: true, terminal: 1, seat: 2 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(socket.sent("telemetry")).toHaveLength(2);
    expect(socket.last("telemetry").payload.items.map((i: { type: string }) => i.type)).toEqual([
      "focus_change",
    ]);
  });

  it("keeps a refused batch and sends it again", async () => {
    const { socket, conn } = setup();
    bind(socket);
    socket.server("state", view());
    await vi.advanceTimersByTimeAsync(2000);
    socket.answer("telemetry", { ok: false, error: "Not seated", retry: true });
    conn.track("focus_change", { focused: true });
    await vi.advanceTimersByTimeAsync(2000);
    expect(socket.last("telemetry").payload.items.map((i: { type: string }) => i.type)).toEqual([
      "state_received",
      "focus_change",
    ]);
  });

  it("drops the backlog of an earlier session when bound in a new one", async () => {
    const { socket, conn } = setup();
    bind(socket);
    socket.server("state", view());
    socket.server("detached", { reason: "switched" });
    socket.server("bound", { seat: 2, sessionId: "s2", seatToken: "token-2b" });
    socket.server("state", view("given", 1));
    await vi.advanceTimersByTimeAsync(2000);
    expect(socket.last("telemetry").payload.items).toEqual([
      { type: "state_received", clientTs: expect.any(Number), payload: { seq: 1 } },
    ]);
    expect(conn.store.get().sessionId).toBe("s2");
  });
});
