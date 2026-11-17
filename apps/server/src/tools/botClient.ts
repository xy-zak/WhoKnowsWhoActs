import { randomBytes } from "node:crypto";
import type { Ack, ActionKind, DashboardMsg, PlayerView, StoredEvent, TelemetryItem } from "@wkwa/shared";
import { io, type Socket } from "socket.io-client";

/**
 * Simulated player. Used by `npm run bots` (to fill empty seats during
 * development or a pilot) and by the integration tests.
 * Everything a bot does goes through the same protocol as a real browser.
 */
export interface BotOptions {
  url: string;
  name?: string;
  /** Delay range between actions (ms). */
  minDelayMs?: number;
  maxDelayMs?: number;
  /** Emit synthetic UI telemetry (hover/inspect/state acks). */
  telemetry?: boolean;
  /** Called for every received state. */
  onState?: (v: PlayerView) => void;
  log?: (msg: string) => void;
  /** Probability per turn of proposing (vs deciding) when both are available. */
  proposeBias?: number;
  /** Take propose/decide actions automatically during rounds (default true). Onboarding is always automatic. */
  autoPlay?: boolean;
  /** Use this terminal key instead of a random one (the server registers fake players' keys before they connect). */
  terminalKey?: string;
  /** Re-claim a seat with this token on connect (fake players restored after a server restart). */
  seatToken?: string | null;
  /** Last clientSeq this seat already used (a restored player continues after it instead of resending 1, 2, …). */
  clientSeqStart?: number;
  /** Keep every received state and ack in memory (default true; tests read them). Off for long-lived fake players. */
  record?: boolean;
  /** Accept a self-signed certificate (the server connecting to itself over TLS). */
  insecureTls?: boolean;
}

export class Bot {
  readonly socket: Socket;
  readonly terminalKey: string;
  seatToken: string | null = null;
  terminal: number | null = null;
  seat: number | null = null;
  view: PlayerView | null = null;
  states: PlayerView[] = [];
  acks: unknown[] = [];
  private clientSeq = 0;
  private busy = false;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private telemetryBuffer: TelemetryItem[] = [];

  constructor(private readonly opts: BotOptions) {
    this.terminalKey = opts.terminalKey ?? randomBytes(16).toString("hex");
    this.seatToken = opts.seatToken ?? null;
    this.clientSeq = opts.clientSeqStart ?? 0;
    this.socket = io(`${opts.url}/player`, {
      transports: ["websocket"],
      reconnection: true,
      forceNew: true,
      ...(opts.insecureTls ? { rejectUnauthorized: false } : {}),
    });
    this.socket.on("connect", () => this.hello());
    this.socket.on("rehello", () => this.hello());
    this.socket.on("terminal", (m: { terminal: number }) => {
      this.terminal = m.terminal;
    });
    this.socket.on("bound", (m: { seat: number; seatToken: string }) => {
      this.seat = m.seat;
      this.seatToken = m.seatToken;
      this.log(`bound to seat ${m.seat}`);
    });
    this.socket.on("unbound", () => {
      this.seat = null;
      this.seatToken = null;
    });
    this.socket.on("state", (v: PlayerView) => {
      this.view = v;
      if (opts.record !== false) this.states.push(v);
      opts.onState?.(v);
      if (opts.telemetry !== false) this.track("state_received", { seq: v.seq });
      this.schedule();
    });
  }

  private log(msg: string) {
    this.opts.log?.(`[${this.opts.name ?? "bot"}] ${msg}`);
  }

  private hello() {
    this.socket.emit(
      "hello",
      { terminalKey: this.terminalKey, seatToken: this.seatToken },
      (a: { terminal: number; seat: number | null }) => {
        this.terminal = a.terminal;
        if (a.seat) this.seat = a.seat;
      },
    );
  }

  waitFor(pred: (v: PlayerView) => boolean, timeoutMs = 10_000): Promise<PlayerView> {
    return new Promise((resolve, reject) => {
      if (this.view && pred(this.view)) return resolve(this.view);
      const t = setTimeout(() => {
        this.socket.off("state", h);
        reject(new Error(`timeout waiting (seat ${this.seat}, phase ${this.view?.phase})`));
      }, timeoutMs);
      const h = (v: PlayerView) => {
        if (pred(v)) {
          clearTimeout(t);
          this.socket.off("state", h);
          resolve(v);
        }
      };
      this.socket.on("state", h);
    });
  }

  async waitForTerminal(timeoutMs = 5000): Promise<number> {
    const start = Date.now();
    while (this.terminal === null) {
      if (Date.now() - start > timeoutMs) throw new Error("no terminal assigned");
      await new Promise((r) => setTimeout(r, 20));
    }
    return this.terminal;
  }

  emit<T = unknown>(event: string, payload: unknown): Promise<T> {
    return new Promise((resolve) => this.socket.emit(event, payload, (ack: T) => resolve(ack)));
  }

  track<T extends TelemetryItem["type"]>(type: T, payload: Extract<TelemetryItem, { type: T }>["payload"]) {
    this.telemetryBuffer.push({ type, clientTs: Date.now(), payload } as TelemetryItem);
    if (this.telemetryBuffer.length >= 20) void this.flushTelemetry();
  }

  async flushTelemetry() {
    if (this.telemetryBuffer.length === 0 || !this.seat) return;
    const items = this.telemetryBuffer.splice(0);
    await this.emit("telemetry", { clockOffsetMs: 0, items });
  }

  private schedule() {
    if (this.stopped || this.busy || this.timer) return;
    const onboarding = this.view?.phase === "onboarding";
    const min = onboarding ? 5 : (this.opts.minDelayMs ?? 50);
    const max = onboarding ? 20 : (this.opts.maxDelayMs ?? 150);
    this.timer = setTimeout(
      () => {
        this.timer = null;
        void this.step();
      },
      min + Math.random() * (max - min),
    );
  }

  /** One decision step based on the latest state. */
  private async step() {
    const v = this.view;
    if (!v || this.stopped || !this.seat) return;
    this.busy = true;
    let acted = false;
    try {
      acted = await this.decide(v);
    } finally {
      this.busy = false;
    }
    // state pushes that arrived while we were waiting for an ack were not scheduled
    if (acted) this.schedule();
  }

  private async decide(v: PlayerView): Promise<boolean> {
    if (v.phase === "onboarding" && v.onboarding && v.me.nextStep) {
      const o = v.onboarding;
      if (v.me.nextStep === "consent") {
        const answers = Object.fromEntries(o.consent.items.map((i) => [i.id, true]));
        this.recordAck(
          await this.emit("consent:submit", {
            formVersion: o.consent.version,
            textSha256: o.consent.sha256,
            answers,
            durationMs: 1000,
            clientTs: Date.now(),
          }),
        );
      } else if (v.me.nextStep === "demographics") {
        const answers = Object.fromEntries(
          o.demographics.questions.map((q) => [
            q.id,
            q.options[Math.floor(Math.random() * q.options.length)]!.value,
          ]),
        );
        this.recordAck(
          await this.emit("demographics:submit", {
            formVersion: o.demographics.version,
            answers,
            durationMs: 1000,
            clientTs: Date.now(),
          }),
        );
      } else if (v.me.nextStep === "briefing") {
        this.recordAck(
          await this.emit("briefing:ack", {
            textSha256: o.briefing.sha256,
            durationMs: 1000,
            clientTs: Date.now(),
          }),
        );
      }
      return true;
    } else if (v.phase === "round_active" && !v.paused && !v.me.withdrawn && this.opts.autoPlay !== false) {
      const left = (k: ActionKind) => {
        const q = v.me.quota[k];
        return q.limit === null ? Number.POSITIVE_INFINITY : q.limit - q.used;
      };
      const kinds = (["propose", "decide"] as const).filter((k) => left(k) > 0);
      if (kinds.length > 0) {
        const kind =
          kinds.length === 2
            ? Math.random() < (this.opts.proposeBias ?? 0.5)
              ? "propose"
              : "decide"
            : kinds[0]!;
        const regions = v.map.regions;
        const region = regions[Math.floor(Math.random() * regions.length)]!;
        if (this.opts.telemetry !== false) {
          this.track("region_hover", {
            regionId: region.id,
            durationMs: 200 + Math.round(Math.random() * 800),
          });
          this.track("tool_select", { tool: kind });
          this.track("action_draft", { kind, regionId: region.id, outcome: "confirmed" });
        }
        this.recordAck(
          await this.emit("intent", {
            clientSeq: ++this.clientSeq,
            kind,
            regionId: region.id,
            clientTs: Date.now(),
          }),
        );
        await this.flushTelemetry();
        return true;
      }
    }
    return false;
  }

  private recordAck(ack: unknown) {
    if (this.opts.record !== false) this.acks.push(ack);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.socket.close();
  }
}

/** Minimal facilitator client (tests and automation). */
export class FacilitatorClient {
  readonly socket: Socket;
  dashboard: DashboardMsg | null = null;
  events: StoredEvent[] = [];

  constructor(url: string, token?: string) {
    this.socket = io(`${url}/facilitator`, {
      transports: ["websocket"],
      forceNew: true,
      auth: token ? { token } : {},
    });
    this.socket.on("dashboard", (d: DashboardMsg) => {
      this.dashboard = d;
    });
    this.socket.on("events", (m: { events: StoredEvent[]; reset: boolean }) => {
      if (m.reset) this.events = [];
      this.events.push(...m.events);
    });
  }

  connected(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.socket.connected) return resolve();
      this.socket.once("connect", () => resolve());
      this.socket.once("connect_error", (e) => reject(e));
    });
  }

  async cmd<T = unknown>(name: string, payload: unknown = {}): Promise<T> {
    const ack = await new Promise<Ack<T>>((resolve) => this.socket.emit(name, payload, resolve));
    if (!ack.ok) throw new Error(`${name}: ${ack.error}`);
    return ack.data as T;
  }

  waitForDashboard(pred: (d: DashboardMsg) => boolean, timeoutMs = 10_000): Promise<DashboardMsg> {
    return new Promise((resolve, reject) => {
      if (this.dashboard && pred(this.dashboard)) return resolve(this.dashboard);
      const t = setTimeout(() => {
        this.socket.off("dashboard", h);
        reject(new Error(`timeout waiting for dashboard (phase ${this.dashboard?.state?.phase})`));
      }, timeoutMs);
      const h = (d: DashboardMsg) => {
        if (pred(d)) {
          clearTimeout(t);
          this.socket.off("dashboard", h);
          resolve(d);
        }
      };
      this.socket.on("dashboard", h);
    });
  }

  close() {
    this.socket.close();
  }
}
