import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SeatGate } from "../src/net/delivery";

/*
 * The policies PlayerConnection's tests do not reach through its interface: `attempt` (one audio
 * upload try, cancelled by the SendQueue) and `once`. Intents (`resend`), requests and telemetry
 * (`whileSeated`) are tested through the connection (connection.test.ts).
 */

function setup() {
  const sends: Array<{ event: string; ack: (a: unknown) => void }> = [];
  const gate = new SeatGate((event, _payload, ack) =>
    sends.push({ event, ack: ack as (a: unknown) => void }),
  );
  return { gate, sends };
}

const chunk = { trackId: "t", seq: 0 } as never;

describe("SeatGate", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("attempt: waits for the seat, emits once, and does not resend after a re-seating", async () => {
    const { gate, sends } = setup();
    const p = gate.send("audio:chunk", chunk, "attempt", { timeoutMs: 20_000 });
    expect(sends).toHaveLength(0);
    gate.setSeated(true);
    gate.setSeated(false);
    gate.setSeated(true);
    expect(sends).toHaveLength(1);
    // a retry refusal is the caller's to judge (audioSendResult): it is the answer
    sends[0]!.ack({ ok: false, error: "Not seated", retry: true });
    await expect(p).resolves.toEqual({
      status: "answered",
      ack: { ok: false, error: "Not seated", retry: true },
    });
  });

  it("attempt: cancelled while waiting for the seat is never emitted; once emitted, its answer still counts", async () => {
    const { gate, sends } = setup();
    const waiting = new AbortController();
    const p1 = gate.send("audio:chunk", chunk, "attempt", { timeoutMs: 20_000, signal: waiting.signal });
    waiting.abort();
    await expect(p1).resolves.toEqual({ status: "cancelled" });
    gate.setSeated(true);
    expect(sends).toHaveLength(0);

    const sent = new AbortController();
    const p2 = gate.send("audio:chunk", chunk, "attempt", { timeoutMs: 20_000, signal: sent.signal });
    sent.abort();
    sends[0]!.ack({ ok: true, trackId: "t", seq: 0 });
    await expect(p2).resolves.toMatchObject({ status: "answered" });
  });

  it("attempt: times out within one budget, waiting for the seat included", async () => {
    const { gate, sends } = setup();
    const p = gate.send("audio:chunk", chunk, "attempt", { timeoutMs: 20_000 });
    await vi.advanceTimersByTimeAsync(15_000);
    gate.setSeated(true);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(p).resolves.toEqual({ status: "timeout", sent: true });
    expect(sends).toHaveLength(1);
  });

  it("once: emits without a seat and gives up at the deadline", async () => {
    const { gate, sends } = setup();
    const p = gate.send("clock:ping", { t0: 1 }, "once", { timeoutMs: 3000 });
    expect(sends.map((s) => s.event)).toEqual(["clock:ping"]);
    await vi.advanceTimersByTimeAsync(3000);
    await expect(p).resolves.toEqual({ status: "timeout", sent: true });
  });

  it("release: ends what waits for the seat, keeps an emitted attempt waiting for its answer", async () => {
    const { gate, sends } = setup();
    gate.setSeated(true);
    const emitted = gate.send("audio:chunk", chunk, "attempt", { timeoutMs: 20_000 });
    gate.setSeated(false);
    const waiting = gate.send("audio:stop", chunk, "attempt", { timeoutMs: 20_000 });
    gate.release();
    await expect(waiting).resolves.toEqual({ status: "released" });
    sends[0]!.ack({ ok: true });
    await expect(emitted).resolves.toMatchObject({ status: "answered" });
    expect(gate.size).toBe(0);
  });
});
