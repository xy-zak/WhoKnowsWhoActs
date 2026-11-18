import {
  AUDIO_START_REASONS,
  AUDIO_STOP_REASONS,
  type AudioStartReason,
  type AudioStopReason,
  audioSendResult,
  clampDb,
  type MicLevelState,
  type PlayerView,
  type TelemetryPayloadOf,
} from "@wkwa/shared";
import type {
  AudioCaptureSettings,
  AudioChunk,
  AudioStartInfo,
  AudioStopInfo,
  MicLevel,
  MicRecorderOptions,
  RecorderState,
  RecorderStatus,
  SendResult,
} from "../audio";
import { Store } from "../net/store";
import type { RecState } from "../ui/audioMeta";

/*
 * The player's recorder controller: drives the capture engine (audio/MicRecorder) from the
 * server's PlayerView.audio and wires it to the socket. It lives on the PlayerConnection, not in
 * a component, because screens remount on every screen change (and twice under StrictMode).
 *
 * When recording runs (PlayerView.audio.record, which already folds in the consent hold, the
 * facilitator's pause, the phase, a skipped mic check and withdrawal):
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
export interface RecorderLike {
  readonly status: RecorderStatus;
  readonly pendingChunks: number;
  readonly pendingBytes: number;
  readonly droppedChunks: number;
  readonly captureSettings: AudioCaptureSettings;
  prepare(): boolean;
  resume(): Promise<boolean>;
  start(reason?: string): Promise<RecorderState>;
  stop(reason?: string): Promise<void>;
  onReconnect(): void;
  clearPending(): number;
  addTap(fn: (samples: Float32Array) => void): () => void;
  /** Resolves when everything recorded so far has been acknowledged. */
  whenSent(): Promise<void>;
}

export interface AudioLevelPayload {
  state: MicLevelState;
  rmsDb: number;
  peakDb: number;
  pendingChunks: number;
  pendingBytes: number;
}

export type AudioUploadEvent = "audio:start" | "audio:chunk" | "audio:stop";

export interface RecordingDeps {
  /** Emit with an acknowledgement; resolves with the ack, or undefined after a timeout. */
  send(event: AudioUploadEvent, payload: unknown): Promise<unknown>;
  /** Volatile `audio:level` (dropped when the network is busy). */
  level(payload: AudioLevelPayload): void;
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
  /** Latest ~250 ms level while capturing (null when not capturing). */
  level: MicLevel | null;
  /** The participant clicked Start in the mic check (this page). */
  gesture: boolean;
  /** Capture failed (denied / error) and waits for "Try again" (or a device change). */
  failed: boolean;
  /** Rate of the browser's audio engine (Hz), from the latest track start. */
  contextSampleRate: number | null;
  pendingChunks: number;
  droppedChunks: number;
}

const IDLE_STATUS: RecorderStatus = {
  state: "idle",
  trackId: null,
  error: null,
  needsGesture: false,
  muted: false,
};

/* ─────────────────────────── pure helpers (unit-tested) ─────────────────────────── */

/** The server wants this browser to capture now. */
export function wantsRecording(v: PlayerView | null): boolean {
  return !!v && v.audio.enabled && v.audio.record;
}

/** The mic check is this seat's current step. */
export function atMicCheck(v: PlayerView | null): boolean {
  return !!v && v.phase === "onboarding" && !v.me.withdrawn && v.me.nextStep === "mic_check";
}

/** Why the running track stops when the server no longer wants recording. */
export function stopReasonFor(v: PlayerView | null): AudioStopReason {
  if (!v) return "client_stop";
  if (v.me.withdrawn) return "withdrawn";
  if (v.audio.micCheck === "skipped") return "skipped";
  if (v.audio.paused) return "paused";
  switch (v.phase) {
    case "game_complete":
      return "game_complete";
    case "closed":
      return "closed";
    case "aborted":
      return "aborted";
    default:
      return "client_stop";
  }
}

/** The start reason of a track (falls back to `reload` / `mic_check` when there is no specific one). */
export function startReasonFor(v: PlayerView | null, next: AudioStartReason | null): AudioStartReason {
  return next ?? (atMicCheck(v) ? "mic_check" : "reload");
}

const START_REASONS: ReadonlySet<string> = new Set(AUDIO_START_REASONS);
const STOP_REASONS: ReadonlySet<string> = new Set(AUDIO_STOP_REASONS);

/** A reason the server accepts: the engine's own reasons are mapped onto the documented ones. */
export function wireStopReason(reason: string): AudioStopReason {
  if (STOP_REASONS.has(reason)) return reason as AudioStopReason;
  return reason === "dispose" || reason === "stop" ? "client_stop" : "error";
}
export function wireStartReason(reason: string): AudioStartReason {
  return START_REASONS.has(reason) ? (reason as AudioStartReason) : "reload";
}

/**
 * What the recording indicator shows (null = the session records no audio). The facilitator's
 * pause and a skipped mic check win over the engine; then the engine's own state.
 */
export function recStateFor(
  v: PlayerView | null,
  s: Pick<RecordingSnapshot, "status" | "gesture">,
): RecState | null {
  if (!v?.audio.enabled) return null;
  const a = v.audio;
  if (a.micCheck === "skipped") return "skipped";
  if (!a.record) return a.paused ? "paused" : "off";
  switch (s.status.state) {
    case "recording":
      return "recording";
    case "paused":
      return "paused";
    case "no_signal":
      return "no_signal";
    case "denied":
      return "denied";
    case "error":
      return "error";
    case "requesting":
      return "requesting";
    default:
      // idle: waiting for the mic check's Start click, or about to start
      return atMicCheck(v) && !s.gesture ? "off" : "requesting";
  }
}

/** The engine waits for a click (after a reload, or the system suspended audio). */
export function needsClick(v: PlayerView | null, s: Pick<RecordingSnapshot, "status">): boolean {
  return wantsRecording(v) && s.status.needsGesture;
}

/** A track was recorded for the seat in this tab (survives a reload: sessionStorage, a flag only). */
const TRACKED_KEY = "wkwa.audio.tracked";
function trackedBefore(): boolean {
  try {
    return sessionStorage.getItem(TRACKED_KEY) === "1";
  } catch {
    return false;
  }
}
/** A new session on this seat: its first capture is the mic check again. */
export function forgetTracked() {
  setTrackedBefore(false);
}
function setTrackedBefore(v: boolean) {
  try {
    if (v) sessionStorage.setItem(TRACKED_KEY, "1");
    else sessionStorage.removeItem(TRACKED_KEY);
  } catch {}
}

const round1 = (db: number) => Math.round(clampDb(db) * 10) / 10;

/* ─────────────────────────── controller ─────────────────────────── */

export class RecordingController {
  readonly store = new Store<RecordingSnapshot>({
    status: IDLE_STATUS,
    level: null,
    gesture: false,
    failed: false,
    contextSampleRate: null,
    pendingChunks: 0,
    droppedChunks: 0,
  });
  private rec: RecorderLike | null = null;
  private unwatch: (() => void) | null = null;
  private view: PlayerView | null = null;
  /** capture was asked for (start) and not stopped since */
  private running = false;
  private gesture = false;
  private failed = false;
  /** a track has started in this page (for the reason of the next start) */
  private everTracked = false;
  private nextReason: AudioStartReason | null = null;
  private reconnectPending = false;
  private connectedOnce = false;
  private clearWhenIdle = false;
  private syncing = false;
  private dirty = false;
  /** last mic_permission state reported in this attempt (dedupes) */
  private reported: string | null = null;
  /** chunks dropped so far when each track began / ended (droppedChunks of audio:stop) */
  private dropMarks = new Map<string, { from: number; to: number | null }>();
  private lastTrack: string | null = null;
  private lastState: RecorderState = "idle";

  constructor(private readonly deps: RecordingDeps) {}

  get snapshot(): RecordingSnapshot {
    return this.store.get();
  }

  /** Every new PlayerView (null when the seat was unbound). */
  update(v: PlayerView | null) {
    this.view = v;
    if (!this.rec && !v?.audio.enabled) return;
    this.kick();
  }

  /** The socket connected; after the first time, the next state push resyncs the recorder. */
  onConnect() {
    if (this.connectedOnce) this.reconnectPending = true;
    this.connectedOnce = true;
  }

  /** The seat was unbound: stop, drop everything not yet sent, and forget the mic check click. */
  onUnbound() {
    this.view = null;
    this.gesture = false;
    this.everTracked = false;
    this.nextReason = null;
    this.failed = false;
    this.reconnectPending = false;
    this.clearWhenIdle = true;
    setTrackedBefore(false);
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
    this.gesture = true;
    if (this.failed) {
      this.failed = false;
      if (this.everTracked) this.nextReason ??= "permission_regained";
    }
    if (!this.running && wantsRecording(this.view)) this.begin();
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
  get captureSettings(): AudioCaptureSettings {
    return this.rec?.captureSettings ?? {};
  }

  /* ─── internals ─── */

  private ensure(): RecorderLike | null {
    if (this.rec) return this.rec;
    this.rec = this.deps.createRecorder({
      now: () => this.deps.now(),
      clockOffsetMs: () => this.deps.clockOffsetMs(),
      sendStart: (info) => this.sendStart(info),
      sendChunk: (chunk) => this.sendChunk(chunk),
      sendStop: (info) => this.sendStop(info),
      onLevel: (l) => this.onLevel(l),
      onState: (_s, status) => this.onState(status),
    });
    this.unwatch = this.deps.watchDevices?.(() => this.onDeviceChange()) ?? null;
    return this.rec;
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

  private async syncOnce() {
    const v = this.view;
    const rec = this.rec ?? (v?.audio.enabled ? this.ensure() : null);
    if (!rec) return;
    const want = wantsRecording(v);
    if (this.reconnectPending && v) {
      this.reconnectPending = false;
      // resend what was not acknowledged (oldest first), then close the old track and open a new one
      rec.onReconnect();
      if (this.running) {
        this.running = false;
        const reason = want ? "disconnect" : stopReasonFor(v);
        this.nextReason = want ? "reconnect" : reason === "paused" ? "resume" : null;
        await rec.stop(reason);
        this.reportDrained();
        this.publish();
      }
    }
    if (want && !this.running) {
      if (this.failed) return;
      if (atMicCheck(v) && !this.gesture) return; // the Start button
      this.begin();
    } else if (!want && this.running) {
      this.running = false;
      const reason = stopReasonFor(v);
      if (reason === "paused") this.nextReason = "resume";
      await rec.stop(reason);
      this.reportDrained();
      this.publish();
    }
    if (!v && !this.running && this.clearWhenIdle) {
      this.clearWhenIdle = false;
      rec.clearPending();
      this.dropMarks.clear();
      this.publish();
    }
  }

  private begin() {
    const rec = this.rec;
    if (!rec) return;
    let reason = startReasonFor(this.view, this.nextReason);
    // the page was reloaded after this seat had already recorded (at the mic check): not its first capture
    if (reason === "mic_check" && trackedBefore()) reason = "reload";
    this.running = true;
    this.failed = false;
    this.nextReason = null;
    this.reported = null;
    void this.deps
      .queryPermission?.()
      .then((p) => {
        if (p === "prompt" && this.reported === null) this.report("prompt");
      })
      .catch(() => {});
    void rec.start(reason).catch((err) => {
      console.error(err);
      this.running = false;
    });
  }

  private onDeviceChange() {
    // a microphone came back (plugged in, or the permission was granted again): try once more
    if (!this.failed || !wantsRecording(this.view)) return;
    if (atMicCheck(this.view) && !this.gesture) return;
    this.failed = false;
    if (this.everTracked) this.nextReason ??= "permission_regained";
    this.publish();
    this.kick();
  }

  private onState(status: RecorderStatus) {
    const prev = this.lastState;
    this.lastState = status.state;
    // track bookkeeping (droppedChunks per track)
    if (status.trackId !== this.lastTrack) {
      const rec = this.rec;
      const dropped = rec?.droppedChunks ?? 0;
      if (this.lastTrack) {
        const m = this.dropMarks.get(this.lastTrack);
        if (m && m.to === null) m.to = dropped;
      }
      if (status.trackId) {
        this.dropMarks.set(status.trackId, { from: dropped, to: null });
        this.everTracked = true;
        setTrackedBefore(true);
      }
      this.lastTrack = status.trackId;
    }
    if (status.state === "denied" || status.state === "error") {
      if (this.running) {
        this.running = false;
        this.failed = true;
        if (this.everTracked) this.nextReason = "permission_regained";
      }
      this.report(status.state, status.error?.name);
      if (prev !== status.state) this.reportDrained();
    } else if (status.state === "recording" || status.state === "no_signal" || status.state === "paused") {
      this.report("granted");
    }
    this.publish(status);
    if (prev !== status.state) this.sendLevel(null);
  }

  private report(state: "granted" | "denied" | "error" | "prompt", errorName?: string) {
    if (this.reported === state) return;
    this.reported = state;
    const name = errorName && /^[A-Za-z]{1,64}$/.test(errorName) ? errorName : undefined;
    this.deps.permission(name ? { state, errorName: name } : { state });
  }

  private onLevel(level: MicLevel) {
    this.store.set((s) => ({
      ...s,
      level,
      pendingChunks: this.rec?.pendingChunks ?? 0,
      droppedChunks: this.rec?.droppedChunks ?? 0,
    }));
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
    const rec = this.rec;
    const st = status ?? rec?.status ?? IDLE_STATUS;
    const capturing = st.state === "recording" || st.state === "no_signal" || st.state === "paused";
    this.store.set((s) => ({
      ...s,
      status: st,
      level: capturing ? s.level : null,
      gesture: this.gesture,
      failed: this.failed,
      pendingChunks: rec?.pendingChunks ?? 0,
      droppedChunks: rec?.droppedChunks ?? 0,
    }));
  }

  private async sendStart(info: AudioStartInfo): Promise<SendResult> {
    this.store.set((s) => ({ ...s, contextSampleRate: info.context.sampleRate }));
    const ack = await this.deps.send("audio:start", { ...info, reason: wireStartReason(info.reason) });
    return audioSendResult(ack);
  }

  private async sendChunk(chunk: AudioChunk): Promise<SendResult> {
    return audioSendResult(await this.deps.send("audio:chunk", chunk));
  }

  private async sendStop(info: AudioStopInfo): Promise<SendResult> {
    const m = this.dropMarks.get(info.trackId);
    const dropped = m ? Math.max(0, (m.to ?? this.rec?.droppedChunks ?? m.from) - m.from) : 0;
    const ack = await this.deps.send("audio:stop", {
      ...info,
      reason: wireStopReason(info.reason),
      droppedChunks: Math.min(dropped, info.chunks),
    });
    const r = audioSendResult(ack);
    if (r !== false) this.dropMarks.delete(info.trackId);
    return r;
  }

  dispose() {
    this.unwatch?.();
    this.unwatch = null;
  }
}
