import type {
  DashboardMsg,
  FacilitatorAck,
  FacilitatorCommand,
  FacilitatorPayload,
  FacilitatorResult,
  Scenario,
  StoredEvent,
  StoredTelemetry,
} from "@wkwa/shared";
import { io } from "socket.io-client";
import { emitFacilitator, type FacilitatorSocket } from "../net/socket";
import { safeStorage } from "../net/storage";
import { Store } from "../net/store";
import type { ToastMsg } from "../ui/Toast";

export interface FacState {
  connected: boolean;
  authError: string | null;
  dashboard: DashboardMsg | null;
  scenario: Scenario | null;
  events: StoredEvent[];
  telemetry: StoredTelemetry[];
  presence: Record<number, string | null>;
  toast: ToastMsg | null;
}

const TOKEN_KEY = "wkwa.adminToken";
const tokenStore = safeStorage(() => sessionStorage);

/**
 * Optional ADMIN_TOKEN (remote facilitator access): taken from ?token=… once, then kept in
 * sessionStorage, so it survives a reload but not a closed tab (player pages share this origin).
 */
function adminToken(): string | null {
  // older builds kept it in localStorage: drop that copy
  safeStorage(() => localStorage).removeItem(TOKEN_KEY);
  try {
    const url = new URL(location.href);
    const t = url.searchParams.get("token");
    if (t) {
      tokenStore.setItem(TOKEN_KEY, t);
      url.searchParams.delete("token");
      history.replaceState(null, "", url.toString());
      return t;
    }
  } catch {}
  return tokenStore.getItem(TOKEN_KEY);
}

export class FacilitatorConnection {
  readonly socket: FacilitatorSocket;
  readonly token = adminToken();
  readonly store = new Store<FacState>({
    connected: false,
    authError: null,
    dashboard: null,
    scenario: null,
    events: [],
    telemetry: [],
    presence: {},
    toast: null,
  });
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.socket = io("/facilitator", { auth: this.token ? { token: this.token } : {} });
    this.socket.on("connect", () => this.store.set((s) => ({ ...s, connected: true, authError: null })));
    this.socket.on("disconnect", () => this.store.set((s) => ({ ...s, connected: false })));
    this.socket.on("connect_error", (e) => this.store.set((s) => ({ ...s, authError: e.message })));
    this.socket.on("dashboard", (d) => this.store.set((s) => ({ ...s, dashboard: d })));
    this.socket.on("scenario", (sc) => this.store.set((s) => ({ ...s, scenario: sc })));
    this.socket.on("events", (m) =>
      this.store.set((s) => ({
        ...s,
        events: (m.reset ? m.events : [...s.events, ...m.events]).slice(-20_000),
        // another session (or none): no hover of the previous one stays on the map
        presence: m.reset ? {} : s.presence,
      })),
    );
    this.socket.on("telemetry:live", (m) =>
      this.store.set((s) => ({
        ...s,
        telemetry: (m.reset ? m.items : [...s.telemetry, ...m.items]).slice(-500),
      })),
    );
    this.socket.on("presence:live", (m) =>
      this.store.set((s) => ({ ...s, presence: { ...s.presence, [m.seat]: m.regionId } })),
    );
  }

  toast(text: string, kind: ToastMsg["kind"] = "ok") {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.store.set((s) => ({ ...s, toast: { text, kind } }));
    this.toastTimer = setTimeout(
      () => this.store.set((s) => ({ ...s, toast: null })),
      kind === "error" ? 6000 : 3000,
    );
  }

  /** Send a facilitator command; shows the server's error as a toast and rethrows. */
  async cmd<K extends FacilitatorCommand>(
    name: K,
    payload: FacilitatorPayload<K>,
    okText?: string,
  ): Promise<FacilitatorResult<K>> {
    if (!this.socket.connected) {
      // Socket.IO would buffer it and run it on reconnect, after the UI reported a failure
      const error = "Not connected to the server";
      this.toast(error, "error");
      throw new Error(error);
    }
    const ack = await new Promise<FacilitatorAck<K>>((resolve) => {
      const t = setTimeout(() => resolve({ ok: false, error: "No response from server" }), 8000);
      emitFacilitator(this.socket, name, payload, (a) => {
        clearTimeout(t);
        resolve(a);
      });
    });
    if (!ack.ok) {
      this.toast(ack.error, "error");
      throw new Error(ack.error);
    }
    if (okText) this.toast(okText);
    return ack.data;
  }

  /** Fire-and-forget `cmd`: the error toast is the whole failure handling. */
  run<K extends FacilitatorCommand>(name: K, payload: FacilitatorPayload<K>, okText?: string): void {
    this.cmd(name, payload, okText).catch(() => {});
  }

  /**
   * Fetch with the admin token (if one is configured). A non-OK reply shows the server's `error`
   * (else the HTTP status) as an error toast and throws; `quiet` skips the toast (e.g. for polls).
   */
  private async request(path: string, { quiet = false, ...init }: RequestInit & { quiet?: boolean } = {}) {
    const headers = new Headers(init.headers);
    if (this.token) headers.set("authorization", `Bearer ${this.token}`);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    const res = await fetch(path, { ...init, headers });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      const msg = body?.error ?? `${res.status} ${res.statusText}`;
      if (!quiet) this.toast(msg, "error");
      throw new Error(msg);
    }
    return res;
  }

  /** REST call to /api: the reply as JSON (or as text if it isn't JSON). Fails like `request`. */
  async api<T = unknown>(path: string, init?: RequestInit & { quiet?: boolean }): Promise<T> {
    const text = await (await this.request(path, init)).text();
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }

  /** Download a server file (e.g. a takedown-card PDF) with auth, under the given file name. */
  async download(path: string, filename: string) {
    try {
      const url = URL.createObjectURL(await (await this.request(path)).blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch {} // the error toast is the whole failure handling
  }

  /** Open a printable server page (key sheet) in a new tab, with auth. */
  async openPrintable(path: string) {
    try {
      const html = await this.api<string>(path);
      const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
      window.open(url, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {} // the error toast is the whole failure handling
  }
}
