import {
  type AudioStartReason,
  audioSendResult,
  clampDb,
  micCapturing,
  NOT_RECORDING_REASON_DEFS,
  type PlayerAcks,
  type PlayerPayload,
  type PlayerView,
  type TelemetryPayloadOf,
} from "@wkwa/shared";
import type {
  AudioStartInfo,
  EngineCaptureSettings,
  MicLevel,
  MicRecorder,
  MicRecorderOptions,
  RecorderStatus,
  SendResult,
} from "../audio";
import { safeStorage } from "../net/storage";
import { Store } from "../net/store";
import type { RecState } from "../ui/audioMeta";
import {
  atMicCheck,
  type Effect,
  INITIAL,
  type Input,
  type Machine,
  step,
  wantsRecording,
} from "./recordingMachine";

/*
 * The player's recorder controller: drives the capture engine (audio/MicRecorder) from the
 * server's PlayerView.audio and wires it to the socket. It lives on the PlayerConnection, not in
 * a component, because screens remount on every screen change (and twice under StrictMode).
 * Its decisions, with every start and stop reason, are the state machine in recordingMachine.ts;
 * this file feeds it the views, clicks and engine states and carries out what it asks.
 *
 * When recording runs (PlayerView.audio.record, the server's recording verdict: it folds in the
 * consent hold, the facilitator's pause, the phase, a skipped mic check and withdrawal, and
 * `notRecording` names the reason when it says no):
 *  - at the mic check, only after the participant clicked Start (a user gesture: Safari and
 *    Chrome start audio only from a click); the first track's reason is `mic_check`;
 *  - past the mic check (a reload), at once with reason `reload`; Chrome then usually waits for
 *    a click (status.needsGesture: the "Resume recording" prompt);
 *  - after the facilitator's pause the track stops with `paused` (its queue drains) and a new one
 *    starts with `resume`;
 *  - after a reconnect the unacknowledged chunks are resent, the old track stops with
 *    `disconnect` and a new one starts with `reconnect`;
 *  - after the microphone was lost (denied / error), "Try again" or a device / permission change
 *    starts a new track with `permission_regained`;
 *  - at game complete the track stops with `game_complete` (its queue drains).
 * Nothing about the device (deviceId, label, groupId) is ever sent: the engine whitelists the
 * processing settings.
 */

/** The minimal recorder interface the controller uses (MicRecorder; a fake in tests). */
export type RecorderLike = Pick<
  MicRecorder,
  | "status"
  | "pendingChunks"
  | "pendingBytes"
  | "captureSettings"
  | "prepare"
  | "resume"
  | "start"
  | "stop"
  | "onReconnect"
  | "clearPending"
  | "addTap"
  | "whenSent"
>;

export type AudioUploadEvent = "audio:start" | "audio:chunk" | "audio:stop";

export interface RecordingDeps {
  /**
   * Emit with an acknowledgement once this socket holds its seat; resolves with the ack, or
   * undefined after a timeout or when `signal` aborts first (the send queue gave up on the
   * attempt: it must then not be emitted at all).
   */
  send<K extends AudioUploadEvent>(
    event: K,
    payload: PlayerPayload<K>,
    signal?: AbortSignal,
  ): Promise<PlayerAcks[K] | undefined>;
  /** Volatile `audio:level` (dropped when the network is busy). */
  level(payload: PlayerPayload<"audio:level">): void;
  /** Server-epoch time (ClockSync.now()). */
  now(): number;
  clockOffsetMs(): number;
  /** `mic_permission` telemetry. */
  permission(payload: TelemetryPayloadOf<"mic_permission">): void;
  /** Builds the engine (default: none — the connection passes `new MicRecorder(o)`). */
  createRecorder(o: MicRecorderOptions): RecorderLike;
  /** Calls `fn` when a microphone is plugged in or the permission changes; returns an unsubscribe. */
  watchDevices?(fn: () => void): () => void;
  /** The microphone permission now ("prompt" is reported as mic_permission before the browser asks). */
  queryPermission?(): Promise<PermissionState | null>;
}

export interface RecordingSnapshot {
  status: RecorderStatus;
  /** The participant clicked Start in the mic check (this page; survives a remount of the screen). */
  gesture: boolean;
  /** Rate of the browser's audio engine (Hz), from the latest track start. */
  contextSampleRate: number | null;
}

const IDLE_STATUS: RecorderStatus = {
  state: "idle",
  trackId: null,
  error: null,
  needsGesture: false,
  muted: false,
};

/* ─────────────────────────── pure helpers (unit-tested) ─────────────────────────── */

/**
 * What the recording indicator shows (null = the session records no audio). While the server's
 * verdict says no, its reason: `skipped` for a skipped mic check, `paused` when only the
 * facilitator's pause stops the seat, `off` otherwise. While it says yes, the engine's own state.
 */
export function recStateFor(
  v: PlayerView | null,
  s: Pick<RecordingSnapshot, "status" | "gesture">,
): RecState | null {
  if (!v?.audio.enabled) return null;
  const why = v.audio.notRecording;
  if (why) return NOT_RECORDING_REASON_DEFS[why].state;
  const st = s.status.state;
  // idle: waiting for the mic check's Start click, or about to start
  if (st === "idle") return atMicCheck(v) && !s.gesture ? "off" : "requesting";
  return st;
}

/** The engine waits for a click (after a reload, or the system suspended audio). */
export function needsClick(v: PlayerView | null, s: Pick<RecordingSnapshot, "status">): boolean {
  return wantsRecording(v) && s.status.needsGesture;
}

/** A track was recorded for the seat in this tab (survives a reload: sessionStorage, a flag only). */
const TRACKED_KEY = "wkwa.audio.tracked";
const tabStore = safeStorage(() => sessionStorage);
function trackedBefore(): boolean {
  return tabStore.getItem(TRACKED_KEY) === "1";
}
/** A new session on this seat: its first capture is the mic check again. */
export function forgetTracked() {
  setTrackedBefore(false);
}
function setTrackedBefore(v: boolean) {
  if (v) tabStore.setItem(TRACKED_KEY, "1");
  else tabStore.removeItem(TRACKED_KEY);
}

const round1 = (db: number) => Math.round(clampDb(db) * 10) / 10;

/* ─────────────────────────── controller ─────────────────────────── */

export class RecordingController {
  readonly store = new Store<RecordingSnapshot>({
    status: IDLE_STATUS,
    gesture: false,
    contextSampleRate: null,
  });
  /**
   * Latest ~250 ms level while capturing (null when not capturing). A store of its own: it changes
   * about 4 times a second, and only the level meters read it.
   */
  readonly levelStore = new Store<MicLevel | null>(null);
  private rec: RecorderLike | null = null;
  private unwatch: (() => void) | null = null;
  private view: PlayerView | null = null;
  private m: Machine = INITIAL;
  private connectedOnce = false;
  /** a sync pass runs (it awaits the engine's stops); `dirty`: run another one after it */
  private syncing = false;
  private dirty = false;
  /** last mic_permission state reported since the latest start (dedupes) */
  private reported: string | null = null;

  constructor(private readonly deps: RecordingDeps) {}

  /** Every new PlayerView. */
  update(v: PlayerView | null) {
    this.view = v;
    if (!this.rec && !v?.audio.enabled) return;
    this.kick();
  }

  /** The socket connected; after the first time, the next state push resyncs the recorder. */
  onConnect() {
    if (this.connectedOnce) this.dispatch("reconnected");
    this.connectedOnce = true;
  }

  /** The seat was unbound: stop, drop everything not yet sent, and forget the mic check click. */
  onUnbound() {
    this.view = null;
    setTrackedBefore(false);
    this.dispatch("unbound");
    this.publish();
    if (this.rec) this.kick();
  }

  /**
   * The session was detached on the server, but the seat is kept (its token re-claims it when the
   * session is attached again). Like a disconnect: the track stops with `disconnect`, chunks not
   * yet acknowledged stay queued and are resent once seated again, and capture restarts with
   * `reconnect`. The server already closed the track (`interrupted`) and accepts its late chunks.
   */
  onDetached() {
    this.view = null;
    this.dispatch("detached");
    this.publish();
    if (this.rec) this.kick();
  }

  /**
   * The mic check's Start (or "Try again") button. Call it synchronously from the click: the
   * audio engine is created and resumed inside the gesture (Safari, Chrome).
   */
  startFromClick() {
    const rec = this.ensure();
    if (!rec) return;
    rec.prepare();
    const effects = this.dispatch("click");
    if (effects.length)
      void this.perform(effects); // a start: it reaches the engine at once
    else if (rec.status.needsGesture) void rec.resume();
    this.publish();
    this.kick();
  }

  /** The "Resume recording" / "Try again" prompt outside the mic check (a click). */
  fixFromClick() {
    const rec = this.ensure();
    if (!rec) return;
    if (rec.status.needsGesture) {
      void rec.resume();
      return;
    }
    this.startFromClick();
  }

  /** Receives every 16 kHz block (the mic check's speech detector); returns an unsubscribe. */
  addTap(fn: (samples: Float32Array) => void): () => void {
    const rec = this.ensure();
    return rec ? rec.addTap(fn) : () => {};
  }

  /** What the browser applied (whitelisted: never a device id or label). */
  get captureSettings(): EngineCaptureSettings {
    return this.rec?.captureSettings ?? {};
  }

  dispose() {
    this.unwatch?.();
    this.unwatch = null;
  }

  /* ─── internals ─── */

  private ensure(): RecorderLike | null {
    if (this.rec) return this.rec;
    this.rec = this.deps.createRecorder({
      now: () => this.deps.now(),
      clockOffsetMs: () => this.deps.clockOffsetMs(),
      sendStart: (info, signal) => this.sendStart(info, signal),
      sendChunk: (chunk, signal) => this.upload("audio:chunk", chunk, signal),
      // the engine counts the track's dropped chunks itself (AudioStopInfo.droppedChunks)
      sendStop: (info, signal) => this.upload("audio:stop", info, signal),
      onLevel: (l) => this.onLevel(l),
      onState: (_s, status) => this.onState(status),
    });
    this.unwatch = this.deps.watchDevices?.(() => this.onDeviceChange()) ?? null;
    return this.rec;
  }

  /** Feeds one input to the state machine; returns what it asks of the engine. */
  private dispatch(input: Input, view = this.view): Effect[] {
    const s = step(this.m, input, { view, trackedInTab: trackedBefore() });
    this.m = s.m;
    return s.effects;
  }

  /** Carries out the machine's effects in order, awaiting each stop. */
  private async perform(effects: Effect[]) {
    const rec = this.rec;
    if (!rec) return;
    for (const e of effects) {
      if (e.do === "start") this.begin(rec, e.reason);
      else if (e.do === "resend") rec.onReconnect();
      else if (e.do === "clear") {
        rec.clearPending();
        this.publish();
      } else {
        await rec.stop(e.reason);
        this.reportDrained();
        this.publish();
      }
    }
  }

  private kick() {
    this.dirty = true;
    if (this.syncing) return;
    this.syncing = true;
    void (async () => {
      try {
        while (this.dirty) {
          this.dirty = false;
          await this.syncOnce();
        }
      } catch (err) {
        console.error(err);
      } finally {
        this.syncing = false;
      }
    })();
  }

  /** One pass against the view it starts with: settle a reconnect, then start or stop to match. */
  private async syncOnce() {
    const v = this.view;
    if (!this.rec && !v?.audio.enabled) return;
    this.ensure();
    await this.perform(this.dispatch("resync", v));
    await this.perform(this.dispatch("settle", v));
  }

  private begin(rec: RecorderLike, reason: AudioStartReason) {
    this.reported = null;
    void this.deps
      .queryPermission?.()
      .then((p) => {
        if (p === "prompt" && this.reported === null) this.report("prompt");
      })
      .catch(() => {});
    void rec.start(reason).catch((err) => {
      console.error(err);
      this.dispatch("start_failed");
    });
  }

  private onDeviceChange() {
    const before = this.m;
    this.dispatch("device_change");
    if (this.m === before) return;
    this.publish();
    this.kick();
  }

  private onState(status: RecorderStatus) {
    // the store holds the status of the previous call
    const prev = this.store.get().status;
    if (status.trackId && status.trackId !== prev.trackId) {
      setTrackedBefore(true);
      this.dispatch("track_started");
    }
    if (status.state === "denied" || status.state === "error") {
      this.dispatch("mic_failed");
      this.report(status.state, status.error?.name);
      if (prev.state !== status.state) this.reportDrained();
    } else if (micCapturing(status.state)) {
      this.report("granted");
    }
    this.publish(status);
    if (prev.state !== status.state) this.sendLevel(null);
  }

  private report(state: "granted" | "denied" | "error" | "prompt", errorName?: string) {
    if (this.reported === state) return;
    this.reported = state;
    const name = errorName && /^[A-Za-z]{1,64}$/.test(errorName) ? errorName : undefined;
    this.deps.permission(name ? { state, errorName: name } : { state });
  }

  private onLevel(level: MicLevel) {
    this.levelStore.set(level);
    this.sendLevel(level);
  }

  /**
   * After a stop (pause, game complete, microphone lost): once every queued chunk is acknowledged,
   * send one more `audio:level` with nothing pending. The server keeps the last report until the
   * browser disconnects, and the facilitator's wrap-up check reads its pendingChunks.
   */
  private reportDrained() {
    const rec = this.rec;
    if (!rec) return;
    void rec
      .whenSent()
      .then(() => {
        if (rec.pendingChunks === 0) this.sendLevel(null);
        this.publish();
      })
      .catch(() => {});
  }

  private sendLevel(level: MicLevel | null) {
    const rec = this.rec;
    if (!rec || !this.view?.audio.enabled) return;
    this.deps.level({
      state: rec.status.state,
      rmsDb: round1(level?.rmsDb ?? Number.NEGATIVE_INFINITY),
      peakDb: round1(level?.peakDb ?? Number.NEGATIVE_INFINITY),
      pendingChunks: rec.pendingChunks,
      pendingBytes: rec.pendingBytes,
    });
  }

  private publish(status?: RecorderStatus) {
    const st = status ?? this.rec?.status ?? IDLE_STATUS;
    if (!micCapturing(st.state) && this.levelStore.get() !== null) this.levelStore.set(null);
    this.store.set((s) => ({ ...s, status: st, gesture: this.m.gesture }));
  }

  private async sendStart(info: AudioStartInfo, signal?: AbortSignal): Promise<SendResult> {
    this.store.set((s) => ({ ...s, contextSampleRate: info.context.sampleRate }));
    return this.upload("audio:start", info, signal);
  }

  private async upload<K extends AudioUploadEvent>(
    event: K,
    payload: PlayerPayload<K>,
    signal?: AbortSignal,
  ): Promise<SendResult> {
    return audioSendResult(await this.deps.send(event, payload, signal));
  }
}
