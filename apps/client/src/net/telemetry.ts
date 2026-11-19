import type { PlayerPayload, TelemetryItem, TelemetryPayloadOf, TelemetryType } from "@wkwa/shared";
import type { KeyValueStore } from "./storage";

const STORAGE_KEY = "wkwa.telemetry.pending";

export interface TelemetryDeps {
  /**
   * Sends one batch if the socket is seated now (the connection's `whileSeated` delivery): `stored`
   * when the server took it, `failed` when it refused it or did not answer in time, `unsent` when
   * nothing was emitted (no seat).
   */
  send(batch: PlayerPayload<"telemetry">): Promise<"stored" | "failed" | "unsent">;
  /** Server-epoch time (ClockSync.now()). */
  now(): number;
  clockOffsetMs(): number;
  /** sessionStorage: the backlog survives a reload of the page. */
  storage: KeyValueStore;
  /** Registers `fn` for the page being hidden or unloaded (`pagehide`). */
  onPageHide?(fn: () => void): void;
}

/**
 * Batches UI telemetry and sends it every 2 s or every 20 items.
 *
 * Items are recorded only while `enabled` (after consent; the connection sets it from the state).
 * They are sent only while the socket is seated; items that could not be delivered (a disconnect,
 * a refusal, no answer) are kept, in sessionStorage too, and sent again later.
 */
export class Telemetry {
  private buffer: TelemetryItem[] = [];
  private inFlight = false;
  private timer: ReturnType<typeof setInterval>;
  enabled = false;

  constructor(private readonly deps: TelemetryDeps) {
    try {
      const saved = deps.storage.getItem(STORAGE_KEY);
      if (saved) this.buffer = JSON.parse(saved);
    } catch {}
    this.timer = setInterval(() => void this.flush(), 2000);
    deps.onPageHide?.(() => this.persist());
  }

  track<T extends TelemetryType>(type: T, payload: TelemetryPayloadOf<T>) {
    if (!this.enabled) return;
    this.buffer.push({ type, clientTs: this.deps.now(), payload } as TelemetryItem);
    if (this.buffer.length >= 20) void this.flush();
  }

  private persist() {
    this.deps.storage.setItem(STORAGE_KEY, JSON.stringify(this.buffer.slice(-2000)));
  }

  async flush() {
    if (this.inFlight || this.buffer.length === 0 || !this.enabled) return;
    const items = this.buffer.splice(0, 200);
    this.inFlight = true;
    const r = await this.deps.send({ clockOffsetMs: this.deps.clockOffsetMs(), items });
    this.inFlight = false;
    if (r !== "stored") this.buffer.unshift(...items);
    if (r !== "unsent") this.persist();
  }

  /** Drop pending items (e.g. when the seat is unbound). */
  clear() {
    this.buffer = [];
    this.persist();
  }

  dispose() {
    clearInterval(this.timer);
  }
}
