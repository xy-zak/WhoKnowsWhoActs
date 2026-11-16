import type { TelemetryItem, TelemetryPayloadOf, TelemetryType } from "@wkwa/shared";
import type { Socket } from "socket.io-client";
import type { ClockSync } from "./clock";

const STORAGE_KEY = "wkwa.telemetry.pending";

/**
 * Batches UI telemetry and sends it every 2 s or every 20 items.
 * Items that could not be delivered (disconnect) are kept in sessionStorage
 * and re-sent after reconnecting. Telemetry is only sent while seated.
 */
export class Telemetry {
  private buffer: TelemetryItem[] = [];
  private inFlight = false;
  private timer: ReturnType<typeof setInterval>;
  enabled = false;

  constructor(
    private readonly socket: Socket,
    private readonly clock: ClockSync,
  ) {
    try {
      const saved = sessionStorage.getItem(STORAGE_KEY);
      if (saved) this.buffer = JSON.parse(saved);
    } catch {}
    this.timer = setInterval(() => void this.flush(), 2000);
    window.addEventListener("pagehide", () => this.persist());
  }

  track<T extends TelemetryType>(type: T, payload: TelemetryPayloadOf<T>) {
    if (!this.enabled) return;
    this.buffer.push({ type, clientTs: this.clock.now(), payload } as TelemetryItem);
    if (this.buffer.length >= 20) void this.flush();
  }

  private persist() {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(this.buffer.slice(-2000)));
    } catch {}
  }

  async flush() {
    if (this.inFlight || this.buffer.length === 0 || !this.socket.connected || !this.enabled) return;
    const items = this.buffer.splice(0, 200);
    this.inFlight = true;
    const ok = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), 5000);
      this.socket.emit(
        "telemetry",
        { clockOffsetMs: this.clock.offsetMs, items },
        (ack: { stored?: number }) => {
          clearTimeout(t);
          resolve(typeof ack?.stored === "number");
        },
      );
    });
    this.inFlight = false;
    if (!ok) this.buffer.unshift(...items);
    this.persist();
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
