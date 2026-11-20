import type { PlayerAcks, PlayerPayload, PlayerRequest } from "@wkwa/shared";

/**
 * How one message is delivered, relative to this socket's seat (see SeatGate):
 *
 *  - `once`         emit now, seat or not, and wait for the answer until the deadline (clock:ping);
 *  - `whileSeated`  emit only if the socket is seated right now, else `unsent` at once (telemetry:
 *                   the caller keeps the batch and tries again later);
 *  - `attempt`      wait for the seat, emit once, wait for the answer: one attempt of a caller that
 *                   retries with a back-off of its own (the audio SendQueue). An attempt cancelled
 *                   (`signal`) while still waiting is never emitted, so the item cannot go out twice;
 *  - `retry`        wait for the seat, emit, and emit again after a refusal with `retry: true`
 *                   (requests: consent, demographics, briefing, mic check). An unanswered request
 *                   is NOT sent again after a reconnect: the server may have made it, and these
 *                   requests are not idempotent;
 *  - `resend`       like `retry`, and also sent again, unchanged, every time the socket becomes
 *                   seated again while it is unanswered (intents: the server stores an action once
 *                   per clientSeq and repeats its first answer to a resend).
 */
export type DeliveryPolicy = "once" | "whileSeated" | "attempt" | "retry" | "resend";

interface Rules {
  /** ignore the seat, require it now, or wait for it */
  seat: "ignore" | "now" | "wait";
  /** send again after a refusal with `retry: true` */
  retry: boolean;
  /** send again whenever the socket becomes seated again before the answer */
  resend: boolean;
}

const RULES: Record<DeliveryPolicy, Rules> = {
  once: { seat: "ignore", retry: false, resend: false },
  whileSeated: { seat: "now", retry: false, resend: false },
  attempt: { seat: "wait", retry: false, resend: false },
  retry: { seat: "wait", retry: true, resend: false },
  resend: { seat: "wait", retry: true, resend: true },
};

/**
 * After a refusal with `retry: true` while the socket is still seated (a server error, or a seat
 * lost that this browser has not heard about yet), the message is sent again after this pause.
 * Without a seat, it is sent again the moment the socket is seated again.
 */
export const RETRY_PAUSE_MS = 1000;

/** How a delivery ended. */
export type Delivery<A> =
  /** the server's (final) answer; a refusal with `retry: true` is final only for once/whileSeated/attempt */
  | { status: "answered"; ack: A }
  /** `whileSeated` and not seated: nothing was emitted */
  | { status: "unsent" }
  /** no (final) answer by the deadline; `sent`: it was emitted at least once */
  | { status: "timeout"; sent: boolean }
  /** the seat was released (`unbound`) before the answer: no `retry`/`resend` message survives that */
  | { status: "released" }
  /** `signal` aborted while the message was still waiting to be emitted */
  | { status: "cancelled" };

export interface DeliveryOptions {
  /** The deadline, counted from the call: waiting for the seat, every resend and the answer. */
  timeoutMs: number;
  /** Cancels the delivery while it waits to be emitted (an answer to an emitted message still counts). */
  signal?: AbortSignal;
}

/** `socket.emit(event, payload, ack)` (net/socket.ts emitPlayer on the real socket). */
export type Emit = <K extends PlayerRequest>(
  event: K,
  payload: PlayerPayload<K>,
  ack: (a: PlayerAcks[K]) => void,
) => void;

interface Pending {
  rules: Rules;
  /** waiting to be emitted (for the seat, or to be sent again), or emitted and waiting for the answer */
  phase: "waiting" | "sent";
  /** the pause before sending again after a refusal with `retry` while seated */
  pause: ReturnType<typeof setTimeout> | null;
  transmit(): void;
  end(d: Delivery<never>): void;
}

const isRetryRefusal = (ack: unknown): boolean =>
  typeof ack === "object" &&
  ack !== null &&
  (ack as { ok?: unknown }).ok === false &&
  (ack as { retry?: unknown }).retry === true;

/**
 * Every acknowledged message the player's browser sends, gated on its seat.
 *
 * The socket is *seated* once the server has answered `hello` with a seat, or sent `bound`, on
 * the current connection; it loses the seat on a disconnect, `detached` or `unbound` (released:
 * the seat is gone for good). The server refuses a seated request from a socket without a seat
 * ("Not seated", `retry: true`), so messages that need the seat wait for it here.
 *
 * Why not let Socket.IO buffer them: an emit made while disconnected is flushed on reconnect
 * BEFORE the `connect` handler sends `hello`, so the new server socket has no seat yet and would
 * refuse it.
 *
 * Messages waiting for the seat are emitted in the order they were sent, the moment the socket
 * becomes seated. One timer per message bounds everything (waiting, resends, the answer).
 */
export class SeatGate {
  private seated = false;
  /** unfinished deliveries, oldest first */
  private readonly live = new Set<Pending>();

  constructor(private readonly emit: Emit) {}

  /** Unfinished deliveries (waiting for the seat, a resend or the answer). */
  get size(): number {
    return this.live.size;
  }

  /** The socket became seated (emits what waits for the seat, resends `resend` messages) or lost its seat. */
  setSeated(seated: boolean) {
    const was = this.seated;
    this.seated = seated;
    if (!seated || was) return;
    for (const p of [...this.live]) {
      if (p.pause !== null) clearTimeout(p.pause);
      p.pause = null;
      if (p.phase === "waiting" || p.rules.resend) p.transmit();
    }
  }

  /**
   * The seat was released (`unbound`): it is lost, and `retry`/`resend` messages and everything
   * still waiting for the seat end as `released`. Messages already emitted under the other policies
   * keep waiting for their answer.
   */
  release() {
    this.setSeated(false);
    for (const p of [...this.live]) if (p.rules.retry || p.phase === "waiting") p.end({ status: "released" });
  }

  send<K extends PlayerRequest>(
    event: K,
    payload: PlayerPayload<K>,
    policy: DeliveryPolicy,
    { timeoutMs, signal }: DeliveryOptions,
  ): Promise<Delivery<PlayerAcks[K]>> {
    const rules = RULES[policy];
    if (rules.seat === "now" && !this.seated) return Promise.resolve({ status: "unsent" });
    if (signal?.aborted) return Promise.resolve({ status: "cancelled" });
    return new Promise((resolve) => {
      let attempts = 0;
      const p: Pending = {
        rules,
        phase: "waiting",
        pause: null,
        transmit: () => {
          p.phase = "sent";
          const attempt = ++attempts;
          this.emit(event, payload, (ack) => {
            if (!this.live.has(p)) return; // answered, timed out or released meanwhile
            if (rules.retry && isRetryRefusal(ack)) {
              // only the latest attempt's refusal counts: an older one was already sent again
              if (attempt === attempts) this.again(p);
              return;
            }
            // the first final answer wins, from whichever attempt (a resend is answered the same)
            end({ status: "answered", ack });
          });
        },
        end: (d) => end(d),
      };
      const end = (d: Delivery<PlayerAcks[K]>) => {
        if (!this.live.delete(p)) return;
        clearTimeout(deadline);
        if (p.pause !== null) clearTimeout(p.pause);
        signal?.removeEventListener("abort", onAbort);
        resolve(d);
      };
      const onAbort = () => {
        if (p.phase === "waiting") end({ status: "cancelled" });
      };
      const deadline = setTimeout(() => end({ status: "timeout", sent: attempts > 0 }), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.live.add(p);
      if (rules.seat === "wait" && !this.seated) return; // emitted by setSeated(true)
      p.transmit();
    });
  }

  /** After a refusal with `retry`: sent again at the next seating, or after a pause if still seated. */
  private again(p: Pending) {
    p.phase = "waiting";
    if (!this.seated) return;
    p.pause = setTimeout(() => {
      p.pause = null;
      if (this.seated && p.phase === "waiting" && this.live.has(p)) p.transmit();
    }, RETRY_PAUSE_MS);
  }
}
