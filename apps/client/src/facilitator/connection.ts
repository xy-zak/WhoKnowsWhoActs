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

/** Optional ADMIN_TOKEN (remote facilitator access): taken from ?token=… once, then kept in localStorage. */
function adminToken(): string | null {
  try {
    const url = new URL(location.href);
    const t = url.searchParams.get("token");
    if (t) {
      localStorage.setItem(TOKEN_KEY, t);
      url.searchParams.delete("token");
      history.replaceState(null, "", url.toString());
      return t;
    }
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
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

  /**
   * REST call to /api (adds the admin token if one is configured). A failure shows as an error
   * toast and rethrows; `quiet` skips the toast (e.g. for polls).
   */
  async api<T = unknown>(
    path: string,
    { quiet = false, ...init }: RequestInit & { quiet?: boolean } = {},
  ): Promise<T> {
    const headers = new Headers(init.headers);
    if (this.token) headers.set("authorization", `Bearer ${this.token}`);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    const res = await fetch(path, { ...init, headers });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {}
    if (!res.ok) {
      const msg = (body as { error?: string })?.error ?? `${res.status} ${res.statusText}`;
      if (!quiet) this.toast(msg, "error");
      throw new Error(msg);
    }
    return body as T;
  }

  /** Download a server file (e.g. a takedown-card PDF) with auth, under the given file name. */
  async download(path: string, filename: string) {
    const headers = new Headers();
    if (this.token) headers.set("authorization", `Bearer ${this.token}`);
    const res = await fetch(path, { headers });
    if (!res.ok) {
      const msg = await res.text().catch(() => res.statusText);
      this.toast(msg || `${res.status}`, "error");
      throw new Error(msg);
    }
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  /** Open a printable server page (key sheet) in a new tab, with auth. */
  async openPrintable(path: string) {
    const html = await this.api<string>(path);
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
