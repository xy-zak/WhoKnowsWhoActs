import { randomBytes, randomUUID } from "node:crypto";
import {
  AUDIO_CONSENT_ITEM,
  AUDIO_MAX_CHUNK_SAMPLES,
  AUDIO_SAMPLE_RATE,
  type AudioStartReason,
  type AudioStopReason,
  audioSendResult,
  clampDb,
  type DashboardMsg,
  type FacilitatorAck,
  type FacilitatorClientToServer,
  type FacilitatorCommand,
  type FacilitatorPayload,
  type FacilitatorResult,
  type FacilitatorServerToClient,
  type PlayerAcks,
  type PlayerClientToServer,
  type PlayerPayload,
  type PlayerRequest,
  type PlayerServerToClient,
  type PlayerView,
  randomPolicy,
  type StoredEvent,
  type TelemetryItem,
} from "@wkwa/shared";
import { io, type Socket } from "socket.io-client";

/** The test clients' sockets, typed with the shared event maps like the browsers' (@wkwa/shared socket.ts). */
type PlayerSocket = Socket<PlayerServerToClient, PlayerClientToServer>;
type FacilitatorSocket = Socket<FacilitatorServerToClient, FacilitatorClientToServer>;

/**
 * Socket.IO's emit for a message name that is a generic type parameter (its emit types resolve
 * the arguments for a concrete name only). The callers' signatures tie name, payload and ack together.
 */
type UntypedEmit = (name: string, payload: unknown, ack: (a: never) => void) => unknown;
function emitUntyped(emitter: { emit: unknown }, name: string, payload: unknown, ack: (a: never) => void) {
  (emitter.emit as UntypedEmit).call(emitter, name, payload, ack);
}

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
  /** Take propose/decide actions automatically during rounds (default true). */
  autoPlay?: boolean;
  /** Go through onboarding automatically (default true; tests that drive each step themselves turn it off). */
  autoOnboard?: boolean;
  /** Use this terminal key instead of a random one (the server registers fake players' keys before they connect). */
  terminalKey?: string;
  /** Re-claim a seat with this token on connect (fake players restored after a server restart). */
  seatToken?: string | null;
  /** Last clientSeq this seat already used (a restored player continues after it instead of resending 1, 2, …). */
  clientSeqStart?: number;
  /** Keep every received state and ack in memory (default true; tests read them). Off for long-lived fake players. */
  record?: boolean;
  /** Accept any certificate, also on another machine (see tlsClientOpts; loopback is never checked). */
  insecureTls?: boolean;
  /**
   * Sessions that record audio: tick the audio consent item, pass the mic check and upload
   * synthetic audio (a quiet noise floor with speech-like bursts, louder in this seat's
   * calibration turn) whenever the server says the seat should record. Without it, a bot in a
   * session with audio declines the (required) audio item and waits, so it never takes part.
   */
  audio?: boolean;
  /** Level of the bot's synthetic speech (dBFS; default −18 dB minus 3 dB per seat after the first). */
  voiceDb?: number;
  /** Length of one uploaded chunk (ms; default 5000, at most 6000). Tests use shorter chunks. */
  audioChunkMs?: number;
}

/** A synthetic capture run of a bot. */
interface BotTrack {
  trackId: string;
  /** Server time of sample 0 (the bot's clock is the server's: same machine, offset 0). */
  t0: number;
  nextSeq: number;
  nextSample: number;
  timer: NodeJS.Timeout;
}

/** What a bot uploaded (tests read it). */
export interface BotAudioStats {
  tracks: number;
  chunksAcked: number;
  rejected: number;
  stopReasons: string[];
}

const BOT_NOISE_DB = -62;
/** How much quieter another seat's voice is on this bot's "mic" (headset-like crosstalk). */
const BOT_LEAKAGE_DB = 22;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Socket.IO client TLS options for `url`. The server's self-signed certificate (WKWA_TLS=auto) is
 * not trusted by Node, so it is not checked over loopback (this laptop) or when `insecure` is set;
 * otherwise (and for plain HTTP) the defaults apply.
 */
export function tlsClientOpts(
  url: string,
  opts: { insecure?: boolean } = {},
): { rejectUnauthorized?: false } {
  const u = new URL(url);
  if (u.protocol !== "https:") return {};
  return opts.insecure || LOOPBACK_HOSTS.has(u.hostname) ? { rejectUnauthorized: false } : {};
}

const BOT_SETTINGS = {
  sampleRate: 48_000,
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 1,
};

export class Bot {
  readonly socket: PlayerSocket;
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
  private audioTrack: BotTrack | null = null;
  /** Every send goes through this chain, so start, chunks and stop arrive in order. */
  private audioChain: Promise<void> = Promise.resolve();
  private recordedBefore = false;
  private declinedLogged = false;
  /** Calibration turns seen in the state pushes (server time). */
  private turns: Array<{ seat: number; from: number; to: number }> = [];
  private rng = 0x9e3779b9;
  readonly audioStats: BotAudioStats = { tracks: 0, chunksAcked: 0, rejected: 0, stopReasons: [] };

  constructor(private readonly opts: BotOptions) {
    this.terminalKey = opts.terminalKey ?? randomBytes(16).toString("hex");
    this.seatToken = opts.seatToken ?? null;
    this.clientSeq = opts.clientSeqStart ?? 0;
    this.socket = io(`${opts.url}/player`, {
      transports: ["websocket"],
      reconnection: true,
      forceNew: true,
      ...tlsClientOpts(opts.url, { insecure: opts.insecureTls }),
    });
    this.socket.on("connect", () => {
      // the server closed the track at the disconnect: finish it (its chunks are resent) and start a new one
      if (this.audioTrack) this.stopTrack("disconnect");
      this.hello();
    });
    this.socket.on("rehello", () => this.hello());
    this.socket.on("terminal", (m) => {
      this.terminal = m.terminal;
    });
    this.socket.on("bound", (m) => {
      this.seat = m.seat;
      this.seatToken = m.seatToken;
      this.log(`bound to seat ${m.seat}`);
    });
    this.socket.on("unbound", () => {
      this.seat = null;
      this.seatToken = null;
    });
    this.socket.on("state", (v) => {
      this.view = v;
      if (opts.record !== false) this.states.push(v);
      opts.onState?.(v);
      if (opts.telemetry !== false) this.track("state_received", { seq: v.seq });
      this.syncAudio(v);
      this.schedule();
    });
  }

  private log(msg: string) {
    this.opts.log?.(`[${this.opts.name ?? "bot"}] ${msg}`);
  }

  private hello() {
    this.socket.emit("hello", { terminalKey: this.terminalKey, seatToken: this.seatToken }, (a) => {
      if (!a.ok) return;
      this.terminal = a.terminal;
      if (a.seat) this.seat = a.seat;
    });
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

  /** Emit and wait for the ack; with `timeoutMs`, resolves null when no ack came in time. */
  emit<K extends PlayerRequest>(event: K, payload: PlayerPayload<K>): Promise<PlayerAcks[K]>;
  emit<K extends PlayerRequest>(
    event: K,
    payload: PlayerPayload<K>,
    timeoutMs: number,
  ): Promise<PlayerAcks[K] | null>;
  emit<K extends PlayerRequest>(
    event: K,
    payload: PlayerPayload<K>,
    timeoutMs?: number,
  ): Promise<PlayerAcks[K] | null> {
    return new Promise((resolve) => {
      const t = timeoutMs === undefined ? null : setTimeout(() => resolve(null), timeoutMs);
      emitUntyped(this.socket, event, payload, (ack: PlayerAcks[K]) => {
        if (t) clearTimeout(t);
        resolve(ack);
      });
    });
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
    if (v.phase === "onboarding" && this.opts.autoOnboard === false) return false;
    if (v.phase === "onboarding" && v.onboarding && v.me.nextStep) {
      const o = v.onboarding;
      let ack: unknown = null;
      if (v.me.nextStep === "consent") {
        if (v.me.consent === "declined") {
          // nothing more to do: the facilitator sees the decline (and may withdraw the seat)
          if (!this.declinedLogged) {
            this.declinedLogged = true;
            this.log("declined consent (this session records audio: run the bots with --audio)");
          }
          return false;
        }
        // the audio item only with --audio: a bot never pretends to agree to being recorded otherwise
        const answers = Object.fromEntries(
          o.consent.items.map((i) => [i.id, i.id === AUDIO_CONSENT_ITEM ? this.opts.audio === true : true]),
        );
        ack = await this.emit("consent:submit", {
          formVersion: o.consent.version,
          textSha256: o.consent.sha256,
          answers,
          durationMs: 1000,
          clientTs: Date.now(),
        });
      } else if (v.me.nextStep === "mic_check") {
        // held while another seat is still in consent: wait for the next state push
        if (v.audio.micCheckHeld || !this.opts.audio) return false;
        ack = await this.emit("mic:check", {
          passed: true,
          attempts: 1,
          durationMs: 1500,
          settings: BOT_SETTINGS,
          noiseFloorDb: BOT_NOISE_DB,
          speechDb: this.voiceDb(),
          speechMs: 1500,
          clientTs: Date.now(),
        });
      } else if (v.me.nextStep === "demographics") {
        const answers = Object.fromEntries(
          o.demographics.questions.map((q) => [
            q.id,
            q.options[Math.floor(Math.random() * q.options.length)]!.value,
          ]),
        );
        ack = await this.emit("demographics:submit", {
          formVersion: o.demographics.version,
          answers,
          durationMs: 1000,
          clientTs: Date.now(),
        });
      } else if (v.me.nextStep === "briefing") {
        ack = await this.emit("briefing:ack", {
          textSha256: o.briefing.sha256,
          durationMs: 1000,
          clientTs: Date.now(),
        });
      }
      if (ack === null) return false;
      this.recordAck(ack);
      // a refused step is not retried at once (that would spin); the next state push tries again
      return (ack as { ok?: boolean }).ok === true;
    } else if (this.opts.autoPlay !== false) {
      // the same random play as the `random` agent policy of simulated sessions
      const action = randomPolicy.act(v, {
        seat: v.me.seat,
        params: { proposeBias: this.opts.proposeBias ?? 0.5 },
        random: Math.random,
        memory: {},
        now: Date.now(),
      });
      if (action) {
        const { kind, regionId } = action;
        if (this.opts.telemetry !== false) {
          this.track("region_hover", { regionId, durationMs: 200 + Math.round(Math.random() * 800) });
          this.track("tool_select", { tool: kind });
          this.track("action_draft", { kind, regionId, outcome: "confirmed" });
        }
        this.recordAck(
          await this.emit("intent", { clientSeq: ++this.clientSeq, kind, regionId, clientTs: Date.now() }),
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

  /* ─────────── synthetic audio (opts.audio) ─────────── */

  private voiceDb(): number {
    return this.opts.voiceDb ?? -18 - 3 * ((this.seat ?? 1) - 1);
  }

  /** Start or stop the synthetic recording as the server's `audio.record` says. */
  private syncAudio(v: PlayerView) {
    const c = v.audio.calibration;
    if (c.turnSeat !== null && c.turnEndsAt !== null) {
      const last = this.turns[this.turns.length - 1];
      if (!last || last.seat !== c.turnSeat || last.to !== c.turnEndsAt)
        this.turns.push({ seat: c.turnSeat, from: Math.min(Date.now(), c.turnEndsAt), to: c.turnEndsAt });
    }
    if (!this.opts.audio || this.stopped) return;
    if (v.audio.record && !this.audioTrack) {
      const reason: AudioStartReason = !this.recordedBefore
        ? "mic_check"
        : this.wasPaused
          ? "resume"
          : "reconnect";
      this.wasPaused = false;
      this.startTrack(reason);
    } else if (!v.audio.record && this.audioTrack) {
      const reason: AudioStopReason = v.audio.paused
        ? "paused"
        : v.phase === "game_complete"
          ? "game_complete"
          : v.me.withdrawn
            ? "withdrawn"
            : "client_stop";
      this.wasPaused = v.audio.paused;
      this.stopTrack(reason);
    }
  }

  private wasPaused = false;

  private startTrack(reason: AudioStartReason) {
    const chunkMs = Math.min(6000, Math.max(200, this.opts.audioChunkMs ?? 5000));
    const t0 = Date.now();
    const track: BotTrack = {
      trackId: randomUUID(),
      t0,
      nextSeq: 0,
      nextSample: 0,
      timer: setInterval(() => this.emitChunk(track, false), chunkMs),
    };
    this.audioTrack = track;
    this.recordedBefore = true;
    this.audioStats.tracks++;
    this.sendAudio("audio:start", {
      trackId: track.trackId,
      reason,
      sampleRate: AUDIO_SAMPLE_RATE,
      chunkSamples: Math.round((chunkMs * AUDIO_SAMPLE_RATE) / 1000),
      clientTs: t0,
      clockOffsetMs: 0,
      inputLatencyMs: 0,
      settings: BOT_SETTINGS,
      context: {
        sampleRate: 48_000,
        baseLatencyMs: null,
        outputLatencyMs: null,
        timingMethod: "current-time",
      },
    });
  }

  private stopTrack(reason: AudioStopReason) {
    const track = this.audioTrack;
    if (!track) return;
    clearInterval(track.timer);
    this.audioTrack = null;
    this.emitChunk(track, true);
    this.audioStats.stopReasons.push(reason);
    this.sendAudio("audio:stop", {
      trackId: track.trackId,
      reason,
      chunks: track.nextSeq,
      samples: track.nextSample,
      droppedChunks: 0,
      clientTs: track.t0 + (track.nextSample * 1000) / AUDIO_SAMPLE_RATE,
      clockOffsetMs: 0,
    });
  }

  /** Upload the samples captured since the last chunk (all up to now). */
  private emitChunk(track: BotTrack, final: boolean) {
    const due = Math.floor(((Date.now() - track.t0) * AUDIO_SAMPLE_RATE) / 1000);
    let n = Math.min(due - track.nextSample, AUDIO_MAX_CHUNK_SAMPLES);
    if (n <= 0 || (!final && n < AUDIO_SAMPLE_RATE / 10)) return;
    n = Math.max(1, n);
    const startSample = track.nextSample;
    const { pcm, sumSquares, peak } = this.synthesise(track.t0, startSample, n);
    const toDb = (v: number) => Math.round(clampDb(20 * Math.log10(v / 32768)) * 10) / 10;
    const rmsDb = toDb(Math.sqrt(sumSquares / n));
    const peakDb = toDb(peak);
    this.sendAudio("audio:chunk", {
      trackId: track.trackId,
      seq: track.nextSeq++,
      startSample,
      sampleCount: n,
      clientTs: track.t0 + (startSample * 1000) / AUDIO_SAMPLE_RATE,
      clockOffsetMs: 0,
      rmsDb,
      peakDb,
      clippedSamples: 0,
      pcm,
    });
    track.nextSample += n;
    if (this.view?.audio.enabled) {
      this.socket.volatile.emit("audio:level", {
        state: "recording",
        rmsDb,
        peakDb,
        pendingChunks: 0,
        pendingBytes: 0,
      });
    }
  }

  private random(): number {
    // xorshift32: cheap and good enough for noise
    let x = this.rng;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rng = x >>> 0;
    return this.rng / 4294967296;
  }

  /**
   * Synthetic 16 kHz s16le audio: a noise floor, plus speech-like bursts (noise with a 4 Hz
   * syllable rhythm). In a calibration turn the speaking seat is loud on its own mic and
   * BOT_LEAKAGE_DB quieter on the others; during rounds a bot talks now and then at its own level.
   * Also returns the sum of squares and the peak of the samples (for the chunk's levels).
   */
  private synthesise(
    t0: number,
    startSample: number,
    n: number,
  ): { pcm: Buffer; sumSquares: number; peak: number } {
    const out = Buffer.alloc(n * 2);
    const me = this.seat;
    const voice = 32768 * 10 ** (this.voiceDb() / 20);
    const leak = 32768 * 10 ** ((this.voiceDb() - BOT_LEAKAGE_DB) / 20);
    const noise = 32768 * 10 ** (BOT_NOISE_DB / 20);
    const inRound = this.view?.phase === "round_active";
    let talkUntil = -1;
    let talking = false;
    let sumSquares = 0;
    let peak = 0;
    // only the calibration turns that overlap this chunk
    const from = t0 + (startSample * 1000) / AUDIO_SAMPLE_RATE;
    const to = t0 + ((startSample + n) * 1000) / AUDIO_SAMPLE_RATE;
    const turns = this.turns.filter((x) => x.from < to && x.to > from);
    for (let i = 0; i < n; i++) {
      const t = t0 + ((startSample + i) * 1000) / AUDIO_SAMPLE_RATE;
      let amp = 0;
      const turn = turns.length > 0 ? turns.find((x) => t >= x.from && t < x.to) : undefined;
      if (turn) amp = turn.seat === me ? voice : leak;
      else if (inRound) {
        if (t >= talkUntil) {
          talking = this.random() < 0.3;
          talkUntil = t + 1000;
        }
        if (talking) amp = voice;
      }
      const syllable = 0.5 + 0.5 * Math.sin((2 * Math.PI * 4 * t) / 1000);
      const v = (this.random() * 2 - 1) * (noise + amp * syllable * syllable * 1.7);
      const x = Math.max(-32767, Math.min(32767, Math.round(v)));
      out.writeInt16LE(x, i * 2);
      sumSquares += x * x;
      peak = Math.max(peak, Math.abs(x));
    }
    return { pcm: out, sumSquares, peak };
  }

  /** Send an audio message in order, retrying transient refusals and timeouts (not "rejected" ones). */
  private sendAudio<K extends "audio:start" | "audio:chunk" | "audio:stop">(
    event: K,
    payload: PlayerPayload<K>,
  ) {
    const deliver = async () => {
      for (let attempt = 0; attempt < 30 && !this.stopped; attempt++) {
        const ack = await this.emit(event, payload, 10_000);
        const r = audioSendResult(ack);
        if (r === true) {
          if (event === "audio:chunk") this.audioStats.chunksAcked++;
          return;
        }
        if (r === "rejected") {
          this.audioStats.rejected++;
          this.log(`${event} refused: ${(ack as { error?: string }).error ?? "?"}`);
          return;
        }
        await new Promise((res) => setTimeout(res, Math.min(5000, 250 * (attempt + 1))));
      }
    };
    this.audioChain = this.audioChain.then(deliver, deliver);
  }

  /** Resolves when every audio message queued so far was acknowledged (or given up). */
  audioSent(): Promise<void> {
    return this.audioChain;
  }

  /** Stop recording now (uploads the rest of the track and its stop). */
  stopAudio(reason: AudioStopReason = "client_stop") {
    this.stopTrack(reason);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.audioTrack) clearInterval(this.audioTrack.timer);
    this.audioTrack = null;
    this.socket.close();
  }
}

/** Minimal facilitator client (tests and automation). */
export class FacilitatorClient {
  readonly socket: FacilitatorSocket;
  dashboard: DashboardMsg | null = null;
  events: StoredEvent[] = [];

  constructor(url: string, token?: string, opts: { insecureTls?: boolean } = {}) {
    this.socket = io(`${url}/facilitator`, {
      transports: ["websocket"],
      forceNew: true,
      auth: token ? { token } : {},
      ...tlsClientOpts(url, { insecure: opts.insecureTls }),
    });
    this.socket.on("dashboard", (d) => {
      this.dashboard = d;
    });
    this.socket.on("events", (m) => {
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

  async cmd<K extends FacilitatorCommand>(
    name: K,
    ...[payload]: Record<string, never> extends FacilitatorPayload<K>
      ? [FacilitatorPayload<K>?]
      : [FacilitatorPayload<K>]
  ): Promise<FacilitatorResult<K>> {
    const ack = await new Promise<FacilitatorAck<K>>((resolve) =>
      emitUntyped(this.socket, name, payload ?? {}, resolve),
    );
    if (!ack.ok) throw new Error(`${name}: ${ack.error}`);
    return ack.data;
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
