import type { PlayerSocket } from "./socket";

/**
 * NTP-style clock synchronisation with the server.
 *
 * For each sample: t0 = send time, t1 = receive time (performance clock),
 * rtt = t1 − t0 and the server timestamp is assumed to be taken halfway, so
 *   offset = serverTs − (timeOrigin + (t0 + t1) / 2).
 * The sample with the smallest RTT is the most accurate and is kept.
 * Corrected time = timeOrigin + performance.now() + offset (server epoch ms).
 */
export class ClockSync {
  offsetMs = 0;
  rttMs: number | null = null;
  synced = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly socket: PlayerSocket,
    private readonly onSync?: (r: { offsetMs: number; rttMs: number; samples: number }) => void,
  ) {}

  now(): number {
    return performance.timeOrigin + performance.now() + this.offsetMs;
  }

  private ping(): Promise<{ offset: number; rtt: number } | null> {
    return new Promise((resolve) => {
      const t0 = performance.now();
      const timeout = setTimeout(() => resolve(null), 3000);
      this.socket.emit("clock:ping", { t0 }, (ack) => {
        clearTimeout(timeout);
        const t1 = performance.now();
        resolve({ offset: ack.serverTs - (performance.timeOrigin + (t0 + t1) / 2), rtt: t1 - t0 });
      });
    });
  }

  async sync(samples = 5) {
    const results: Array<{ offset: number; rtt: number }> = [];
    for (let i = 0; i < samples; i++) {
      const r = await this.ping();
      if (r) results.push(r);
    }
    if (results.length === 0) return;
    const best = results.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    this.offsetMs = Math.round(best.offset * 10) / 10;
    this.rttMs = Math.round(best.rtt * 10) / 10;
    this.synced = true;
    this.onSync?.({ offsetMs: this.offsetMs, rttMs: this.rttMs, samples: results.length });
  }

  start(intervalMs = 60_000) {
    void this.sync();
    this.stop();
    this.timer = setInterval(() => void this.sync(), intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
