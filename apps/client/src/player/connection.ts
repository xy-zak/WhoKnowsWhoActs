import type {
  ActionKind,
  IntentAck,
  PlayerAcks,
  PlayerPayload,
  PlayerRequest,
  PlayerView,
  TelemetryPayloadOf,
  TelemetryType,
} from "@wkwa/shared";
import { io } from "socket.io-client";
import { MicRecorder } from "../audio";
import { ClockSync } from "../net/clock";
import { emitPlayer, type PlayerSocket } from "../net/socket";
import { Store } from "../net/store";
import { Telemetry } from "../net/telemetry";
import { IntentQueue } from "./intents";
import { forgetTracked, RecordingController } from "./recording";

export interface PlayerConnState {
  connected: boolean;
  /** The server answered `hello` on this connection with a seat (or bound one since): requests reach the seat. */
  seated: boolean;
  terminal: number | null;
  seat: number | null;
  sessionId: string | null;
  view: PlayerView | null;
  toast: string | null;
  /** Set when the server says the seat was unbound/ended. */
  notice: string | null;
}

const TERMINAL_KEY = "wkwa.terminalKey";
const SEAT_KEY = "wkwa.seat";
/** One audio upload attempt: waiting for the seat plus the server's answer (the queue retries after). */
const AUDIO_SEND_TIMEOUT_MS = 20_000;

function terminalKey(): string {
  try {
    let k = localStorage.getItem(TERMINAL_KEY);
    if (!k || !/^[0-9a-f]{32}$/.test(k)) {
      const b = new Uint8Array(16);
      crypto.getRandomValues(b);
      k = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
      localStorage.setItem(TERMINAL_KEY, k);
    }
    return k;
  } catch {
    return "0".repeat(32);
  }
}

function loadSeat(): { sessionId: string; seatToken: string } | null {
  try {
    return JSON.parse(localStorage.getItem(SEAT_KEY) ?? "null");
  } catch {
    return null;
  }
}

/** The microphone permission state, null where the browser cannot tell (e.g. older Firefox, Safari). */
async function micPermission(): Promise<PermissionState | null> {
  try {
    return (await navigator.permissions.query({ name: "microphone" as PermissionName })).state;
  } catch {
    return null;
  }
}

/** Calls `fn` when a device is plugged in or out, or the microphone permission changes. */
function watchMicrophone(fn: () => void): () => void {
  const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
  md?.addEventListener?.("devicechange", fn);
  let perm: PermissionStatus | null = null;
  let off = false;
  navigator.permissions
    ?.query({ name: "microphone" as PermissionName })
    .then((p) => {
      if (off) return;
      perm = p;
      p.addEventListener("change", fn);
    })
    .catch(() => {});
  return () => {
    off = true;
    md?.removeEventListener?.("devicechange", fn);
    perm?.removeEventListener("change", fn);
  };
}

/** Everything the player app needs to talk to the server. One instance per page. */
export class PlayerConnection {
  readonly socket: PlayerSocket;
  readonly clock: ClockSync;
  readonly telemetry: Telemetry;
  /** Microphone recording of this seat (sessions that record audio). */
  readonly recording: RecordingController;
  readonly store = new Store<PlayerConnState>({
    connected: false,
    seated: false,
    terminal: null,
    seat: null,
    sessionId: null,
    view: null,
    toast: null,
    notice: null,
  });
  private clientSeq = Number(sessionStorage.getItem("wkwa.clientSeq") ?? Date.now());
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  /** Actions not answered yet; resent after every reconnect (see intents.ts). */
  private readonly intents = new IntentQueue({
    send: (payload, ack) => this.socket.emit("intent", payload, ack),
  });
  /** Requests waiting for this browser to be seated on the current connection. */
  private seatWaiters = new Set<() => void>();

  constructor() {
    this.socket = io("/player", { transports: ["websocket", "polling"] });
    this.clock = new ClockSync(this.socket, (r) => this.track("clock_sync", r));
    this.telemetry = new Telemetry(this.socket, this.clock);
    this.recording = new RecordingController({
      // Waits for the seat like every other request (an upload from a socket without one is only
      // refused with "Not seated"); within one 20 s budget. An attempt the queue gave up on while
      // waiting (`signal`) is never emitted, so a reconnect does not send the item twice.
      send: async (event, payload, signal) => {
        const deadline = Date.now() + AUDIO_SEND_TIMEOUT_MS;
        try {
          await this.whenSeated(AUDIO_SEND_TIMEOUT_MS, signal);
        } catch {
          return undefined;
        }
        if (signal?.aborted) return undefined;
        return this.emitUntil(event, payload, deadline);
      },
      level: (p) => this.socket.volatile.emit("audio:level", p),
      now: () => this.clock.now(),
      clockOffsetMs: () => this.clock.offsetMs,
      permission: (p) => this.track("mic_permission", p),
      createRecorder: (o) => new MicRecorder(o),
      watchDevices: watchMicrophone,
      queryPermission: micPermission,
    });

    this.socket.on("connect", () => {
      this.store.set((s) => ({ ...s, connected: true }));
      this.recording.onConnect();
      this.hello();
      this.clock.start();
    });
    this.socket.on("disconnect", () => {
      this.setSeated(false);
      this.store.set((s) => ({ ...s, connected: false }));
      this.clock.stop();
    });
    this.socket.on("rehello", () => this.hello());
    this.socket.on("terminal", (m) => this.store.set((s) => ({ ...s, terminal: m.terminal })));
    this.socket.on("bound", (m) => {
      const prev = loadSeat();
      if (prev?.sessionId !== m.sessionId) {
        this.telemetry.clear();
        forgetTracked();
      }
      try {
        localStorage.setItem(SEAT_KEY, JSON.stringify({ sessionId: m.sessionId, seatToken: m.seatToken }));
      } catch {}
      this.store.set((s) => ({ ...s, seat: m.seat, sessionId: m.sessionId, notice: null }));
      // the server sends `bound` once it has seated this socket (a binding, or a re-claim after hello)
      this.setSeated(true);
    });
    this.socket.on("unbound", (m) => {
      try {
        localStorage.removeItem(SEAT_KEY);
      } catch {}
      this.telemetry.enabled = false;
      this.telemetry.clear();
      this.store.set((s) => ({ ...s, seat: null, sessionId: null, view: null, notice: m.reason }));
      this.setSeated(false);
      this.intents.failAll("Your seat was released, so the action was not made");
      this.recording.onUnbound();
    });
    // The session was detached on the server (switched, reloaded after an erasure, deleted): the
    // seat token is KEPT, so `rehello` re-claims the seat when the session is attached again.
    // Unanswered actions stay queued until then (or their deadline).
    this.socket.on("detached", (m) => {
      this.telemetry.enabled = false;
      this.store.set((s) => ({ ...s, seat: null, view: null, notice: m.reason }));
      this.setSeated(false);
      this.recording.onDetached();
    });
    this.socket.on("state", (v) => {
      // Telemetry only after consent (mirrors the server-side rule).
      this.telemetry.enabled = v.me.consent === "given" || v.me.consent === "skipped";
      this.store.set((s) => ({ ...s, view: v }));
      this.recording.update(v);
      this.track("state_received", { seq: v.seq });
    });
  }

  private hello() {
    const seat = loadSeat();
    this.socket.emit("hello", { terminalKey: terminalKey(), seatToken: seat?.seatToken ?? null }, (a) => {
      if (!a.ok) return;
      this.store.set((s) => ({ ...s, terminal: a.terminal }));
      // seated again (a reload, reconnect or server restart): actions still unanswered are resent
      if (a.seat !== null) this.setSeated(true);
    });
  }

  private setSeated(seated: boolean) {
    if (this.store.get().seated !== seated) this.store.set((s) => ({ ...s, seated }));
    // unanswered actions are resent once on becoming seated (hello's answer and `bound` both report it)
    this.intents.setSeated(seated);
    if (!seated) return;
    for (const wake of this.seatWaiters) wake();
    this.seatWaiters.clear();
  }

  /** Resolves once this socket is seated (at once if it is); rejects after `timeoutMs` or on `signal`. */
  private whenSeated(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (this.store.get().seated) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanUp = () => {
        clearTimeout(t);
        this.seatWaiters.delete(wake);
        signal?.removeEventListener("abort", onAbort);
      };
      const stop = (msg: string) => {
        cleanUp();
        reject(new Error(msg));
      };
      const onAbort = () => stop("Cancelled");
      const wake = () => {
        cleanUp();
        resolve();
      };
      const t = setTimeout(() => stop("Not connected to the server — check the connection"), timeoutMs);
      this.seatWaiters.add(wake);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Propose or decide; resolves with the server's answer (see IntentQueue: never lost, never made twice). */
  intent(kind: ActionKind, regionId: string): Promise<IntentAck> {
    return this.intents.submit({
      clientSeq: this.nextClientSeq(),
      kind,
      regionId,
      clientTs: this.clock.now(),
    });
  }

  track<T extends TelemetryType>(type: T, payload: TelemetryPayloadOf<T>) {
    this.telemetry.track(type, payload);
  }

  presence(regionId: string | null) {
    this.socket.volatile.emit("presence", { regionId });
  }

  showToast(text: string) {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.store.set((s) => ({ ...s, toast: text }));
    this.toastTimer = setTimeout(() => this.store.set((s) => ({ ...s, toast: null })), 3500);
  }

  /**
   * Send a request once this socket is seated, and wait for the answer; rejects with the server's
   * error message, or when there is no answer within `timeoutMs` (counted from the call).
   */
  async request<K extends PlayerRequest>(
    event: K,
    payload: PlayerPayload<K>,
    timeoutMs = 8000,
  ): Promise<PlayerAcks[K]> {
    const deadline = Date.now() + timeoutMs;
    await this.whenSeated(timeoutMs);
    const ack = await this.emitUntil(event, payload, deadline);
    if (ack === undefined) throw new Error("The server did not respond — check the connection");
    if (typeof ack === "object" && ack && "ok" in ack && ack.ok === false && "error" in ack)
      throw new Error(ack.error);
    return ack;
  }

  /** Emit and wait for the answer until `deadline` (epoch ms); undefined when none came by then. */
  private emitUntil<K extends PlayerRequest>(
    event: K,
    payload: PlayerPayload<K>,
    deadline: number,
  ): Promise<PlayerAcks[K] | undefined> {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(undefined), Math.max(0, deadline - Date.now()));
      emitPlayer(this.socket, event, payload, (ack) => {
        clearTimeout(t);
        resolve(ack);
      });
    });
  }

  nextClientSeq(): number {
    this.clientSeq += 1;
    try {
      sessionStorage.setItem("wkwa.clientSeq", String(this.clientSeq));
    } catch {}
    return this.clientSeq;
  }
}
