import type { SendResult } from "./types";

/**
 * Ordered, acknowledged delivery of the recorder's messages (track start,
 * chunks, track stop), kept IN MEMORY ONLY: no voice data is ever written to
 * IndexedDB, localStorage or sessionStorage on the participant's device.
 *
 *  - One item is in flight at a time, oldest first, so the server receives a
 *    track's start, its chunks in seq order, then its stop.
 *  - A failed or timed-out delivery is retried after a back-off
 *    (retryDelaysMs); retryNow() (after a reconnect) resends the oldest
 *    pending item at once. The server store is idempotent per (track, seq),
 *    so a duplicate delivery is harmless.
 *  - "rejected" (a permanent refusal) removes the item without retrying.
 *  - Cap: when the pending audio exceeds maxPendingSamples, the oldest chunks
 *    are dropped and counted. Start/stop markers are never dropped.
 */
export interface QueueEntrySize {
  /** audio samples in the item (0 for markers; only items with samples can be dropped by the cap) */
  samples: number;
  bytes: number;
}

export interface SendQueueOptions<T> {
  /**
   * Delivers one attempt. `signal` aborts once the queue gave up on this attempt (a reconnect's
   * retryNow, its ack timeout, the cap dropped it, clear): a delivery still WAITING to be sent
   * (e.g. for the seat) must then not send, or the item goes out twice.
   */
  deliver(item: T, signal: AbortSignal): Promise<SendResult> | SendResult | undefined;
  size(item: T): QueueEntrySize;
  maxPendingSamples: number;
  /** back-off after consecutive failures; the last value repeats. Default 1 s, 2 s, 5 s, 10 s, 30 s */
  retryDelaysMs?: readonly number[];
  /** a delivery that has not settled after this long counts as failed; default 30 s */
  ackTimeoutMs?: number;
  /** called after every change of the pending set */
  onChange?(): void;
}

interface Entry<T> {
  item: T;
  samples: number;
  bytes: number;
}

const DEFAULT_RETRY = [1000, 2000, 5000, 10_000, 30_000] as const;

export class SendQueue<T> {
  private entries: Entry<T>[] = [];
  private inFlight: { entry: Entry<T>; attempt: number; abort: AbortController } | null = null;
  private attempts = 0;
  private failures = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private waiters: Array<() => void> = [];
  private disposed = false;
  private chunkCount = 0;
  private sampleCount = 0;
  private byteCount = 0;
  /** chunks dropped by the cap */
  dropped = 0;
  /** items the server refused permanently */
  rejected = 0;
  /** items delivered */
  delivered = 0;

  constructor(private readonly o: SendQueueOptions<T>) {}

  /** Pending items, including markers and the one in flight. */
  get length(): number {
    return this.entries.length;
  }
  get pendingChunks(): number {
    return this.chunkCount;
  }
  get pendingSamples(): number {
    return this.sampleCount;
  }
  get pendingBytes(): number {
    return this.byteCount;
  }

  push(item: T) {
    if (this.disposed) return;
    const { samples, bytes } = this.o.size(item);
    this.entries.push({ item, samples, bytes });
    if (samples > 0) this.chunkCount++;
    this.sampleCount += samples;
    this.byteCount += bytes;
    this.enforceCap();
    this.changed();
    this.pump();
  }

  /** Resend now (after a reconnect): abandons the attempt in flight and resets the back-off. */
  retryNow() {
    if (this.disposed) return;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.failures = 0;
    this.abandon();
    this.pump();
  }

  /** Resolves when nothing is pending. */
  drained(): Promise<void> {
    if (this.entries.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Drops everything pending (not counted as dropped); returns the number of chunks discarded. */
  clear(): number {
    const chunks = this.chunkCount;
    this.entries = [];
    this.abandon();
    this.chunkCount = 0;
    this.sampleCount = 0;
    this.byteCount = 0;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.failures = 0;
    this.changed();
    this.settleWaiters();
    return chunks;
  }

  dispose() {
    this.clear();
    this.disposed = true;
  }

  private enforceCap() {
    while (this.sampleCount > this.o.maxPendingSamples) {
      const i = this.entries.findIndex((e) => e.samples > 0);
      if (i < 0) return;
      const [e] = this.entries.splice(i, 1);
      this.account(e!);
      this.dropped++;
      if (this.inFlight?.entry === e) this.abandon();
    }
  }

  /** Gives up on the attempt in flight (its late answer is still accepted as a success). */
  private abandon() {
    this.inFlight?.abort.abort();
    this.inFlight = null;
  }

  private account(e: Entry<T>) {
    if (e.samples > 0) this.chunkCount--;
    this.sampleCount -= e.samples;
    this.byteCount -= e.bytes;
  }

  private changed() {
    try {
      this.o.onChange?.();
    } catch (err) {
      console.error(err);
    }
  }

  private settleWaiters() {
    if (this.entries.length > 0) return;
    const w = this.waiters;
    this.waiters = [];
    for (const resolve of w) resolve();
  }

  private pump() {
    if (this.disposed || this.inFlight || this.retryTimer !== null) return;
    const entry = this.entries[0];
    if (!entry) {
      this.settleWaiters();
      return;
    }
    const attempt = ++this.attempts;
    const abort = new AbortController();
    this.inFlight = { entry, attempt, abort };
    let settled = false;
    const finish = (r: SendResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      this.onResult(entry, attempt, r);
    };
    const timer = setTimeout(() => {
      abort.abort(); // timed out: a delivery still waiting must not send after its retry
      finish(false);
    }, this.o.ackTimeoutMs ?? 30_000);
    let result: ReturnType<SendQueueOptions<T>["deliver"]>;
    try {
      result = this.o.deliver(entry.item, abort.signal);
    } catch {
      result = false;
    }
    Promise.resolve(result).then(
      (r) => finish(r === undefined ? true : r === true || r === "rejected" ? r : false),
      () => finish(false),
    );
  }

  private onResult(entry: Entry<T>, attempt: number, r: SendResult) {
    if (this.disposed) return;
    const current = this.inFlight?.attempt === attempt;
    if (current) this.inFlight = null;
    if (r === true || r === "rejected") {
      const i = this.entries.indexOf(entry);
      if (i >= 0) {
        this.entries.splice(i, 1);
        this.account(entry);
        if (r === "rejected") this.rejected++;
        else this.delivered++;
      }
      // a late success of an abandoned attempt also settles a resend of the same item
      if (this.inFlight?.entry === entry) this.inFlight = null;
      this.failures = 0;
      this.changed();
      this.pump();
      return;
    }
    if (!current) return; // failure of an abandoned attempt
    const delays = this.o.retryDelaysMs ?? DEFAULT_RETRY;
    const delay = delays[Math.min(this.failures, delays.length - 1)] ?? 1000;
    this.failures++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.pump();
    }, delay);
    this.changed();
  }
}
