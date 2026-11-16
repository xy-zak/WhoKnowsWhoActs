import type { Ack, DashboardMsg, Scenario, StoredEvent, StoredTelemetry } from "@wkwa/shared";
import { io, type Socket } from "socket.io-client";
import { Store } from "../net/store";

export interface FacState {
  connected: boolean;
  authError: string | null;
  dashboard: DashboardMsg | null;
  scenario: Scenario | null;
  events: StoredEvent[];
  telemetry: StoredTelemetry[];
  presence: Record<number, string | null>;
  toast: { text: string; kind: "ok" | "error" } | null;
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
  readonly socket: Socket;
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
    this.socket.on("dashboard", (d: DashboardMsg) => this.store.set((s) => ({ ...s, dashboard: d })));
    this.socket.on("scenario", (sc: Scenario | null) => this.store.set((s) => ({ ...s, scenario: sc })));
    this.socket.on("events", (m: { events: StoredEvent[]; reset: boolean }) =>
      this.store.set((s) => ({
        ...s,
        events: (m.reset ? m.events : [...s.events, ...m.events]).slice(-20_000),
      })),
    );
    this.socket.on("telemetry:live", (m: { items: StoredTelemetry[]; reset?: boolean }) =>
      this.store.set((s) => ({
        ...s,
        telemetry: (m.reset ? m.items : [...s.telemetry, ...m.items]).slice(-500),
      })),
    );
    this.socket.on("presence:live", (m: { seat: number; regionId: string | null }) =>
      this.store.set((s) => ({ ...s, presence: { ...s.presence, [m.seat]: m.regionId } })),
    );
  }

  toast(text: string, kind: "ok" | "error" = "ok") {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.store.set((s) => ({ ...s, toast: { text, kind } }));
    this.toastTimer = setTimeout(
      () => this.store.set((s) => ({ ...s, toast: null })),
      kind === "error" ? 6000 : 2500,
    );
  }

  /** Send a facilitator command; shows the server's error as a toast and rethrows. */
  async cmd<T = unknown>(name: string, payload: unknown = {}, okText?: string): Promise<T> {
    const ack = await new Promise<Ack<T>>((resolve) => {
      const t = setTimeout(() => resolve({ ok: false, error: "No response from server" }), 8000);
      this.socket.emit(name, payload, (a: Ack<T>) => {
        clearTimeout(t);
        resolve(a);
      });
    });
    if (!ack.ok) {
      this.toast(ack.error, "error");
      throw new Error(ack.error);
    }
    if (okText) this.toast(okText);
    return ack.data as T;
  }

  /** REST call to /api (adds the admin token if one is configured). */
  async api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
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
      this.toast(msg, "error");
      throw new Error(msg);
    }
    return body as T;
  }

  /** Open a printable server page (key sheet / cards) in a new tab, with auth. */
  async openPrintable(path: string) {
    const html = await this.api<string>(path);
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    window.open(url, "_blank", "noopener");
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
