import {
  AUDIO_CHUNK_SECONDS,
  AUDIO_LEVEL_INTERVAL_MS,
  AUDIO_MAX_CHUNK_SECONDS,
  AUDIO_MAX_PENDING_SECONDS,
  AUDIO_SAMPLE_RATE,
  type AudioStartReason,
  type AudioStopReason,
  EngineCaptureSettingsSchema,
} from "@wkwa/shared";
import type { ChunkDraft } from "./chunker";
import { classifyMicError, MicError, type MicErrorInfo, micSupportProblem } from "./errors";
import { LevelMeter } from "./levels";
import { TrackPipeline } from "./pipeline";
import { SendQueue } from "./queue";
import { ClockMapper, roundTs, type TimingSample } from "./timing";
import {
  type AudioChunk,
  type AudioStartInfo,
  type AudioStopInfo,
  type EngineCaptureSettings,
  MIC_CONSTRAINTS,
  type MicLevel,
  type RecorderState,
  type SendResult,
} from "./types";
import { batchFramesFor, CAPTURE_PROCESSOR, loadCaptureWorklet } from "./worklet";

/** Everything the UI needs to show the recorder. */
export interface RecorderStatus {
  state: RecorderState;
  /** the track being recorded, null between tracks */
  trackId: string | null;
  /** set in the "denied" and "error" states */
  error: MicErrorInfo | null;
  /** the AudioContext is waiting for a user gesture: call resume() from a click */
  needsGesture: boolean;
  /** the browser or the OS reports the microphone as muted */
  muted: boolean;
}

/** Browser I/O used by the recorder; every member can be replaced (tests, other hosts). */
export interface RecorderEnv {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  createContext(): AudioContext;
  createNode(ctx: AudioContext, name: string, options: AudioWorkletNodeOptions): AudioWorkletNode;
  loadWorklet(ctx: AudioContext): Promise<void>;
  /** performance.now() */
  perfNow(): number;
  randomUUID(): string;
  /** "insecure" / "unsupported" when this page cannot record at all */
  support(): "insecure" | "unsupported" | null;
  /** the microphone permission state, null when it cannot be queried */
  permission(): Promise<PermissionState | null>;
}

export interface MicRecorderOptions {
  /** server-epoch time in ms (ClockSync.now()) */
  now(): number;
  /** the ClockSync offset in use (ms) */
  clockOffsetMs(): number;
  /** delivers a track start; resolve true when acked (undefined counts as delivered) */
  sendStart(info: AudioStartInfo, signal?: AbortSignal): Promise<SendResult> | SendResult | undefined;
  /** delivers a chunk; resolve true when acked, false to retry, "rejected" to drop */
  sendChunk(chunk: AudioChunk, signal?: AbortSignal): Promise<SendResult>;
  /** delivers a track stop; resolve true when acked (undefined counts as delivered) */
  sendStop(info: AudioStopInfo, signal?: AbortSignal): Promise<SendResult> | SendResult | undefined;
  // signal (all three): the send queue gave up on this attempt — see SendQueueOptions.deliver
  /** ~4 Hz level of the input, for meters and the volatile audio:level message (never stored) */
  onLevel?(level: MicLevel): void;
  /** every change of state, track, error, needsGesture or muted */
  onState?(state: RecorderState, status: RecorderStatus): void;
  /** default 5 s; at most 6 s (AUDIO_MAX_CHUNK_SECONDS: the server refuses longer chunks) */
  chunkSeconds?: number;
  /** unacked audio kept in memory before the oldest chunks are dropped; default AUDIO_MAX_PENDING_SECONDS */
  maxPendingSeconds?: number;
  /** level window; default AUDIO_LEVEL_INTERVAL_MS */
  levelIntervalMs?: number;
  /** digital silence this long counts as no signal; default 3000 ms */
  noSignalMs?: number;
  /** delivery back-off; default 1 s, 2 s, 5 s, 10 s, 30 s */
  retryDelaysMs?: readonly number[];
  /** a delivery not settled after this long is retried; default 30 s */
  ackTimeoutMs?: number;
  env?: Partial<RecorderEnv>;
}

type Outgoing =
  | { kind: "start"; info: AudioStartInfo }
  | { kind: "chunk"; chunk: AudioChunk }
  | { kind: "stop"; info: AudioStopInfo };

interface Capture {
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  node: AudioWorkletNode;
  /** resolves the wait for the worklet's final flush */
  onClosed: (() => void) | null;
  detach(): void;
}

interface ActiveTrack {
  trackId: string;
  /** context frame of the first sample */
  startFrame: number;
  /** context frame the next block must start at */
  nextFrame: number;
  inputRate: number;
  inputLatencyMs: number;
  mapper: ClockMapper;
  pipeline: TrackPipeline;
  /** the queue's dropped count when the track began (its stop reports what was dropped since) */
  droppedAtStart: number;
}

interface Split {
  /** first context frame rendered after the suspension */
  frame: number;
  reason: AudioStopReason;
  timer: ReturnType<typeof setTimeout>;
}

/** Peak at or below this is digital silence (≈ one 16-bit step). */
const SILENCE_PEAK_DB = -85;
/** A suspended context's partial chunk is sent after this grace period. */
const SUSPEND_GRACE_MS = 300;
/** stop() waits this long for the worklet's last batch. */
const DRAIN_MS = 500;
/**
 * A forward gap in the worklet's frames up to this long is filled with silence, and an overlap this long
 * is dropped; anything larger starts a new track.
 */
const MAX_FILLED_GAP_S = 1;
/** …and this long when the context is not running (the worklet may not answer). */
const DRAIN_SUSPENDED_MS = 150;

function browserEnv(): RecorderEnv {
  return {
    getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
    createContext: () => new AudioContext(),
    createNode: (ctx, name, options) => new AudioWorkletNode(ctx, name, options),
    loadWorklet: (ctx) => loadCaptureWorklet(ctx),
    perfNow: () => performance.now(),
    randomUUID: () => crypto.randomUUID(),
    support: () => micSupportProblem(),
    permission: async () => {
      try {
        return (await navigator.permissions.query({ name: "microphone" as PermissionName })).state;
      } catch {
        return null;
      }
    },
  };
}

/** Copies only the processing settings: never deviceId, groupId or label. */
export function pickSettings(s: MediaTrackSettings): EngineCaptureSettings {
  return EngineCaptureSettingsSchema.safeParse(s).data ?? {};
}

function stopStream(stream: MediaStream) {
  for (const t of stream.getTracks()) {
    try {
      t.stop();
    } catch {}
  }
}

async function settleWithin(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    p.then(
      () => {},
      () => {},
    ),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]);
  clearTimeout(timer);
}

const msOrNull = (s: number | undefined): number | null =>
  typeof s === "number" && Number.isFinite(s) ? Math.round(s * 100_000) / 100 : null;

function safe(fn: () => void) {
  try {
    fn();
  } catch (err) {
    console.error(err);
  }
}

/**
 * Records the microphone as 16 kHz mono s16le chunks and hands them to the
 * injected senders, in order, keeping unacked chunks in memory only.
 *
 * Signal path: getUserMedia (raw: no echo cancellation, noise suppression or
 * automatic gain) → MediaStreamAudioSourceNode → capture AudioWorklet at the
 * context's native rate → main thread: resampler (anti-aliased) → Int16
 * chunks → SendQueue. See timing.ts for how clientTs is derived.
 *
 * Tracks: one continuous capture run, with a random UUID. start() → stop()
 * is one track; the recorder also ends a track and starts a new one by itself
 * when the AudioContext was suspended or interrupted, or the audio clock
 * jumped, because the sample timeline no longer matches real time. A
 * microphone that ends (unplugged, permission revoked) ends the track and
 * leaves the recorder in "error" or "denied"; start() again to retry.
 *
 * Safari only runs an AudioContext resumed inside a user gesture: call
 * prepare() (or start()) synchronously from a click, and resume() from a
 * click when status.needsGesture is true.
 */
export class MicRecorder {
  private readonly o: MicRecorderOptions;
  private readonly env: RecorderEnv;
  private readonly queue: SendQueue<Outgoing>;
  private readonly chunkSamples: number;
  private readonly noSignalMs: number;
  private readonly level: LevelMeter;
  private readonly taps = new Set<(samples: Float32Array) => void>();
  private ctx: AudioContext | null = null;
  private detachCtx: (() => void) | null = null;
  private capture: Capture | null = null;
  private track: ActiveTrack | null = null;
  private split: Split | null = null;
  /** recording is wanted (between start() and stop()) */
  private wanted = false;
  private startReason: AudioStartReason = "reload";
  private nextReason: AudioStartReason | null = null;
  /** bumped by every start() and stop(): a stale operation stops at its next await */
  private gen = 0;
  private starting: { gen: number; promise: Promise<RecorderState> } | null = null;
  private stopping: Promise<void> | null = null;
  private _state: RecorderState = "idle";
  private error: MicErrorInfo | null = null;
  private muted = false;
  private silentMs = 0;
  private settings: EngineCaptureSettings = {};
  private statusKey = "";
  private disposed = false;
  /** frames that arrived for a track that had already been closed */
  lateFrames = 0;
  /** frames the worklet skipped inside a track, recorded as silence */
  gapFrames = 0;
  /** frames the worklet delivered twice inside a track (the repeat is dropped) */
  overlapFrames = 0;

  constructor(options: MicRecorderOptions) {
    this.o = options;
    this.env = { ...browserEnv(), ...options.env };
    const chunkSeconds = options.chunkSeconds ?? AUDIO_CHUNK_SECONDS;
    if (!(chunkSeconds > 0 && chunkSeconds <= AUDIO_MAX_CHUNK_SECONDS)) {
      throw new RangeError(`MicRecorder: chunkSeconds must be in (0, ${AUDIO_MAX_CHUNK_SECONDS}]`);
    }
    this.chunkSamples = Math.round(chunkSeconds * AUDIO_SAMPLE_RATE);
    if (this.chunkSamples < 1) throw new RangeError("MicRecorder: chunkSeconds is too small");
    this.noSignalMs = options.noSignalMs ?? 3000;
    const maxPendingSeconds = options.maxPendingSeconds ?? AUDIO_MAX_PENDING_SECONDS;
    this.queue = new SendQueue<Outgoing>({
      deliver: (m, signal) =>
        m.kind === "chunk"
          ? this.o.sendChunk(m.chunk, signal)
          : m.kind === "start"
            ? this.o.sendStart(m.info, signal)
            : this.o.sendStop(m.info, signal),
      size: (m) =>
        m.kind === "chunk"
          ? { samples: m.chunk.sampleCount, bytes: m.chunk.pcm.byteLength }
          : { samples: 0, bytes: 0 },
      maxPendingSamples: Math.max(this.chunkSamples, Math.round(maxPendingSeconds * AUDIO_SAMPLE_RATE)),
      retryDelaysMs: options.retryDelaysMs,
      ackTimeoutMs: options.ackTimeoutMs,
    });
    this.level = new LevelMeter({
      sampleRate: AUDIO_SAMPLE_RATE,
      intervalMs: options.levelIntervalMs ?? AUDIO_LEVEL_INTERVAL_MS,
      onLevel: (l, ms) => this.onLevelWindow(l, ms),
    });
  }

  // ── getters ────────────────────────────────────────────────────────────

  get state(): RecorderState {
    return this._state;
  }

  get status(): RecorderStatus {
    return {
      state: this._state,
      trackId: this.trackId,
      error: this.error,
      needsGesture: this.needsGesture,
      muted: this.muted,
    };
  }

  /** The track being recorded, null between tracks. */
  get trackId(): string | null {
    return this.track?.trackId ?? null;
  }

  /** Chunks not yet acknowledged (in memory). */
  get pendingChunks(): number {
    return this.queue.pendingChunks;
  }

  /** PCM bytes not yet acknowledged. */
  get pendingBytes(): number {
    return this.queue.pendingBytes;
  }

  /** Chunks dropped because more than maxPendingSeconds were waiting. */
  get droppedChunks(): number {
    return this.queue.dropped;
  }

  /** The AudioContext waits for a user gesture: call resume() from a click. */
  get needsGesture(): boolean {
    const c = this.ctx;
    return !!c && this.wanted && c.state !== "running" && c.state !== "closed";
  }

  /** What the browser applied to the current microphone (whitelisted, no device identifiers). */
  get captureSettings(): EngineCaptureSettings {
    return { ...this.settings };
  }

  // ── control ────────────────────────────────────────────────────────────

  /**
   * Creates the AudioContext and asks it to run. Call it synchronously from a
   * click (Safari only lets a context start inside a user gesture). Also
   * preloads the capture worklet. Returns false when no context can be made.
   */
  prepare(): boolean {
    if (this.disposed) return false;
    let ctx: AudioContext;
    try {
      ctx = this.ensureContext();
    } catch {
      return false;
    }
    if (ctx.state !== "running") ctx.resume().catch(() => {});
    this.env.loadWorklet(ctx).catch(() => {});
    return true;
  }

  /** Resumes a suspended AudioContext (call from a click); true when it runs. */
  async resume(): Promise<boolean> {
    if (this.disposed) return false;
    let ctx: AudioContext;
    try {
      ctx = this.ensureContext();
    } catch {
      return false;
    }
    if (ctx.state !== "running") await settleWithin(ctx.resume(), 2000);
    this.refresh();
    return ctx.state === "running";
  }

  /**
   * Starts recording: asks for the microphone (permission prompt if needed),
   * connects the capture graph and resumes the AudioContext. Resolves with the
   * resulting state ("recording", "paused" when a click is needed, "denied" or
   * "error"); it never rejects for microphone problems. A no-op while recording.
   */
  start(reason: AudioStartReason = "reload"): Promise<RecorderState> {
    if (this.disposed) return Promise.reject(new Error("MicRecorder: disposed"));
    // synchronously, so that a start() from a click resumes the context in the gesture
    // (also when it is already recording but paused)
    this.prepare();
    if (this.starting && this.starting.gen === this.gen) return this.starting.promise;
    if (this.wanted && this.capture && !this.stopping) return Promise.resolve(this._state);
    const gen = ++this.gen;
    const stopping = this.stopping;
    const promise = (async () => {
      if (stopping) await stopping;
      if (gen !== this.gen) return this._state;
      return this.doStart(gen, reason);
    })();
    this.starting = { gen, promise };
    promise
      .finally(() => {
        if (this.starting?.promise === promise) this.starting = null;
      })
      .catch(() => {});
    return promise;
  }

  /** Stops recording: flushes the partial last chunk, ends the track and releases the microphone. */
  stop(reason: AudioStopReason = "client_stop"): Promise<void> {
    if (this.stopping) {
      // cancels a start() queued behind the running stop
      ++this.gen;
      this.wanted = false;
      return this.stopping;
    }
    const p = this.doStop(reason).finally(() => {
      if (this.stopping === p) this.stopping = null;
    });
    this.stopping = p;
    return p;
  }

  /** Call after the connection came back: resends the pending chunks in order, now. */
  onReconnect() {
    this.queue.retryNow();
  }

  /** Drops every pending (unsent) item, e.g. when the seat is unbound; returns the chunks discarded. */
  clearPending(): number {
    // the current track's start marker goes too: end the track, and the next block starts a new one
    const recording = this.track !== null;
    this.endTrack("cleared");
    const n = this.queue.clear();
    if (recording) this.nextReason = "cleared";
    return n;
  }

  /** Resolves when everything recorded so far has been acknowledged. */
  whenSent(): Promise<void> {
    return this.queue.drained();
  }

  /** Receives every 16 kHz float block (e.g. for a SpeechDetector); returns an unsubscribe function. */
  addTap(fn: (samples: Float32Array) => void): () => void {
    this.taps.add(fn);
    return () => this.taps.delete(fn);
  }

  /** Stops recording, drops pending audio and closes the AudioContext. The recorder cannot be reused. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.stop("client_stop");
    this.queue.dispose();
    this.taps.clear();
    const ctx = this.ctx;
    this.ctx = null;
    this.detachCtx?.();
    this.detachCtx = null;
    if (ctx && ctx.state !== "closed") await ctx.close().catch(() => {});
  }

  // ── start / stop ───────────────────────────────────────────────────────

  private async doStart(gen: number, reason: AudioStartReason): Promise<RecorderState> {
    this.wanted = true;
    this.startReason = reason;
    this.nextReason = reason;
    this.error = null;
    this.setState("requesting");
    const problem = this.env.support();
    if (problem) return this.fail(gen, new MicError(problem));
    const ctx = this.ctx;
    if (!ctx) return this.fail(gen, new MicError("unsupported", "AudioContext could not be created"));
    let stream: MediaStream;
    try {
      stream = await this.env.getUserMedia(MIC_CONSTRAINTS);
    } catch (err) {
      return this.fail(gen, err);
    }
    if (gen !== this.gen || this.ctx !== ctx || ctx.state === "closed") {
      stopStream(stream);
      return gen === this.gen ? this.fail(gen, new MicError("unknown", "AudioContext closed")) : this._state;
    }
    try {
      await this.env.loadWorklet(ctx);
    } catch (err) {
      stopStream(stream);
      return this.fail(gen, new MicError("unsupported", `AudioWorklet could not be loaded: ${String(err)}`));
    }
    if (gen !== this.gen) {
      stopStream(stream);
      return this._state;
    }
    try {
      this.capture = this.connect(ctx, stream);
    } catch (err) {
      stopStream(stream);
      return this.fail(gen, err);
    }
    if (ctx.state !== "running") await settleWithin(ctx.resume(), 1500);
    if (gen !== this.gen) return this._state;
    this.refresh();
    return this._state;
  }

  private fail(gen: number, err: unknown): RecorderState {
    if (gen !== this.gen) return this._state;
    const info = classifyMicError(err);
    this.wanted = false;
    this.endTrack("error");
    this.release();
    this.clearSplit();
    this.error = info;
    this.setState(info.kind === "denied" ? "denied" : "error");
    return this._state;
  }

  private async doStop(reason: AudioStopReason) {
    ++this.gen;
    this.wanted = false;
    const cap = this.capture;
    if (cap) await this.drain(cap, this.ctx?.state === "running" ? DRAIN_MS : DRAIN_SUSPENDED_MS);
    this.endTrack(reason);
    this.release();
    this.clearSplit();
    this.error = null;
    this.setState("idle");
  }

  /** Asks the worklet for its partial batch and waits for it (bounded). */
  private drain(cap: Capture, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        cap.onClosed = null;
        resolve();
      };
      const timer = setTimeout(done, ms);
      cap.onClosed = done;
      try {
        cap.node.port.postMessage({ type: "close" });
      } catch {
        done();
      }
    });
  }

  private ensureContext(): AudioContext {
    if (this.ctx && this.ctx.state !== "closed") return this.ctx;
    this.detachCtx?.();
    const ctx = this.env.createContext();
    const onState = () => this.onContextState(ctx);
    ctx.addEventListener("statechange", onState);
    this.detachCtx = () => ctx.removeEventListener("statechange", onState);
    this.ctx = ctx;
    return ctx;
  }

  private connect(ctx: AudioContext, stream: MediaStream): Capture {
    const track = stream.getAudioTracks()[0];
    if (!track) throw new MicError("not_found", "The stream has no audio track");
    const source = ctx.createMediaStreamSource(stream);
    let node: AudioWorkletNode;
    try {
      node = this.env.createNode(ctx, CAPTURE_PROCESSOR, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: "explicit",
        channelInterpretation: "speakers",
        processorOptions: { batchFrames: batchFramesFor(ctx.sampleRate) },
      });
    } catch (err) {
      source.disconnect();
      throw err;
    }
    const onEnded = () => void this.onTrackEnded(cap);
    const onMute = () => this.onMuted(cap, true);
    const onUnmute = () => this.onMuted(cap, false);
    const cap: Capture = {
      stream,
      source,
      node,
      onClosed: null,
      detach: () => {
        track.removeEventListener("ended", onEnded);
        track.removeEventListener("mute", onMute);
        track.removeEventListener("unmute", onUnmute);
      },
    };
    node.port.onmessage = (e: MessageEvent) => this.onMessage(cap, e.data);
    track.addEventListener("ended", onEnded);
    track.addEventListener("mute", onMute);
    track.addEventListener("unmute", onUnmute);
    source.connect(node);
    // silent output; connected so every browser keeps calling process()
    node.connect(ctx.destination);
    this.settings = pickSettings(track.getSettings());
    this.muted = track.muted;
    this.silentMs = 0;
    return cap;
  }

  /** Disconnects the graph and stops the microphone (the browser's recording indicator goes off). */
  private release() {
    const cap = this.capture;
    if (!cap) return;
    this.capture = null;
    cap.detach();
    try {
      cap.node.port.postMessage({ type: "close" });
    } catch {}
    cap.node.port.onmessage = null;
    try {
      cap.source.disconnect();
    } catch {}
    try {
      cap.node.disconnect();
    } catch {}
    stopStream(cap.stream);
    cap.onClosed?.();
    this.muted = false;
    this.silentMs = 0;
    this.level.reset();
  }

  private clearSplit() {
    if (this.split) clearTimeout(this.split.timer);
    this.split = null;
  }

  // ── events ─────────────────────────────────────────────────────────────

  private onMessage(cap: Capture, data: unknown) {
    if (cap !== this.capture) return;
    const m = (data ?? {}) as { type?: unknown; frame?: unknown; samples?: unknown };
    if (m.type === "closed") {
      cap.onClosed?.();
      return;
    }
    if (m.type === "pcm" && typeof m.frame === "number" && m.samples instanceof Float32Array) {
      this.onBlock(m.frame, m.samples);
    }
  }

  private onBlock(frame: number, samples: Float32Array) {
    const ctx = this.ctx;
    if (!ctx) return;
    const sample = this.timingSample(ctx);
    let f = frame;
    let block = samples;
    const split = this.split;
    if (split) {
      // frames rendered before the suspension still belong to the old track
      const before = Math.min(block.length, Math.max(0, split.frame - f));
      if (before > 0) {
        this.append(f, block.subarray(0, before));
        f += before;
        block = block.subarray(before);
        if (block.length === 0) return;
      }
      // the rest was rendered after the context resumed: a new track
      this.clearSplit();
      this.endTrack(split.reason);
      this.nextReason = "context_resumed";
    }
    const t = this.track;
    const gap = t ? f - t.nextFrame : 0;
    if (t && gap < 0 && -gap <= t.inputRate * MAX_FILLED_GAP_S) {
      // frames this track already has (Chromium can run a new node's first quantum twice): keep the first copy
      const dup = Math.min(-gap, block.length);
      this.overlapFrames += dup;
      if (dup === block.length) return;
      block = block.subarray(dup);
      f += dup;
    } else if (t && gap > 0 && gap <= t.inputRate * MAX_FILLED_GAP_S) {
      // render quanta the worklet was not called for (seen right after a node starts):
      // the frame indices are exact context time, so silence keeps the timeline exact
      this.gapFrames += gap;
      this.append(t.nextFrame, new Float32Array(gap));
    }
    if (t && t.nextFrame !== f) {
      this.endTrack("discontinuity");
      this.nextReason = "discontinuity";
    } else if (t && !t.mapper.observe(sample)) {
      this.endTrack("clock_jump");
      this.nextReason = "clock_jump";
    }
    if (!this.track) {
      if (!this.wanted) {
        this.lateFrames += block.length;
        return;
      }
      this.beginTrack(f, sample);
    }
    this.append(f, block);
  }

  private append(frame: number, block: Float32Array) {
    const t = this.track;
    if (!t || t.nextFrame !== frame) {
      this.lateFrames += block.length;
      return;
    }
    t.nextFrame = frame + block.length;
    t.pipeline.push(block);
  }

  private onContextState(ctx: AudioContext) {
    if (ctx !== this.ctx) return;
    const st = ctx.state as string;
    if (st === "running") {
      this.refresh();
      return;
    }
    if (st === "closed") {
      // closed by the browser (dispose() detaches this listener first): the recorder fails, so the
      // track stops with `error` (as fail() would stop it)
      const gen = this.gen;
      this.endTrack("error");
      this.release();
      this.clearSplit();
      this.ctx = null;
      this.detachCtx?.();
      this.detachCtx = null;
      if (this.wanted) this.fail(gen, new MicError("unknown", "The AudioContext was closed"));
      else this.emitStatus();
      return;
    }
    if (this.capture && this.track && !this.split) {
      const reason: AudioStopReason = st === "interrupted" ? "context_interrupted" : "context_suspended";
      // currentTime stops at the suspension: later frames were rendered after the resume
      const split: Split = {
        frame: Math.round(ctx.currentTime * ctx.sampleRate),
        reason,
        timer: setTimeout(() => {
          // still suspended: close the track so its partial chunk is sent now
          if (this.split === split && this.ctx?.state !== "running") this.endTrack(reason);
        }, SUSPEND_GRACE_MS),
      };
      this.split = split;
      // ask for the batch still buffered in the worklet, so it lands in this track before the grace ends
      try {
        this.capture.node.port.postMessage({ type: "flush" });
      } catch {}
    }
    this.refresh();
  }

  private async onTrackEnded(cap: Capture) {
    if (cap !== this.capture) return;
    const gen = this.gen;
    this.wanted = false;
    this.endTrack("track_ended");
    this.release();
    this.clearSplit();
    this.error = classifyMicError(new MicError("ended"));
    this.setState("error");
    // a revoked permission also ends the track: report it as denied
    const perm = await this.env.permission().catch(() => null);
    if (gen !== this.gen || perm !== "denied") return;
    this.error = classifyMicError({ name: "NotAllowedError", message: "Permission revoked" });
    this.setState("denied");
  }

  private onMuted(cap: Capture, muted: boolean) {
    if (cap !== this.capture) return;
    this.muted = muted;
    this.refresh();
  }

  // ── tracks ─────────────────────────────────────────────────────────────

  private epochMinusPerf(): number {
    return this.o.now() - this.env.perfNow();
  }

  private timingSample(ctx: AudioContext): TimingSample {
    // currentTime before performance.now(): keeps the current-time error one-sided
    const currentTime = ctx.currentTime;
    const s: TimingSample = {
      currentTime,
      perfNow: this.env.perfNow(),
      baseLatency: ctx.baseLatency,
      outputLatency: ctx.outputLatency,
    };
    if (typeof ctx.getOutputTimestamp === "function") {
      try {
        const ts = ctx.getOutputTimestamp();
        s.contextTime = ts.contextTime;
        s.performanceTime = ts.performanceTime;
      } catch {}
    }
    return s;
  }

  private beginTrack(frame: number, sample: TimingSample) {
    const ctx = this.ctx!;
    const inputRate = ctx.sampleRate;
    const mapper = new ClockMapper(inputRate);
    mapper.observe(sample);
    const inputLatencyMs = typeof this.settings.latency === "number" ? this.settings.latency * 1000 : 0;
    const trackId = this.env.randomUUID();
    const pipeline = new TrackPipeline({
      inputRate,
      chunkSamples: this.chunkSamples,
      onChunk: (d) => this.onChunk(track, d),
      onOutput: (s) => this.onOutput(s),
    });
    const track: ActiveTrack = {
      trackId,
      startFrame: frame,
      nextFrame: frame,
      inputRate,
      inputLatencyMs,
      mapper,
      pipeline,
      droppedAtStart: this.queue.dropped,
    };
    this.track = track;
    const info: AudioStartInfo = {
      trackId,
      reason: this.nextReason ?? this.startReason,
      sampleRate: AUDIO_SAMPLE_RATE,
      chunkSamples: this.chunkSamples,
      clientTs: roundTs(mapper.captureEpochMs(frame, inputLatencyMs, this.epochMinusPerf())),
      clockOffsetMs: this.o.clockOffsetMs(),
      inputLatencyMs,
      settings: { ...this.settings },
      context: {
        sampleRate: inputRate,
        baseLatencyMs: msOrNull(ctx.baseLatency),
        outputLatencyMs: msOrNull(ctx.outputLatency),
        timingMethod: mapper.method,
      },
    };
    this.nextReason = null;
    this.silentMs = 0;
    this.level.reset();
    this.queue.push({ kind: "start", info });
    this.emitStatus();
  }

  private onChunk(t: ActiveTrack, d: ChunkDraft) {
    const frame = t.startFrame + (d.startSample * t.inputRate) / AUDIO_SAMPLE_RATE;
    const chunk: AudioChunk = {
      trackId: t.trackId,
      seq: d.seq,
      startSample: d.startSample,
      sampleCount: d.sampleCount,
      clientTs: roundTs(t.mapper.captureEpochMs(frame, t.inputLatencyMs, this.epochMinusPerf())),
      clockOffsetMs: this.o.clockOffsetMs(),
      rmsDb: d.rmsDb,
      peakDb: d.peakDb,
      clippedSamples: d.clippedSamples,
      pcm: d.pcm,
    };
    this.queue.push({ kind: "chunk", chunk });
  }

  /** Ends the current track: flushes the resampler and the partial chunk, then queues the stop. */
  private endTrack(reason: AudioStopReason) {
    const t = this.track;
    if (!t) return;
    this.track = null;
    t.pipeline.finish();
    const samples = t.pipeline.outputSamples;
    const endFrame = t.startFrame + (samples * t.inputRate) / AUDIO_SAMPLE_RATE;
    this.queue.push({
      kind: "stop",
      info: {
        trackId: t.trackId,
        reason,
        chunks: t.pipeline.chunks,
        samples,
        droppedChunks: Math.min(this.queue.dropped - t.droppedAtStart, t.pipeline.chunks),
        clientTs: roundTs(t.mapper.captureEpochMs(endFrame, t.inputLatencyMs, this.epochMinusPerf())),
        clockOffsetMs: this.o.clockOffsetMs(),
      },
    });
    this.level.reset();
    this.emitStatus();
  }

  private onOutput(samples: Float32Array) {
    this.level.push(samples);
    for (const tap of this.taps) safe(() => tap(samples));
  }

  private onLevelWindow(level: MicLevel, windowMs: number) {
    this.silentMs = level.peakDb <= SILENCE_PEAK_DB ? this.silentMs + windowMs : 0;
    this.refresh();
    safe(() => this.o.onLevel?.(level));
  }

  // ── state ──────────────────────────────────────────────────────────────

  /** Derives the state while capturing: paused > no_signal > recording. */
  private refresh() {
    if (!this.capture || !this.wanted) {
      this.emitStatus();
      return;
    }
    const ctx = this.ctx;
    this.setState(
      ctx?.state !== "running"
        ? "paused"
        : this.muted || this.silentMs >= this.noSignalMs
          ? "no_signal"
          : "recording",
    );
  }

  private setState(s: RecorderState) {
    this._state = s;
    this.emitStatus();
  }

  private emitStatus() {
    const st = this.status;
    const key = `${st.state}|${st.trackId}|${st.error?.kind}|${st.needsGesture}|${st.muted}`;
    if (key === this.statusKey) return;
    this.statusKey = key;
    safe(() => this.o.onState?.(st.state, st));
  }
}
