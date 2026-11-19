import type { PlayerServerToClient } from "@wkwa/shared";
import type { PlayerSocket } from "../src/net/socket";

/** One message the client emitted. */
export interface Emitted {
  event: string;
  // biome-ignore lint/suspicious/noExplicitAny: a test inspects payloads of every message type
  payload: any;
  // biome-ignore lint/suspicious/noExplicitAny: answers of every message type
  ack?: (a: any) => void;
  volatile: boolean;
  /** emitted while disconnected (Socket.IO would buffer it and flush it BEFORE the next `hello`) */
  buffered: boolean;
}

type Handler = (...args: unknown[]) => void;

/**
 * An in-memory /player socket: the test plays the server. It records every emit (with its ack, so
 * the test answers it) and fires the server's messages and the connection events on demand. Only
 * what PlayerConnection uses is modelled: on, emit, volatile.emit, connected.
 */
export class FakeSocket {
  connected = false;
  readonly emitted: Emitted[] = [];
  private readonly handlers = new Map<string, Handler[]>();

  on(event: string, fn: Handler) {
    const list = this.handlers.get(event) ?? [];
    list.push(fn);
    this.handlers.set(event, list);
    return this;
  }

  emit(event: string, payload: unknown, ack?: (a: unknown) => void) {
    this.emitted.push({ event, payload, ack, volatile: false, buffered: !this.connected });
    return this;
  }

  get volatile() {
    return {
      emit: (event: string, payload: unknown) => {
        // a volatile message is dropped while disconnected
        if (this.connected) this.emitted.push({ event, payload, volatile: true, buffered: false });
        return true;
      },
    };
  }

  /* ─── the test's side ─── */

  /** The transport (re)connected. */
  connect() {
    this.connected = true;
    this.fire("connect");
  }

  /** The transport dropped: answers to messages of this connection never arrive. */
  disconnect() {
    this.connected = false;
    for (const e of this.emitted) e.ack = undefined;
    this.fire("disconnect", "transport close");
  }

  /** A server→client message. */
  server<E extends keyof PlayerServerToClient>(event: E, ...args: Parameters<PlayerServerToClient[E]>) {
    this.fire(event, ...args);
  }

  /** Messages emitted under `event`, oldest first. */
  sent(event: string): Emitted[] {
    return this.emitted.filter((e) => e.event === event);
  }

  /** The latest message emitted under `event`. */
  last(event: string): Emitted {
    const all = this.sent(event);
    const e = all[all.length - 1];
    if (!e) throw new Error(`nothing emitted under ${event}`);
    return e;
  }

  /** Answers the latest message emitted under `event`. */
  answer(event: string, ack: unknown) {
    const e = this.last(event);
    if (!e.ack) throw new Error(`${event} has no pending answer (answered, or lost in a disconnect)`);
    const fn = e.ack;
    e.ack = undefined;
    fn(ack);
  }

  asSocket(): PlayerSocket {
    return this as unknown as PlayerSocket;
  }

  private fire(event: string, ...args: unknown[]) {
    for (const fn of this.handlers.get(event) ?? []) fn(...args);
  }
}
