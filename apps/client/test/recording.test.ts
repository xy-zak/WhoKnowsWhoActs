import type { NotRecordingReason, PlayerView } from "@wkwa/shared";
import { describe, expect, it } from "vitest";
import type { MicRecorderOptions, RecorderState, RecorderStatus } from "../src/audio";
import {
  type RecorderLike,
  RecordingController,
  recStateFor,
  startReasonFor,
  stopReasonFor,
  wantsRecording,
  wireStartReason,
  wireStopReason,
} from "../src/player/recording";

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

/** A recorder that records what the controller asks of it, and reports states like MicRecorder. */
class FakeRecorder implements RecorderLike {
  status: RecorderStatus = { ...IDLE };
  pendingChunks = 0;
  pendingBytes = 0;
  droppedChunks = 0;
  captureSettings = { sampleRate: 48000 };
  calls: string[] = [];
  /** the next start() ends in this state (with this error name) */
  failWith: { state: "denied" | "error"; name: string } | null = null;
  private n = 0;
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
    this.set({ state: "requesting" });
    await Promise.resolve();
    if (this.failWith) {
      const f = this.failWith;
      this.failWith = null;
      this.set({
        state: f.state,
        error: {
          kind: f.state === "denied" ? "denied" : "not_found",
          name: f.name,
        } as RecorderStatus["error"],
      });
      return f.state;
    }
    this.set({ state: "recording", trackId: `track-${++this.n}`, error: null });
    return "recording";
  }
  async stop(reason?: string) {
    this.calls.push(`stop:${reason}`);
    await Promise.resolve();
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
  /** resolves once `drain()` is called (the server acknowledged everything) */
  private drained: Array<() => void> = [];
  autoDrain = true;
  whenSent() {
    if (this.autoDrain && this.pendingChunks === 0) return Promise.resolve();
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
  });
  return { ctl, rec: () => rec!, sent, levels, permissions };
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

/* ─── pure mapping ─── */

describe("recording: reasons and states", () => {
  it("stops with the stop reason of the server's verdict", () => {
    expect(stopReasonFor(null)).toBe("client_stop");
    expect(stopReasonFor(view({ why: "paused" }))).toBe("paused");
    expect(stopReasonFor(view({ phase: "aborted", why: "session_aborted" }))).toBe("aborted");
    expect(stopReasonFor(view({ why: "mic_check_held" }))).toBe("client_stop");
  });

  it("starts with mic_check at the mic check and reload past it, unless a specific reason is due", () => {
    expect(startReasonFor(view(), null)).toBe("mic_check");
    expect(startReasonFor(view({ nextStep: "demographics" }), null)).toBe("reload");
    expect(startReasonFor(view({ phase: "round_active", nextStep: null }), "resume")).toBe("resume");
  });

  it("only sends reasons the server accepts", () => {
    expect(wireStopReason("paused")).toBe("paused");
    expect(wireStopReason("track_ended")).toBe("track_ended");
    expect(wireStopReason("dispose")).toBe("client_stop");
    expect(wireStopReason("context_closed")).toBe("error");
    expect(wireStartReason("context_resumed")).toBe("context_resumed");
    expect(wireStartReason("start")).toBe("reload");
  });

  it("shows the facilitator's pause and a skipped mic check over the engine state", () => {
    const rec = { status: { ...IDLE, state: "recording" as const }, gesture: true };
    expect(recStateFor(view({ why: "audio_off" }), rec)).toBeNull();
    expect(recStateFor(view({ why: "mic_check_skipped" }), rec)).toBe("skipped");
    expect(recStateFor(view({ why: "paused" }), rec)).toBe("paused");
    expect(recStateFor(view({ phase: "game_complete", why: "game_complete" }), rec)).toBe("off");
    expect(recStateFor(view({ why: "mic_check_held" }), rec)).toBe("off");
    expect(recStateFor(view(), rec)).toBe("recording");
    expect(recStateFor(view(), { status: { ...IDLE, state: "no_signal" }, gesture: true })).toBe("no_signal");
    expect(recStateFor(view(), { status: { ...IDLE, state: "denied" }, gesture: true })).toBe("denied");
    // idle at the mic check before the Start click: not recording yet
    expect(recStateFor(view(), { status: IDLE, gesture: false })).toBe("off");
    expect(recStateFor(view({ nextStep: "briefing" }), { status: IDLE, gesture: false })).toBe("requesting");
    expect(wantsRecording(view({ why: "mic_check_held" }))).toBe(false);
  });
});

/* ─── controller ─── */

describe("RecordingController", () => {
  it("waits for the mic check's Start click, then records with reason mic_check", async () => {
    const t = setup();
    t.ctl.update(view());
    await settle();
    expect(t.rec().calls).toEqual([]);
    t.ctl.startFromClick();
    // prepare() runs synchronously inside the click, before the start
    expect(t.rec().calls.slice(0, 2)).toEqual(["prepare", "start:mic_check"]);
    await settle();
    expect(t.ctl.snapshot.status.state).toBe("recording");
    expect(t.ctl.snapshot.gesture).toBe(true);
    expect(t.permissions).toEqual([{ state: "granted" }]);
    // a state push changes nothing while recording
    t.ctl.update(view({ nextStep: "demographics" }));
    await settle();
    expect(t.rec().calls.filter((c) => c.startsWith("start"))).toHaveLength(1);
  });

  it("never opens the microphone while the mic check is held or the session has no audio", async () => {
    const t = setup();
    t.ctl.update(view({ why: "audio_off" }));
    await settle();
    t.ctl.update(view({ why: "mic_check_held" }));
    await settle();
    t.ctl.startFromClick();
    await settle();
    expect(t.rec().calls).toEqual(["prepare"]);
  });

  it("stops with paused on the facilitator's pause and starts a new track with resume", async () => {
    const t = setup();
    const game = { phase: "round_active" as const, nextStep: null };
    t.ctl.update(view(game));
    await settle();
    expect(t.rec().calls).toEqual(["start:reload"]);
    t.ctl.update(view({ ...game, why: "paused" }));
    await settle();
    t.ctl.update(view(game));
    await settle();
    expect(t.rec().calls).toEqual(["start:reload", "stop:paused", "start:resume"]);
  });

  it("after a reconnect resends, stops the old track with disconnect and starts with reconnect", async () => {
    const t = setup();
    const game = view({ phase: "round_active", nextStep: null });
    t.ctl.onConnect();
    t.ctl.update(game);
    await settle();
    t.ctl.onConnect(); // the socket came back
    t.ctl.update(game);
    await settle();
    expect(t.rec().calls).toEqual(["start:reload", "onReconnect", "stop:disconnect", "start:reconnect"]);
  });

  it("stops with game_complete when the game ends", async () => {
    const t = setup();
    t.ctl.update(view({ phase: "round_active", nextStep: null }));
    await settle();
    t.ctl.update(view({ phase: "game_complete", nextStep: null, why: "game_complete" }));
    await settle();
    expect(t.rec().calls.at(-1)).toBe("stop:game_complete");
  });

  it("reports a denied microphone, waits, and retries with permission_regained after a click", async () => {
    const t = setup();
    const game = view({ phase: "round_active", nextStep: null });
    t.ctl.update(game);
    await settle();
    // the permission is revoked mid-game: the engine ends the track and reports denied
    t.rec().set({
      state: "denied",
      trackId: null,
      error: { name: "NotAllowedError" } as RecorderStatus["error"],
    });
    await settle();
    expect(t.ctl.snapshot.failed).toBe(true);
    expect(t.permissions.at(-1)).toEqual({ state: "denied", errorName: "NotAllowedError" });
    // no retry loop on the next state push
    t.ctl.update(game);
    await settle();
    expect(t.rec().calls).toEqual(["start:reload"]);
    t.ctl.fixFromClick();
    await settle();
    expect(t.rec().calls.slice(1)).toEqual(["prepare", "start:permission_regained"]);
    expect(t.ctl.snapshot.status.state).toBe("recording");
  });

  it("a failed first mic check retries with mic_check", async () => {
    const t = setup();
    t.ctl.update(view());
    await settle();
    t.rec().failWith = { state: "error", name: "NotFoundError" };
    t.ctl.startFromClick();
    await settle();
    expect(t.ctl.snapshot.failed).toBe(true);
    expect(t.permissions.at(-1)).toEqual({ state: "error", errorName: "NotFoundError" });
    t.ctl.startFromClick();
    await settle();
    // no track was ever recorded, so the retry is still the mic check
    expect(t.rec().calls.filter((c) => c.startsWith("start"))).toEqual([
      "start:mic_check",
      "start:mic_check",
    ]);
    expect(t.ctl.snapshot.status.state).toBe("recording");
  });

  it("asks for a click after a reload when the browser keeps audio suspended", async () => {
    const t = setup();
    t.ctl.update(view({ phase: "round_active", nextStep: null }));
    await settle();
    t.rec().set({ state: "paused", needsGesture: true });
    expect(t.ctl.snapshot.status.needsGesture).toBe(true);
    t.ctl.fixFromClick();
    await settle();
    expect(t.rec().calls.at(-1)).toBe("resume");
    expect(t.ctl.snapshot.status.state).toBe("recording");
  });

  it("on unbind stops with client_stop and drops what was not sent", async () => {
    const t = setup();
    t.ctl.update(view({ nextStep: "briefing" }));
    await settle();
    t.ctl.onUnbound();
    await settle();
    expect(t.rec().calls).toEqual(["start:reload", "stop:client_stop", "clearPending"]);
    expect(t.ctl.snapshot.gesture).toBe(false);
  });

  it("on a detached session stops with disconnect, keeps what was not sent, and resends once seated again", async () => {
    const t = setup();
    const game = view({ phase: "round_active", nextStep: null });
    t.ctl.onConnect();
    t.ctl.update(game);
    await settle();
    t.ctl.onDetached(); // another session was resumed: the seat token is kept
    await settle();
    expect(t.rec().calls).toEqual(["start:reload", "stop:disconnect"]);
    t.ctl.update(game); // the session is attached again and the seat re-claimed
    await settle();
    expect(t.rec().calls).toEqual(["start:reload", "stop:disconnect", "onReconnect", "start:reconnect"]);
  });

  it("sends documented reasons, the dropped chunks of the track and volatile levels", async () => {
    const t = setup();
    t.ctl.update(view({ nextStep: "briefing" }));
    await settle();
    const r = t.rec();
    await r.o.sendStart({
      trackId: "track-1",
      reason: "start",
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
    expect(t.ctl.snapshot.contextSampleRate).toBe(44100);
    r.droppedChunks = 2;
    await r.o.sendStop({
      trackId: "track-1",
      reason: "dispose",
      chunks: 5,
      samples: 400000,
      clientTs: 2,
      clockOffsetMs: 0,
    });
    expect(t.sent[1]).toMatchObject({
      event: "audio:stop",
      payload: { reason: "client_stop", droppedChunks: 2 },
    });
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
    const game = { phase: "round_active" as const, nextStep: null };
    t.ctl.update(view(game));
    await settle();
    const r = t.rec();
    r.pendingChunks = 3;
    r.pendingBytes = 480_000;
    t.ctl.update(view({ ...game, phase: "game_complete", why: "game_complete" }));
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
    t.ctl.update(view({ phase: "round_active", nextStep: null }));
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
    first.ctl.update(view());
    await settle();
    first.ctl.startFromClick();
    await settle();
    // the page reloads: a new controller in the same tab
    const t = setup();
    sessionStorage.setItem("wkwa.audio.tracked", "1");
    t.ctl.update(view());
    await settle();
    t.ctl.startFromClick();
    await settle();
    expect(t.rec().calls.filter((c) => c.startsWith("start"))).toEqual(["start:reload"]);
  });
});
