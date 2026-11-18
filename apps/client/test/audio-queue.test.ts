import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SendQueue } from "../src/audio/queue";
import type { SendResult } from "../src/audio/types";

interface Item {
  id: string;
  samples: number;
}

const chunk = (id: string, samples = 100): Item => ({ id, samples });
const marker = (id: string): Item => ({ id, samples: 0 });

/** A fake transport: records every attempt and lets the test settle it. */
function transport() {
  const attempts: Array<{ id: string; settle: (r: SendResult) => void }> = [];
  const received: string[] = [];
  let mode: "manual" | "online" | "offline" = "online";
  const deliver = (item: Item): Promise<SendResult> => {
    if (mode === "online") {
      received.push(item.id);
      return Promise.resolve(true);
    }
    if (mode === "offline") return Promise.resolve(false);
    return new Promise((resolve) => {
      attempts.push({
        id: item.id,
        settle: (r) => {
          if (r === true) received.push(item.id);
          resolve(r);
        },
      });
    });
  };
  return {
    attempts,
    received,
    deliver,
    set mode(m: "manual" | "online" | "offline") {
      mode = m;
    },
  };
}

function queue(t: ReturnType<typeof transport>, maxPendingSamples = 1_000_000) {
  return new SendQueue<Item>({
    deliver: t.deliver,
    size: (i) => ({ samples: i.samples, bytes: i.samples * 2 }),
    maxPendingSamples,
    retryDelaysMs: [1000, 5000],
    ackTimeoutMs: 20_000,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("send queue", () => {
  it("delivers in order, one item in flight at a time", async () => {
    const t = transport();
    t.mode = "manual";
    const q = queue(t);
    q.push(marker("start"));
    q.push(chunk("c0"));
    q.push(chunk("c1"));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.attempts.map((a) => a.id)).toEqual(["start"]);
    expect(q.pendingChunks).toBe(2);
    expect(q.pendingBytes).toBe(400);
    t.attempts[0]!.settle(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.attempts.map((a) => a.id)).toEqual(["start", "c0"]);
    t.attempts[1]!.settle(true);
    await vi.advanceTimersByTimeAsync(0);
    t.attempts[2]!.settle(true);
    await q.drained();
    expect(t.received).toEqual(["start", "c0", "c1"]);
    expect(q.length).toBe(0);
    expect(q.pendingChunks).toBe(0);
    expect(q.pendingBytes).toBe(0);
    expect(q.delivered).toBe(3);
  });

  it("retries a failed ack after the back-off and keeps the order", async () => {
    const t = transport();
    t.mode = "manual";
    const q = queue(t);
    q.push(chunk("c0"));
    q.push(chunk("c1"));
    await vi.advanceTimersByTimeAsync(0);
    t.attempts[0]!.settle(false);
    await vi.advanceTimersByTimeAsync(999);
    expect(t.attempts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.attempts.map((a) => a.id)).toEqual(["c0", "c0"]);
    t.attempts[1]!.settle(false);
    await vi.advanceTimersByTimeAsync(4999);
    expect(t.attempts).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    t.attempts[2]!.settle(true);
    await vi.advanceTimersByTimeAsync(0);
    t.attempts[3]!.settle(true);
    await q.drained();
    expect(t.received).toEqual(["c0", "c1"]);
  });

  it("resends everything in order right after a reconnect", async () => {
    const t = transport();
    t.mode = "offline";
    const q = queue(t);
    q.push(marker("start"));
    for (let i = 0; i < 20; i++) q.push(chunk(`c${i}`));
    q.push(marker("stop"));
    await vi.advanceTimersByTimeAsync(3000);
    expect(q.length).toBe(22);
    expect(q.pendingChunks).toBe(20);
    t.mode = "online";
    q.retryNow(); // no waiting for the 5 s back-off
    await vi.advanceTimersByTimeAsync(0);
    expect(t.received).toEqual(["start", ...Array.from({ length: 20 }, (_, i) => `c${i}`), "stop"]);
    expect(q.length).toBe(0);
  });

  it("abandons an attempt lost in a disconnect and ignores its late answer", async () => {
    const t = transport();
    t.mode = "manual";
    const q = queue(t);
    q.push(chunk("c0"));
    q.push(chunk("c1"));
    await vi.advanceTimersByTimeAsync(0);
    const lost = t.attempts[0]!;
    q.retryNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.attempts.map((a) => a.id)).toEqual(["c0", "c0"]);
    lost.settle(false); // stale failure: no back-off
    await vi.advanceTimersByTimeAsync(0);
    expect(t.attempts).toHaveLength(2);
    t.attempts[1]!.settle(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.attempts.map((a) => a.id)).toEqual(["c0", "c0", "c1"]);
    t.attempts[2]!.settle(true);
    await q.drained();
    expect(q.delivered).toBe(2);
  });

  it("counts a late success of an abandoned attempt once", async () => {
    const t = transport();
    t.mode = "manual";
    const q = queue(t);
    q.push(chunk("c0"));
    q.push(chunk("c1"));
    await vi.advanceTimersByTimeAsync(0);
    const lost = t.attempts[0]!;
    q.retryNow();
    await vi.advanceTimersByTimeAsync(0);
    lost.settle(true); // the first attempt did arrive
    await vi.advanceTimersByTimeAsync(0);
    expect(t.attempts.map((a) => a.id)).toEqual(["c0", "c0", "c1"]);
    t.attempts[1]!.settle(true); // duplicate ack of c0: already removed
    t.attempts[2]!.settle(true);
    await q.drained();
    expect(q.delivered).toBe(2);
    expect(q.length).toBe(0);
  });

  it("treats a delivery that never settles as failed", async () => {
    const t = transport();
    t.mode = "manual";
    const q = queue(t);
    q.push(chunk("c0"));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(t.attempts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.attempts).toHaveLength(2);
    t.attempts[1]!.settle(true);
    await q.drained();
  });

  it("caps pending audio: drops the oldest chunks, counts them, keeps markers", async () => {
    const t = transport();
    t.mode = "offline";
    const q = queue(t, 1000);
    q.push(marker("start-a"));
    for (let i = 0; i < 8; i++) q.push(chunk(`a${i}`, 200));
    q.push(marker("stop-a"));
    q.push(marker("start-b"));
    for (let i = 0; i < 3; i++) q.push(chunk(`b${i}`, 200));
    expect(q.pendingSamples).toBe(1000);
    expect(q.pendingChunks).toBe(5);
    expect(q.dropped).toBe(6);
    t.mode = "online";
    q.retryNow();
    await q.drained();
    expect(t.received).toEqual(["start-a", "a6", "a7", "stop-a", "start-b", "b0", "b1", "b2"]);
  });

  it("drops a rejected item without retrying", async () => {
    const t = transport();
    t.mode = "manual";
    const q = queue(t);
    q.push(chunk("c0"));
    q.push(chunk("c1"));
    await vi.advanceTimersByTimeAsync(0);
    t.attempts[0]!.settle("rejected");
    await vi.advanceTimersByTimeAsync(0);
    expect(t.attempts.map((a) => a.id)).toEqual(["c0", "c1"]);
    t.attempts[1]!.settle(true);
    await q.drained();
    expect(q.rejected).toBe(1);
    expect(q.delivered).toBe(1);
  });

  it("treats a throwing or void sender as failed or delivered", async () => {
    let calls = 0;
    const q = new SendQueue<Item>({
      deliver: (i) => {
        calls++;
        if (i.id === "boom" && calls === 1) throw new Error("socket gone");
        return undefined;
      },
      size: (i) => ({ samples: i.samples, bytes: 0 }),
      maxPendingSamples: 1e6,
      retryDelaysMs: [10],
    });
    q.push(marker("boom"));
    q.push(marker("next"));
    await vi.advanceTimersByTimeAsync(10);
    await q.drained();
    expect(calls).toBe(3);
  });

  it("clear() drops everything without counting it as dropped", async () => {
    const t = transport();
    t.mode = "offline";
    const q = queue(t);
    q.push(chunk("c0"));
    q.push(chunk("c1"));
    const drained = q.drained();
    expect(q.clear()).toBe(2);
    await drained;
    expect(q.dropped).toBe(0);
    expect(q.pendingBytes).toBe(0);
  });
});
