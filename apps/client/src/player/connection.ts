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
import { MicRecorder, type MicRecorderOptions } from "../audio";
import { ClockSync } from "../net/clock";
import { type Delivery, SeatGate } from "../net/delivery";
import { emitPlayer, type PlayerSocket } from "../net/socket";
import { type KeyValueStore, safeStorage } from "../net/storage";
import { Store } from "../net/store";
import { Telemetry } from "../net/telemetry";
import { forgetTracked, type RecorderLike, RecordingController } from "./recording";

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

/** What the connection runs on: Socket.IO and the browser's storage in the app, fakes in tests. */
export interface PlayerConnectionDeps {
  /** The /player socket. The connection registers its listeners at once; Socket.IO connects by itself. */
  socket: PlayerSocket;
  /** localStorage: this browser's terminal key and seat token. */
  local: KeyValueStore;
  /** sessionStorage: the clientSeq counter and the telemetry backlog (this tab, survives a reload). */
  session: KeyValueStore;
  /** Builds the capture engine (MicRecorder). */
  createRecorder(o: MicRecorderOptions): RecorderLike;
  /** Registers `fn` for `pagehide` (the telemetry backlog is saved then). */
  onPageHide?(fn: () => void): void;
}

/** The deps of the player app in the browser. */
export function browserDeps(): PlayerConnectionDeps {
  return {
    socket: io("/player", { transports: ["websocket", "polling"] }),
    local: safeStorage(() => localStorage),
    session: safeStorage(() => sessionStorage),
    createRecorder: (o) => new MicRecorder(o),
    onPageHide: (fn) => window.addEventListener("pagehide", fn),
  };
}

const TERMINAL_KEY = "wkwa.terminalKey";
const SEAT_KEY = "wkwa.seat";
const CLIENT_SEQ_KEY = "wkwa.clientSeq";

/**
 * How long an action may wait for the server's answer, reconnects included (ms). After this the
 * player is told that it was not confirmed, and it is never sent again (the map shows whether an
 * earlier send got through). Long enough for a reconnect, short enough for the player to act again.
 */
export const INTENT_DEADLINE_MS = 45_000;
/** A request's default deadline: waiting for the seat plus the answer (ms). */
const REQUEST_TIMEOUT_MS = 8000;
/** One audio upload attempt: waiting for the seat plus the server's answer (the SendQueue retries after). */
const AUDIO_SEND_TIMEOUT_MS = 20_000;
/** One telemetry batch's answer (ms); an unanswered batch is kept and sent again. */
const TELEMETRY_TIMEOUT_MS = 5000;

/** How the seat of this socket changed (see seatChanged). */
type SeatChange = "seated" | "disconnected" | "detached" | "released";

function terminalKey(local: KeyValueStore): string {
  let k = local.getItem(TERMINAL_KEY);
  if (!k || !/^[0-9a-f]{32}$/.test(k)) {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    k = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    local.setItem(TERMINAL_KEY, k);
  }
  return k;
}

function loadSeat(local: KeyValueStore): { sessionId: string; seatToken: string } | null {
  try {
    return JSON.parse(local.getItem(SEAT_KEY) ?? "null");
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

/**
 * Everything the player app needs to talk to the server. One instance per page.
 *
 * It owns the seat lifecycle (connect → `hello` → seated by hello's answer or `bound` → lost on
 * a disconnect, `detached` or `unbound`; docs/NETWORKING.md) and every acknowledged message goes
 * through one SeatGate, each sender with its delivery policy (net/delivery.ts):
 *  - intent()        `resend`: never lost, never made twice (sent again after every re-seating);
 *  - request()       `retry`: once seated; sent again after a refusal with `retry` (a reconnect
 *                    race), but not after a reconnect (consent and the like are not idempotent);
 *  - audio uploads   `attempt`: one try per call; the recorder's SendQueue backs off and retries;
 *  - telemetry       `whileSeated`: a batch goes out only while seated, else it waits;
 *  - clock:ping      `once`: no seat needed.
 */
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
  private readonly local: KeyValueStore;
  private readonly session: KeyValueStore;
  private readonly gate: SeatGate;
  private clientSeq: number;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: PlayerConnectionDeps) {
    this.socket = deps.socket;
    this.local = deps.local;
    this.session = deps.session;
    this.clientSeq = Number(this.session.getItem(CLIENT_SEQ_KEY) ?? Date.now());
    this.gate = new SeatGate((event, payload, ack) => emitPlayer(this.socket, event, payload, ack));
    this.clock = new ClockSync(
      async (payload, timeoutMs) =>
        answer(await this.gate.send("clock:ping", payload, "once", { timeoutMs })),
      (r) => this.track("clock_sync", r),
    );
    this.telemetry = new Telemetry({
      send: async (batch) => {
        const d = await this.gate.send("telemetry", batch, "whileSeated", {
          timeoutMs: TELEMETRY_TIMEOUT_MS,
        });
        if (d.status === "unsent") return "unsent";
        return d.status === "answered" && "stored" in d.ack ? "stored" : "failed";
      },
      now: () => this.clock.now(),
      clockOffsetMs: () => this.clock.offsetMs,
      storage: this.session,
      onPageHide: deps.onPageHide,
    });
    this.recording = new RecordingController({
      // One attempt within one 20 s budget, waiting for the seat like every other request (an upload
      // from a socket without one is only refused with "Not seated"). An attempt the queue gave up
      // on while waiting (`signal`) is never emitted, so a reconnect does not send the item twice.
      send: async (event, payload, signal) =>
        answer(await this.gate.send(event, payload, "attempt", { timeoutMs: AUDIO_SEND_TIMEOUT_MS, signal })),
      level: (p) => this.socket.volatile.emit("audio:level", p),
      now: () => this.clock.now(),
      clockOffsetMs: () => this.clock.offsetMs,
      permission: (p) => this.track("mic_permission", p),
      createRecorder: deps.createRecorder,
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
      this.seatChanged("disconnected");
      this.store.set((s) => ({ ...s, connected: false }));
      this.clock.stop();
    });
    this.socket.on("rehello", () => this.hello());
    this.socket.on("terminal", (m) => this.store.set((s) => ({ ...s, terminal: m.terminal })));
    this.socket.on("bound", (m) => {
      if (loadSeat(this.local)?.sessionId !== m.sessionId) {
        this.telemetry.clear();
        forgetTracked();
      }
      this.local.setItem(SEAT_KEY, JSON.stringify({ sessionId: m.sessionId, seatToken: m.seatToken }));
      this.store.set((s) => ({ ...s, seat: m.seat, sessionId: m.sessionId, notice: null }));
      // the server sends `bound` once it has seated this socket (a binding, or a re-claim after hello)
      this.seatChanged("seated");
    });
    this.socket.on("unbound", (m) => {
      this.local.removeItem(SEAT_KEY);
      this.store.set((s) => ({ ...s, seat: null, sessionId: null, view: null, notice: m.reason }));
      this.seatChanged("released");
    });
    // The session was detached on the server (switched, reloaded after an erasure, deleted): the
    // seat token is KEPT, so `rehello` re-claims the seat when the session is attached again.
    // Unanswered actions stay queued until then (or their deadline).
    this.socket.on("detached", (m) => {
      this.store.set((s) => ({ ...s, seat: null, view: null, notice: m.reason }));
      this.seatChanged("detached");
    });
    this.socket.on("state", (v) => {
      // Telemetry only after consent, and none after a withdrawal (mirrors the server-side rule).
      this.telemetry.enabled = !v.me.withdrawn && (v.me.consent === "given" || v.me.consent === "skipped");
      if (v.me.withdrawn) this.telemetry.clear();
      this.store.set((s) => ({ ...s, view: v }));
      this.recording.update(v);
      this.track("state_received", { seq: v.seq });
    });
  }

  private hello() {
    const seat = loadSeat(this.local);
    const msg = { terminalKey: terminalKey(this.local), seatToken: seat?.seatToken ?? null };
    this.socket.emit("hello", msg, (a) => {
      if (!a.ok) return;
      this.store.set((s) => ({ ...s, terminal: a.terminal }));
      // seated again (a reload, reconnect or server restart): what waits for the seat goes out now
      if (a.seat !== null) this.seatChanged("seated");
    });
  }

  /** The one place a change of the seat reaches the parts that depend on it. */
  private seatChanged(change: SeatChange) {
    const seated = change === "seated";
    if (this.store.get().seated !== seated) this.store.set((s) => ({ ...s, seated }));
    if (change === "released") this.gate.release();
    else this.gate.setSeated(seated);
    if (change === "detached" || change === "released") this.telemetry.enabled = false;
    if (change === "detached") this.recording.onDetached();
    if (change === "released") {
      this.telemetry.clear();
      this.recording.onUnbound();
    }
  }

  /**
   * Propose or decide; resolves with the server's answer (accepted, or rejected by the rules).
   *
   * The action keeps its clientSeq and click time until it is answered: it waits for the seat and
   * is sent again, unchanged, every time the socket is seated again (and after a refusal with
   * `retry`). The server stores an action once and repeats its first answer to a resend
   * (SessionManager.intent), so an action is never lost and never made twice. Rejects on a
   * permanent refusal, when the seat is released, or after INTENT_DEADLINE_MS.
   */
  async intent(kind: ActionKind, regionId: string): Promise<IntentAck> {
    const payload = { clientSeq: this.nextClientSeq(), kind, regionId, clientTs: this.clock.now() };
    const d = await this.gate.send("intent", payload, "resend", { timeoutMs: INTENT_DEADLINE_MS });
    switch (d.status) {
      case "answered":
        if ("error" in d.ack) throw new Error(d.ack.error);
        return d.ack;
      case "released":
        throw new Error("Your seat was released, so the action was not made");
      default:
        throw new Error("The server did not confirm this action — check the map before trying again");
    }
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
   * Send a request once this socket is seated, and wait for the answer. A refusal with `retry`
   * (e.g. "Not seated": the seat was lost in a reconnect race) is sent again once seated again,
   * within the same deadline. Rejects with the server's error message on a permanent refusal,
   * when the seat is released, or when there is no answer within `timeoutMs` (counted from the call).
   */
  async request<K extends PlayerRequest>(
    event: K,
    payload: PlayerPayload<K>,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<PlayerAcks[K]> {
    const d = await this.gate.send(event, payload, "retry", { timeoutMs });
    if (d.status === "released") throw new Error("Your seat was released");
    if (d.status !== "answered") {
      throw new Error(
        d.status === "timeout" && d.sent
          ? "The server did not respond — check the connection"
          : "Not connected to the server — check the connection",
      );
    }
    const ack = d.ack;
    if (typeof ack === "object" && ack && "ok" in ack && ack.ok === false && "error" in ack)
      throw new Error(ack.error);
    return ack;
  }

  nextClientSeq(): number {
    this.clientSeq += 1;
    this.session.setItem(CLIENT_SEQ_KEY, String(this.clientSeq));
    return this.clientSeq;
  }
}

/** The server's answer, or undefined when there was none (not sent, no answer in time, cancelled). */
function answer<A>(d: Delivery<A>): A | undefined {
  return d.status === "answered" ? d.ack : undefined;
}
