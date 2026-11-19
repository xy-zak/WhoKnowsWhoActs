import type { NotRecordingReason, PlayerView } from "@wkwa/shared";
import { describe, expect, it } from "vitest";
import type { MicRecorderOptions, RecorderState, RecorderStatus } from "../src/audio";
import { type RecorderLike, RecordingController, recStateFor } from "../src/player/recording";
import {
  type Effect,
  INITIAL,
  type Input,
  type Machine,
  type Phase,
  step,
  stopReasonFor,
  wantsRecording,
} from "../src/player/recordingMachine";
import { flushPromises as settle } from "./helpers";

/* ─── fixtures ─── */

/**
 * A player view whose audio follows the server's verdict: `why` is its reason for not recording
 * (null = records), and the other audio fields agree with it.
 */
function view(
  o: {
    phase?: PlayerView["phase"];
    nextStep?: string | null;
    withdrawn?: boolean;
    why?: NotRecordingReason | null;
  } = {},
): PlayerView {
  const { phase = "onboarding", nextStep = "mic_check", withdrawn = false, why = null } = o;
  return {
    phase,
    me: { seat: 1, nextStep, withdrawn },
    audio: {
      enabled: why !== "audio_off",
      record: why === null,
      notRecording: why,
      paused: why === "paused",
      micCheck: why === "mic_check_skipped" ? "skipped" : "pending",
      micCheckHeld: why === "mic_check_held",
      calibration: {
        status: "pending",
        turnSeat: null,
        myTurn: false,
        sentence: null,
        turnEndsAt: null,
        order: [],
      },
    },
  } as unknown as PlayerView;
}

const IDLE: RecorderStatus = { state: "idle", trackId: null, error: null, needsGesture: false, muted: false };

const MIC_CHECK = view();
const BRIEFING = view({ nextStep: "briefing" });
const GAME = view({ phase: "round_active", nextStep: null });
const PAUSED = view({ phase: "round_active", nextStep: null, why: "paused" });
const COMPLETE = view({ phase: "game_complete", nextStep: null, why: "game_complete" });

/* ─── pure mapping ─── */

describe("recording: reasons and states", () => {
  it("stops with the stop reason of the server's verdict", () => {
    expect(stopReasonFor(null)).toBe("client_stop");
    expect(stopReasonFor(PAUSED)).toBe("paused");
    expect(stopReasonFor(view({ phase: "aborted", why: "session_aborted" }))).toBe("aborted");
    expect(stopReasonFor(view({ why: "mic_check_held" }))).toBe("client_stop");
  });

  it("shows the facilitator's pause and a skipped mic check over the engine state", () => {
    const rec = { status: { ...IDLE, state: "recording" as const }, gesture: true };
    expect(recStateFor(view({ why: "audio_off" }), rec)).toBeNull();
    expect(recStateFor(view({ why: "mic_check_skipped" }), rec)).toBe("skipped");
    expect(recStateFor(view({ why: "paused" }), rec)).toBe("paused");
    expect(recStateFor(COMPLETE, rec)).toBe("off");
    expect(recStateFor(view({ why: "mic_check_held" }), rec)).toBe("off");
    expect(recStateFor(MIC_CHECK, rec)).toBe("recording");
    expect(recStateFor(MIC_CHECK, { status: { ...IDLE, state: "no_signal" }, gesture: true })).toBe(
      "no_signal",
    );
    expect(recStateFor(MIC_CHECK, { status: { ...IDLE, state: "denied" }, gesture: true })).toBe("denied");
    // idle at the mic check before the Start click: not recording yet
    expect(recStateFor(MIC_CHECK, { status: IDLE, gesture: false })).toBe("off");
    expect(recStateFor(BRIEFING, { status: IDLE, gesture: false })).toBe("requesting");
    expect(wantsRecording(view({ why: "mic_check_held" }))).toBe(false);
  });
});

/* ─── the state machine: state + input → state + what the engine is asked ─── */

const idle = (next: Extract<Phase, { at: "idle" }>["next"] = null): Phase => ({ at: "idle", next });
const failed = (next: Extract<Phase, { at: "failed" }>["next"] = null): Phase => ({ at: "failed", next });
const running: Phase = { at: "running" };
const m = (o: Partial<Machine> = {}): Machine => ({ ...INITIAL, ...o });
const start = (reason: string) => ({ do: "start", reason }) as Effect;
const stop = (reason: string) => ({ do: "stop", reason }) as Effect;
const RESEND: Effect = { do: "resend" };
const CLEAR: Effect = { do: "clear" };

interface Row {
  name: string;
  from: Machine;
  input: Input;
  view: PlayerView | null;
  /** this tab recorded the seat before (sessionStorage) */
  tab?: boolean;
  to: Machine;
  effects: Effect[];
}

const TRANSITIONS: Row[] = [
  // starting
  {
    name: "waits for the mic check's Start click",
    from: m(),
    input: "settle",
    view: MIC_CHECK,
    to: m(),
    effects: [],
  },
  {
    name: "the Start click records with mic_check",
    from: m(),
    input: "click",
    view: MIC_CHECK,
    to: m({ phase: running, gesture: true }),
    effects: [start("mic_check")],
  },
  {
    name: "at the mic check after a reload of a tab that recorded the seat: reload",
    from: m(),
    input: "click",
    view: MIC_CHECK,
    tab: true,
    to: m({ phase: running, gesture: true }),
    effects: [start("reload")],
  },
  {
    name: "past the mic check (a reload) records at once with reload",
    from: m(),
    input: "settle",
    view: BRIEFING,
    to: m({ phase: running }),
    effects: [start("reload")],
  },
  {
    name: "a click while the mic check is held only remembers the click",
    from: m(),
    input: "click",
    view: view({ why: "mic_check_held" }),
    to: m({ gesture: true }),
    effects: [],
  },
  {
    name: "no audio: nothing",
    from: m(),
    input: "settle",
    view: view({ why: "audio_off" }),
    to: m(),
    effects: [],
  },
  {
    name: "recording: a new view changes nothing",
    from: m({ phase: running }),
    input: "settle",
    view: BRIEFING,
    to: m({ phase: running }),
    effects: [],
  },
  // the server's verdict says no
  {
    name: "the facilitator's pause stops with paused; the next track is a resume",
    from: m({ phase: running }),
    input: "settle",
    view: PAUSED,
    to: m({ phase: idle("resume") }),
    effects: [stop("paused")],
  },
  {
    name: "the resume starts with resume",
    from: m({ phase: idle("resume") }),
    input: "settle",
    view: GAME,
    to: m({ phase: running }),
    effects: [start("resume")],
  },
  {
    name: "game complete",
    from: m({ phase: running }),
    input: "settle",
    view: COMPLETE,
    to: m(),
    effects: [stop("game_complete")],
  },
  {
    name: "withdrawn",
    from: m({ phase: running }),
    input: "settle",
    view: view({ phase: "round_active", nextStep: null, withdrawn: true, why: "withdrawn" }),
    to: m(),
    effects: [stop("withdrawn")],
  },
  {
    name: "mic check skipped",
    from: m({ phase: running }),
    input: "settle",
    view: view({ why: "mic_check_skipped" }),
    to: m(),
    effects: [stop("skipped")],
  },
  // reconnect
  {
    name: "a reconnect waits for the next view",
    from: m({ phase: running }),
    input: "reconnected",
    view: GAME,
    to: m({ phase: running, link: "reconnected" }),
    effects: [],
  },
  {
    name: "the view after a reconnect resends and stops with disconnect; the next track is a reconnect",
    from: m({ phase: running, link: "reconnected" }),
    input: "resync",
    view: GAME,
    to: m({ phase: idle("reconnect") }),
    effects: [RESEND, stop("disconnect")],
  },
  {
    name: "…which the same pass starts with reconnect",
    from: m({ phase: idle("reconnect") }),
    input: "settle",
    view: GAME,
    to: m({ phase: running }),
    effects: [start("reconnect")],
  },
  {
    name: "the view after a reconnect says paused: stops with paused",
    from: m({ phase: running, link: "reconnected" }),
    input: "resync",
    view: PAUSED,
    to: m({ phase: idle("resume") }),
    effects: [RESEND, stop("paused")],
  },
  {
    name: "a reconnect while not recording only resends",
    from: m({ phase: idle("resume"), link: "reconnected" }),
    input: "resync",
    view: PAUSED,
    to: m({ phase: idle("resume") }),
    effects: [RESEND],
  },
  {
    name: "no resync without a view",
    from: m({ phase: running, link: "reconnected" }),
    input: "resync",
    view: null,
    to: m({ phase: running, link: "reconnected" }),
    effects: [],
  },
  // detached session (the seat is kept)
  {
    name: "detached: the track stops with disconnect",
    from: m({ phase: running, link: "detached" }),
    input: "settle",
    view: null,
    to: m({ phase: idle("reconnect"), link: "detached" }),
    effects: [stop("disconnect")],
  },
  {
    name: "a reconnect while detached stays detached",
    from: m({ link: "detached" }),
    input: "reconnected",
    view: null,
    to: m({ link: "detached" }),
    effects: [],
  },
  {
    name: "re-attached: resends, then starts with reconnect",
    from: m({ phase: idle("reconnect"), link: "detached" }),
    input: "resync",
    view: GAME,
    to: m({ phase: idle("reconnect") }),
    effects: [RESEND],
  },
  // the microphone is lost
  {
    name: "lost after a track ran: the next track is permission_regained",
    from: m({ phase: running, tracked: true }),
    input: "mic_failed",
    view: GAME,
    to: m({ phase: failed("permission_regained"), tracked: true }),
    effects: [],
  },
  {
    name: "lost before any track (the first start failed)",
    from: m({ phase: running }),
    input: "mic_failed",
    view: GAME,
    to: m({ phase: failed() }),
    effects: [],
  },
  {
    name: "no retry loop on the next view",
    from: m({ phase: failed("permission_regained"), tracked: true }),
    input: "settle",
    view: GAME,
    to: m({ phase: failed("permission_regained"), tracked: true }),
    effects: [],
  },
  {
    name: "Try again starts with permission_regained",
    from: m({ phase: failed("permission_regained"), tracked: true }),
    input: "click",
    view: GAME,
    to: m({ phase: running, tracked: true, gesture: true }),
    effects: [start("permission_regained")],
  },
  {
    name: "a failed first mic check retries with mic_check",
    from: m({ phase: failed(), gesture: true }),
    input: "click",
    view: MIC_CHECK,
    to: m({ phase: running, gesture: true }),
    effects: [start("mic_check")],
  },
  {
    name: "a device or permission change recovers (the next settle starts)",
    from: m({ phase: failed("permission_regained"), tracked: true }),
    input: "device_change",
    view: GAME,
    to: m({ phase: idle("permission_regained"), tracked: true }),
    effects: [],
  },
  {
    name: "a device change at the mic check before its Start click: nothing",
    from: m({ phase: failed() }),
    input: "device_change",
    view: MIC_CHECK,
    to: m({ phase: failed() }),
    effects: [],
  },
  {
    name: "a device change while paused: nothing",
    from: m({ phase: failed() }),
    input: "device_change",
    view: PAUSED,
    to: m({ phase: failed() }),
    effects: [],
  },
  {
    name: "Try again while paused recovers, and the resume starts with permission_regained",
    from: m({ phase: failed("permission_regained"), tracked: true }),
    input: "click",
    view: PAUSED,
    to: m({ phase: idle("permission_regained"), tracked: true, gesture: true }),
    effects: [],
  },
  {
    name: "the engine's failure while idle changes nothing",
    from: m(),
    input: "mic_failed",
    view: GAME,
    to: m(),
    effects: [],
  },
  // the engine
  {
    name: "a track began",
    from: m({ phase: running }),
    input: "track_started",
    view: GAME,
    to: m({ phase: running, tracked: true }),
    effects: [],
  },
  {
    name: "start() threw",
    from: m({ phase: running }),
    input: "start_failed",
    view: GAME,
    to: m(),
    effects: [],
  },
  // the seat is unbound
  {
    name: "unbound forgets the click and the tracks",
    from: m({ phase: running, gesture: true, tracked: true, link: "reconnected" }),
    input: "unbound",
    view: null,
    to: m({ phase: running, clear: true }),
    effects: [],
  },
  {
    name: "…then stops with client_stop and clears what is pending",
    from: m({ phase: running, clear: true }),
    input: "settle",
    view: null,
    to: m(),
    effects: [stop("client_stop"), CLEAR],
  },
  {
    name: "unbound after a lost microphone: only clears",
    from: m({ phase: failed("permission_regained"), tracked: true }),
    input: "unbound",
    view: null,
    to: m({ clear: true }),
    effects: [],
  },
  {
    name: "clears once idle",
    from: m({ clear: true }),
    input: "settle",
    view: null,
    to: m(),
    effects: [CLEAR],
  },
];

describe("recording state machine", () => {
  it.each(TRANSITIONS)("$name", (r) => {
    const s = step(r.from, r.input, { view: r.view, trackedInTab: r.tab ?? false });
    expect(s.effects).toEqual(r.effects);
    expect(s.m).toEqual(r.to);
  });

  it("returns the same state when an input changes nothing (no publish)", () => {
    const from = m({ phase: failed() });
    expect(step(from, "device_change", { view: PAUSED, trackedInTab: false }).m).toBe(from);
  });
});

/* ─── the controller: the machine wired to the engine and the socket ─── */

/** A recorder that records what the controller asks of it, and reports states like MicRecorder. */
class FakeRecorder implements RecorderLike {
  status: RecorderStatus = { ...IDLE };
  pendingChunks = 0;
  pendingBytes = 0;
  captureSettings = { sampleRate: 48000 };
  calls: string[] = [];
  private n = 0;
  private drained: Array<() => void> = [];
  constructor(readonly o: MicRecorderOptions) {}
  prepare() {
    this.calls.push("prepare");
    return true;
  }
  async resume() {
    this.calls.push("resume");
    this.set({ needsGesture: false, state: "recording" });
    return true;
  }
  async start(reason?: string): Promise<RecorderState> {
    this.calls.push(`start:${reason}`);
    this.set({ state: "recording", trackId: `track-${++this.n}`, error: null });
    return "recording";
  }
  async stop(reason?: string) {
    this.calls.push(`stop:${reason}`);
    this.set({ state: "idle", trackId: null });
  }
  onReconnect() {
    this.calls.push("onReconnect");
  }
  clearPending() {
    this.calls.push("clearPending");
    return 0;
  }
  addTap() {
    return () => {};
  }
  /** resolves once nothing is pending (`drain()`: the server acknowledged everything) */
  whenSent() {
    if (this.pendingChunks === 0) return Promise.resolve();
    return new Promise<void>((r) => this.drained.push(r));
  }
  drain() {
    this.pendingChunks = 0;
    this.pendingBytes = 0;
    for (const r of this.drained.splice(0)) r();
  }
  set(p: Partial<RecorderStatus>) {
    this.status = { ...this.status, ...p };
    this.o.onState?.(this.status.state, this.status);
  }
}

function setup() {
  // the "recorded in this tab" flag lives in sessionStorage (where the runtime has one)
  try {
    globalThis.sessionStorage?.clear();
  } catch {}
  let rec: FakeRecorder | null = null;
  const sent: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const levels: unknown[] = [];
  const permissions: unknown[] = [];
  let deviceChanged = () => {};
  const ctl = new RecordingController({
    send: async (event, payload) => {
      sent.push({ event, payload: payload as Record<string, unknown> });
      return { ok: true };
    },
    level: (p) => levels.push(p),
    now: () => 1_700_000_000_000,
    clockOffsetMs: () => 12.5,
    permission: (p) => permissions.push(p),
    createRecorder: (o) => {
      rec = new FakeRecorder(o);
      return rec;
    },
    watchDevices: (fn) => {
      deviceChanged = fn;
      return () => {};
    },
  });
  return {
    ctl,
    rec: () => rec!,
    snap: () => ctl.store.get(),
    deviceChanged: () => deviceChanged(),
    sent,
    levels,
    permissions,
  };
}

/** The engine's start and stop calls only (not prepare, resume, onReconnect, clearPending). */
const tracks = (r: FakeRecorder) => r.calls.filter((c) => c.startsWith("start:") || c.startsWith("stop:"));

describe("RecordingController", () => {
  it("starts inside the mic check's Start click and keeps the click through a detached session", async () => {
    const t = setup();
    t.ctl.onConnect();
    t.ctl.update(MIC_CHECK);
    await settle();
    expect(t.rec().calls).toEqual([]);
    t.ctl.startFromClick();
    // synchronously, inside the click, after preparing the audio engine
    expect(t.rec().calls).toEqual(["prepare", "start:mic_check"]);
    await settle();
    expect(t.snap()).toMatchObject({ status: { state: "recording" }, gesture: true });
    expect(t.permissions).toEqual([{ state: "granted" }]);
    // detached and back at the mic check (the screen may remount): still recording, no new click
    t.ctl.onDetached();
    await settle();
    t.ctl.update(MIC_CHECK);
    await settle();
    expect(tracks(t.rec())).toEqual(["start:mic_check", "stop:disconnect", "start:reconnect"]);
    expect(t.snap()).toMatchObject({ status: { state: "recording" }, gesture: true });
  });

  it("runs a session: held, pause and resume, a reconnect, a detached session, game complete, unbind", async () => {
    const t = setup();
    t.ctl.onConnect();
    // never opens the microphone while the session has no audio or the mic check is held
    t.ctl.update(view({ why: "audio_off" }));
    await settle();
    t.ctl.update(view({ why: "mic_check_held" }));
    t.ctl.startFromClick();
    await settle();
    expect(t.rec().calls).toEqual(["prepare"]);
    for (const v of [GAME, PAUSED, GAME]) {
      t.ctl.update(v);
      await settle();
    }
    t.ctl.onConnect(); // the socket came back
    t.ctl.update(GAME);
    await settle();
    expect(t.rec().calls).toContain("onReconnect");
    t.ctl.onDetached(); // another session was resumed: the seat token is kept
    await settle();
    t.ctl.update(GAME); // the session is attached again and the seat re-claimed
    await settle();
    t.ctl.update(COMPLETE);
    await settle();
    expect(tracks(t.rec())).toEqual([
      "start:reload",
      "stop:paused",
      "start:resume",
      "stop:disconnect",
      "start:reconnect",
      "stop:disconnect",
      "start:reconnect",
      "stop:game_complete",
    ]);
    // a detached session keeps what was not sent; unbinding drops it
    expect(t.rec().calls).not.toContain("clearPending");
    t.ctl.onUnbound();
    await settle();
    expect(t.rec().calls.at(-1)).toBe("clearPending");
    expect(t.snap().gesture).toBe(false);
  });

  it("loses the microphone: reports denied, waits for a click, retries after a device change", async () => {
    const t = setup();
    t.ctl.update(GAME);
    await settle();
    // the permission is revoked mid-game: the engine ends the track and reports denied
    t.rec().set({
      state: "denied",
      trackId: null,
      error: { name: "NotAllowedError" } as RecorderStatus["error"],
    });
    await settle();
    expect(t.permissions.at(-1)).toEqual({ state: "denied", errorName: "NotAllowedError" });
    // no retry loop on the next state push
    t.ctl.update(GAME);
    await settle();
    expect(t.rec().calls).toEqual(["start:reload"]);
    t.ctl.fixFromClick();
    await settle();
    expect(t.rec().calls.slice(1)).toEqual(["prepare", "start:permission_regained"]);
    expect(t.snap().status.state).toBe("recording");
    // the engine loses the microphone again; a device change (a microphone plugged in) retries
    t.rec().set({
      state: "error",
      trackId: null,
      error: { name: "NotReadableError" } as RecorderStatus["error"],
    });
    await settle();
    expect(t.permissions.at(-1)).toEqual({ state: "error", errorName: "NotReadableError" });
    t.deviceChanged();
    await settle();
    expect(tracks(t.rec())).toEqual([
      "start:reload",
      "start:permission_regained",
      "start:permission_regained",
    ]);
    // after a reload the browser keeps audio suspended: the click resumes it
    t.rec().set({ state: "paused", needsGesture: true });
    expect(t.snap().status.needsGesture).toBe(true);
    t.ctl.fixFromClick();
    await settle();
    expect(t.rec().calls.at(-1)).toBe("resume");
    expect(t.snap().status.state).toBe("recording");
  });

  it("sends the engine's messages as they are, and volatile levels", async () => {
    const t = setup();
    t.ctl.update(BRIEFING);
    await settle();
    const r = t.rec();
    await r.o.sendStart({
      trackId: "track-1",
      reason: "reload",
      sampleRate: 16000,
      chunkSamples: 80000,
      clientTs: 1,
      clockOffsetMs: 0,
      inputLatencyMs: 0,
      settings: { sampleRate: 48000 },
      context: {
        sampleRate: 44100,
        baseLatencyMs: null,
        outputLatencyMs: null,
        timingMethod: "current-time",
      },
    });
    expect(t.sent[0]).toMatchObject({ event: "audio:start", payload: { reason: "reload" } });
    expect(t.snap().contextSampleRate).toBe(44100);
    const stopInfo = {
      trackId: "track-1",
      reason: "client_stop" as const,
      chunks: 5,
      samples: 400000,
      droppedChunks: 2,
      clientTs: 2,
      clockOffsetMs: 0,
    };
    await r.o.sendStop(stopInfo);
    expect(t.sent[1]).toEqual({ event: "audio:stop", payload: stopInfo });
    r.o.onLevel?.({ rmsDb: Number.NEGATIVE_INFINITY, peakDb: -Math.PI });
    expect(t.levels.at(-1)).toEqual({
      state: "recording",
      rmsDb: -120,
      peakDb: -3.1,
      pendingChunks: 0,
      pendingBytes: 0,
    });
  });

  it("after a stop, reports nothing pending once the queue has drained (wrap-up upload check)", async () => {
    const t = setup();
    t.ctl.update(GAME);
    await settle();
    const r = t.rec();
    r.pendingChunks = 3;
    r.pendingBytes = 480_000;
    t.ctl.update(COMPLETE);
    await settle();
    expect(r.calls.at(-1)).toBe("stop:game_complete");
    // still uploading: the latest report shows the backlog, no "drained" report yet
    expect(t.levels.at(-1)).toMatchObject({ state: "idle", pendingChunks: 3 });
    r.drain();
    await settle();
    expect(t.levels.at(-1)).toEqual({
      state: "idle",
      rmsDb: -120,
      peakDb: -120,
      pendingChunks: 0,
      pendingBytes: 0,
    });
  });

  it("reports the drained queue after the microphone was lost", async () => {
    const t = setup();
    t.ctl.update(GAME);
    await settle();
    const r = t.rec();
    r.pendingChunks = 1;
    r.pendingBytes = 1000;
    r.set({ state: "error", trackId: null, error: { name: "NotReadableError" } as RecorderStatus["error"] });
    await settle();
    r.drain();
    await settle();
    expect(t.levels.at(-1)).toMatchObject({ state: "error", pendingChunks: 0, pendingBytes: 0 });
  });

  it("a reload at the mic check after a track was recorded starts with reload", async () => {
    if (typeof globalThis.sessionStorage === "undefined") return; // runtime without Web Storage
    const first = setup();
    first.ctl.update(MIC_CHECK);
    await settle();
    first.ctl.startFromClick();
    await settle();
    expect(sessionStorage.getItem("wkwa.audio.tracked")).toBe("1");
    // the page reloads: a new controller in the same tab
    const t = setup();
    sessionStorage.setItem("wkwa.audio.tracked", "1");
    t.ctl.update(MIC_CHECK);
    await settle();
    t.ctl.startFromClick();
    await settle();
    expect(t.rec().calls.filter((c) => c.startsWith("start"))).toEqual(["start:reload"]);
  });
});
