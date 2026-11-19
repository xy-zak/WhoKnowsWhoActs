import type { IntentAck, PlayerAcks, PlayerPayload } from "@wkwa/shared";

/**
 * How long an action may wait for the server's answer, reconnects included (ms). After this the
 * player is told that it was not confirmed, and it is never sent again (the map shows whether an
 * earlier send got through). Long enough for a reconnect, short enough for the player to act again.
 */
export const INTENT_DEADLINE_MS = 45_000;

export type IntentPayload = PlayerPayload<"intent">;

export interface IntentQueueDeps {
  /** Emit `intent` with an acknowledgement (the socket). */
  send(payload: IntentPayload, ack: (a: PlayerAcks["intent"]) => void): void;
  deadlineMs?: number;
}

interface PendingIntent {
  payload: IntentPayload;
  resolve(ack: IntentAck): void;
  reject(e: Error): void;
  deadline: ReturnType<typeof setTimeout>;
}

/**
 * The player's actions (propose, decide) until the server has answered them.
 *
 * An action keeps its clientSeq and click time until it is answered. It is sent only while the
 * socket is seated (the server has answered `hello` with this seat, or bound it since), and sent
 * again, unchanged, every time the socket becomes seated again (a reconnect, a reload of the
 * server). The server stores an action once and repeats its first answer to a resend
 * (SessionManager.intent), so an action is never lost and never made twice.
 *
 * Why not let Socket.IO buffer it: an emit made while disconnected is flushed on reconnect
 * BEFORE the `connect` handler sends `hello`, so the new server socket has no seat yet and would
 * refuse it ("Not seated").
 */
export class IntentQueue {
  /** Actions sent (or waiting to be sent) and not answered yet, by clientSeq (oldest first). */
  private pending = new Map<number, PendingIntent>();
  private seated = false;

  constructor(private readonly deps: IntentQueueDeps) {}

  /** Actions not answered yet. */
  get size(): number {
    return this.pending.size;
  }

  submit(payload: IntentPayload): Promise<IntentAck> {
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        this.pending.delete(payload.clientSeq);
        reject(new Error("The server did not confirm this action — check the map before trying again"));
      }, this.deps.deadlineMs ?? INTENT_DEADLINE_MS);
      this.pending.set(payload.clientSeq, { payload, resolve, reject, deadline });
      if (this.seated) this.send(payload.clientSeq);
    });
  }

  /** The socket became seated (send every unanswered action, oldest first) or lost its seat. */
  setSeated(seated: boolean) {
    const was = this.seated;
    this.seated = seated;
    if (seated && !was) for (const clientSeq of this.pending.keys()) this.send(clientSeq);
  }

  /** The seat is gone for good (unbound, session ended): no unanswered action can be made any more. */
  failAll(message: string) {
    for (const p of this.pending.values()) {
      clearTimeout(p.deadline);
      p.reject(new Error(message));
    }
    this.pending.clear();
  }

  private send(clientSeq: number) {
    const p = this.pending.get(clientSeq);
    if (!p) return;
    this.deps.send(p.payload, (ack) => {
      if (this.pending.get(clientSeq) !== p) return; // answered or given up meanwhile
      // not seated (a reconnect raced this send) or a server error: sent again once seated again
      if ("error" in ack && ack.retry) return;
      this.pending.delete(clientSeq);
      clearTimeout(p.deadline);
      if ("error" in ack) p.reject(new Error(ack.error));
      else p.resolve(ack);
    });
  }
}
