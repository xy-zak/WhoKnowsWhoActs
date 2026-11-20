import type { ClockPingAck, PlayerPayload } from "@wkwa/shared";

/** How long one sample waits for the server's answer (ms). */
const PING_TIMEOUT_MS = 3000;
/** Pings per sync; the fastest answer wins. */
const SYNC_SAMPLES = 5;
/** How often the clock re-syncs (ms). */
const RESYNC_INTERVAL_MS = 60_000;

/** Emits `clock:ping` and resolves with the answer, or undefined after `timeoutMs`. */
export type ClockPing = (
  payload: PlayerPayload<"clock:ping">,
  timeoutMs: number,
) => Promise<ClockPingAck | undefined>;

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
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly sendPing: ClockPing,
    private readonly onSync?: (r: { offsetMs: number; rttMs: number; samples: number }) => void,
  ) {}

  now(): number {
    return performance.timeOrigin + performance.now() + this.offsetMs;
  }

  private async ping(): Promise<{ offset: number; rtt: number } | null> {
    const t0 = performance.now();
    const ack = await this.sendPing({ t0 }, PING_TIMEOUT_MS);
    if (!ack) return null;
    const t1 = performance.now();
    return { offset: ack.serverTs - (performance.timeOrigin + (t0 + t1) / 2), rtt: t1 - t0 };
  }

  async sync(samples = SYNC_SAMPLES) {
    const results: Array<{ offset: number; rtt: number }> = [];
    for (let i = 0; i < samples; i++) {
      const r = await this.ping();
      if (r) results.push(r);
    }
    if (results.length === 0) return;
    const best = results.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    this.offsetMs = Math.round(best.offset * 10) / 10;
    const rttMs = Math.round(best.rtt * 10) / 10;
    this.onSync?.({ offsetMs: this.offsetMs, rttMs, samples: results.length });
  }

  start(intervalMs = RESYNC_INTERVAL_MS) {
    void this.sync();
    this.stop();
    this.timer = setInterval(() => void this.sync(), intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
