import type { PlayerView, TelemetryPayloadOf, TelemetryType } from "@wkwa/shared";
import { io, type Socket } from "socket.io-client";
import { MicRecorder } from "../audio";
import { ClockSync } from "../net/clock";
import { Store } from "../net/store";
import { Telemetry } from "../net/telemetry";
import { forgetTracked, RecordingController } from "./recording";

export interface PlayerConnState {
  connected: boolean;
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
  readonly socket: Socket;
  readonly clock: ClockSync;
  readonly telemetry: Telemetry;
  /** Microphone recording of this seat (sessions that record audio). */
  readonly recording: RecordingController;
  readonly store = new Store<PlayerConnState>({
    connected: false,
    terminal: null,
    seat: null,
    sessionId: null,
    view: null,
    toast: null,
    notice: null,
  });
  private clientSeq = Number(sessionStorage.getItem("wkwa.clientSeq") ?? Date.now());
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.socket = io("/player", { transports: ["websocket", "polling"] });
    this.clock = new ClockSync(this.socket, (r) => this.track("clock_sync", r));
    this.telemetry = new Telemetry(this.socket, this.clock);
    this.recording = new RecordingController({
      send: (event, payload) =>
        new Promise((resolve) => {
          this.socket.timeout(20_000).emit(event, payload, (err: unknown, ack: unknown) => {
            resolve(err ? undefined : ack);
          });
        }),
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
      this.store.set((s) => ({ ...s, connected: false }));
      this.clock.stop();
    });
    this.socket.on("rehello", () => this.hello());
    this.socket.on("terminal", (m: { terminal: number }) =>
      this.store.set((s) => ({ ...s, terminal: m.terminal })),
    );
    this.socket.on("bound", (m: { seat: number; sessionId: string; seatToken: string }) => {
      const prev = loadSeat();
      if (prev?.sessionId !== m.sessionId) {
        this.telemetry.clear();
        forgetTracked();
      }
      try {
        localStorage.setItem(SEAT_KEY, JSON.stringify({ sessionId: m.sessionId, seatToken: m.seatToken }));
      } catch {}
      this.store.set((s) => ({ ...s, seat: m.seat, sessionId: m.sessionId, notice: null }));
    });
    this.socket.on("unbound", (m: { reason: string }) => {
      try {
        localStorage.removeItem(SEAT_KEY);
      } catch {}
      this.telemetry.enabled = false;
      this.telemetry.clear();
      this.store.set((s) => ({ ...s, seat: null, sessionId: null, view: null, notice: m.reason }));
      this.recording.onUnbound();
    });
    this.socket.on("state", (v: PlayerView) => {
      // Telemetry only after consent (mirrors the server-side rule).
      this.telemetry.enabled = v.me.consent === "given" || v.me.consent === "skipped";
      this.store.set((s) => ({ ...s, view: v }));
      this.recording.update(v);
      this.track("state_received", { seq: v.seq });
    });
  }

  private hello() {
    const seat = loadSeat();
    this.socket.emit(
      "hello",
      { terminalKey: terminalKey(), seatToken: seat?.seatToken ?? null },
      (a: { terminal?: number }) => {
        if (a?.terminal) this.store.set((s) => ({ ...s, terminal: a.terminal! }));
      },
    );
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

  /** Emit with acknowledgement; rejects with the server's error message. */
  request<T = unknown>(event: string, payload: unknown, timeoutMs = 8000): Promise<T> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error("The server did not respond — check the connection")),
        timeoutMs,
      );
      this.socket.emit(event, payload, (ack: { ok?: boolean; error?: string } & T) => {
        clearTimeout(t);
        if (ack && ack.ok === false && ack.error) reject(new Error(ack.error));
        else resolve(ack);
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
