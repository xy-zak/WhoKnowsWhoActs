import type { PlayerAcks } from "@wkwa/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type IntentPayload, IntentQueue } from "../src/player/intents";

type IntentReply = PlayerAcks["intent"];

/** A queue whose sends are recorded; `answer(i, ack)` answers the i-th send. */
function setup(deadlineMs = 45_000) {
  const sends: Array<{ payload: IntentPayload; ack: (a: IntentReply) => void }> = [];
  const q = new IntentQueue({ send: (payload, ack) => sends.push({ payload, ack }), deadlineMs });
  const answer = (i: number, a: IntentReply) => sends[i]!.ack(a);
  return { q, sends, answer };
}

const intent = (clientSeq: number): IntentPayload => ({
  clientSeq,
  kind: "propose",
  regionId: "C7-Kb",
  clientTs: 1000 + clientSeq,
});

describe("IntentQueue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends at once while seated and resolves with the server's answer", async () => {
    const { q, sends, answer } = setup();
    q.setSeated(true);
    const p = q.submit(intent(1));
    expect(sends).toHaveLength(1);
    answer(0, { ok: true, seq: 58 });
    await expect(p).resolves.toEqual({ ok: true, seq: 58 });
    expect(q.size).toBe(0);
  });

  it("waits while not seated (never handed to Socket.IO's buffer) and sends once seated", async () => {
    const { q, sends, answer } = setup();
    const p = q.submit(intent(1));
    expect(sends).toHaveLength(0);
    q.setSeated(true);
    expect(sends.map((s) => s.payload)).toEqual([intent(1)]);
    answer(0, { ok: true, seq: 3 });
    await expect(p).resolves.toMatchObject({ ok: true });
  });

  it("resends an unanswered action unchanged after a reconnect, and takes the first answer", async () => {
    const { q, sends, answer } = setup();
    q.setSeated(true);
    const p = q.submit(intent(7));
    // the connection drops before the answer; hello is answered on the new connection
    q.setSeated(false);
    q.setSeated(true);
    expect(sends.map((s) => s.payload)).toEqual([intent(7), intent(7)]);
    // the server stored it once and repeats its answer to the resend
    answer(1, { ok: true, seq: 58, duplicate: true });
    await expect(p).resolves.toEqual({ ok: true, seq: 58, duplicate: true });
    answer(0, { ok: false, reason: "paused", detail: "late" }); // a late answer to the lost send is ignored
    expect(q.size).toBe(0);
  });

  it("resends in clientSeq order", () => {
    const { q, sends } = setup();
    void q.submit(intent(1));
    void q.submit(intent(2));
    void q.submit(intent(3));
    q.setSeated(true);
    expect(sends.map((s) => s.payload.clientSeq)).toEqual([1, 2, 3]);
  });

  it("sends only once when becoming seated is reported twice (hello's answer, then `bound`)", () => {
    const { q, sends } = setup();
    void q.submit(intent(1));
    q.setSeated(true);
    q.setSeated(true);
    expect(sends).toHaveLength(1);
  });

  it("keeps an action refused with retry (not seated yet) and sends it again once seated again", async () => {
    const { q, sends, answer } = setup();
    q.setSeated(true);
    const p = q.submit(intent(1));
    answer(0, { ok: false, error: "Not seated", retry: true });
    expect(q.size).toBe(1);
    q.setSeated(false);
    q.setSeated(true);
    expect(sends.map((x) => x.payload)).toEqual([intent(1), intent(1)]);
    answer(1, { ok: true, seq: 9 });
    await expect(p).resolves.toEqual({ ok: true, seq: 9 });
  });

  it("rejects on a permanent refusal and resolves a rule rejection as the server's answer", async () => {
    const { q, answer } = setup();
    q.setSeated(true);
    const bad = q.submit(intent(1));
    answer(0, { ok: false, error: "Invalid message: regionId", retry: false });
    await expect(bad).rejects.toThrow("Invalid message");
    const rejected = q.submit(intent(2));
    answer(1, { ok: false, reason: "quota_exhausted", detail: "No proposals left" });
    await expect(rejected).resolves.toEqual({
      ok: false,
      reason: "quota_exhausted",
      detail: "No proposals left",
    });
  });

  it("gives up after the deadline and never sends that action again", async () => {
    const { q, sends } = setup(1000);
    const p = q.submit(intent(1));
    const caught = p.catch((e: Error) => e.message);
    vi.advanceTimersByTime(1000);
    expect(await caught).toMatch(/did not confirm/);
    q.setSeated(true);
    expect(sends).toHaveLength(0);
  });

  it("fails every unanswered action when the seat is released", async () => {
    const { q } = setup();
    const p = q.submit(intent(1));
    q.failAll("Your seat was released");
    await expect(p).rejects.toThrow("Your seat was released");
    expect(q.size).toBe(0);
  });
});
