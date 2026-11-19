import type { PlayerView } from "@wkwa/shared";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpeechCheckResult } from "../src/audio";
import { memoryStorage } from "../src/net/storage";
import { PlayerConnection } from "../src/player/connection";
import { MicCheckScreen } from "../src/player/MicCheckScreen";
import {
  GIVE_UP_MS,
  MicCheckAttempt,
  type MicCheckClock,
  type MicCheckOutcome,
  PASSED_HOLD_MS,
} from "../src/player/micCheckAttempt";
import { FakeSocket } from "./fakeSocket";
import { flushPromises as flush } from "./helpers";

/* ─── fixtures ─── */

/** A clock the test moves by hand (starts well past 0, like performance.now() on a loaded page). */
class FakeClock implements MicCheckClock {
  t = 10_000;
  private timers: Array<{ at: number; fn: () => void; id: number }> = [];
  private ids = 0;
  now = () => this.t;
  setTimeout = (fn: () => void, ms: number) => {
    const id = ++this.ids;
    this.timers.push({ at: this.t + ms, fn, id });
    return id;
  };
  clearTimeout = (id: unknown) => {
    this.timers = this.timers.filter((x) => x.id !== id);
  };
  advance(ms: number) {
    this.t += ms;
    for (const x of this.timers.filter((x) => x.at <= this.t)) {
      this.timers = this.timers.filter((y) => y !== x);
      x.fn();
    }
  }
}

const heard = (speechMs: number, analysedMs: number, need = 1000): SpeechCheckResult => ({
  speechMs,
  noiseFloorDb: -70,
  speechDb: -25,
  passed: speechMs >= need,
  analysedMs,
});

/** A mic check whose detector returns `next` for every block, and whose server answers `answer`. */
function setup(o: { resumed?: boolean } = {}) {
  const clock = new FakeClock();
  const sent: MicCheckOutcome[] = [];
  let answer: (o: MicCheckOutcome) => Promise<boolean> = async () => true;
  let next = heard(0, 0);
  let detectors = 0;
  const check = new MicCheckAttempt({
    minSpeechMs: 1000,
    clock,
    resumed: o.resumed,
    detector: () => {
      detectors++;
      return { push: () => next };
    },
    submit: (x) => {
      sent.push(x);
      return answer(x);
    },
  });
  return {
    check,
    clock,
    sent,
    detectors: () => detectors,
    /** one block from the recorder, `ms` after the previous one, that the detector scores as `r` */
    hear(r: SpeechCheckResult, ms = 200) {
      clock.advance(ms);
      next = r;
      check.push(new Float32Array(320));
    },
    answerWith(fn: (o: MicCheckOutcome) => Promise<boolean>) {
      answer = fn;
    },
  };
}

/* ─── the attempt ─── */

describe("MicCheckAttempt", () => {
  it("listens only after Start, each attempt with a fresh detector", () => {
    const t = setup();
    t.hear(heard(500, 500));
    expect(t.check.snapshot).toMatchObject({ attempts: 0, result: null });
    t.check.start();
    t.hear(heard(500, 500));
    expect(t.check.snapshot).toMatchObject({ attempts: 1, result: { speechMs: 500 } });
    t.check.start();
    expect(t.check.snapshot).toMatchObject({ attempts: 2, result: null });
    expect(t.detectors()).toBe(2);
  });

  it("shows the speech heard at most every 150 ms, a pass at once", () => {
    const t = setup();
    t.check.start();
    t.hear(heard(100, 200));
    t.hear(heard(200, 300), 100); // 100 ms later: not shown
    expect(t.check.snapshot.result?.speechMs).toBe(100);
    t.hear(heard(300, 360), 60); // 160 ms after the last shown
    expect(t.check.snapshot.result?.speechMs).toBe(300);
    t.hear(heard(1000, 400), 10);
    expect(t.check.snapshot).toMatchObject({ passed: true, result: { speechMs: 1000 } });
  });

  it("a pass shows for 1.2 s, then is sent once", async () => {
    const t = setup();
    t.clock.advance(3000); // the screen was open 3 s before Start
    t.check.start();
    t.hear(heard(1000, 2000)); // passes 200 ms after Start: the confirmation runs from here
    t.hear(heard(1400, 2400)); // 200 ms later, still passing: not sent again
    t.clock.advance(PASSED_HOLD_MS - 200 - 1); // 1 ms before the confirmation ends
    expect(t.sent).toEqual([]);
    t.clock.advance(1);
    await flush();
    expect(t.sent).toEqual([
      { passed: true, attempts: 1, durationMs: 3000 + 200 + PASSED_HOLD_MS, result: heard(1000, 2000) },
    ]);
    expect(t.check.snapshot).toMatchObject({ passed: true, unsent: false, busy: false });
  });

  it("a pass the server did not take is sent again with Continue", async () => {
    const t = setup();
    t.answerWith(async () => false);
    t.check.start();
    t.hear(heard(1000, 2000));
    t.clock.advance(PASSED_HOLD_MS);
    await flush();
    expect(t.check.snapshot.unsent).toBe(true);
    t.answerWith(async () => true);
    t.check.resend();
    expect(t.check.snapshot.busy).toBe(true);
    await flush();
    expect(t.sent.map((o) => o.passed)).toEqual([true, true]);
    expect(t.check.snapshot).toMatchObject({ unsent: false, busy: false });
  });

  it("a failed submit counts as not taken", async () => {
    const t = setup();
    t.answerWith(async () => {
      throw new Error("timeout");
    });
    t.check.start();
    t.hear(heard(1000, 2000));
    t.clock.advance(PASSED_HOLD_MS);
    await flush();
    expect(t.check.snapshot).toMatchObject({ unsent: true, busy: false });
  });

  it("gives up after 20 s without a pass: logged once per attempt", async () => {
    const t = setup();
    t.check.start();
    t.hear(heard(300, GIVE_UP_MS - 1));
    expect(t.check.snapshot.gaveUp).toBe(false);
    t.hear(heard(300, GIVE_UP_MS));
    t.hear(heard(350, GIVE_UP_MS + 500));
    await flush();
    expect(t.sent).toEqual([
      expect.objectContaining({ passed: false, attempts: 1, result: heard(300, GIVE_UP_MS) }),
    ]);
    expect(t.check.snapshot.gaveUp).toBe(true);
    // Start again: a new attempt, which may give up (and be logged) again
    t.check.start();
    expect(t.check.snapshot.gaveUp).toBe(false);
    t.hear(heard(100, GIVE_UP_MS));
    await flush();
    expect(t.sent.map((o) => [o.passed, o.attempts])).toEqual([
      [false, 1],
      [false, 2],
    ]);
  });

  it("a pass after giving up is still sent", async () => {
    const t = setup();
    t.check.start();
    t.hear(heard(300, GIVE_UP_MS));
    t.hear(heard(1000, GIVE_UP_MS + 3000));
    expect(t.check.snapshot).toMatchObject({ passed: true, gaveUp: false });
    t.clock.advance(PASSED_HOLD_MS);
    await flush();
    expect(t.sent.map((o) => o.passed)).toEqual([false, true]);
  });

  it("closing the screen during the confirmation sends nothing", async () => {
    const t = setup();
    t.check.start();
    t.hear(heard(1000, 2000));
    t.check.close();
    t.clock.advance(PASSED_HOLD_MS);
    await flush();
    expect(t.sent).toEqual([]);
  });

  it("resumed (the Start click came before this screen mounted): the first attempt runs at once", () => {
    const t = setup({ resumed: true });
    expect(t.check.snapshot.attempts).toBe(1);
    t.hear(heard(400, 500));
    expect(t.check.snapshot.result?.speechMs).toBe(400);
  });
});

/* ─── the screen ─── */

const MIC_CHECK = {
  seq: 1,
  phase: "onboarding",
  onboardingSteps: ["consent", "mic_check"],
  me: { seat: 2, consent: "given", nextStep: "mic_check", withdrawn: false },
  audio: {
    enabled: true,
    record: true,
    notRecording: null,
    paused: false,
    micCheck: "pending",
    micCheckHeld: false,
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

describe("MicCheckScreen", () => {
  // a browser that can record (the server render has no window)
  beforeEach(() => {
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => {} } });
    vi.stubGlobal("AudioContext", class {});
    vi.stubGlobal("AudioWorkletNode", class {});
  });
  afterEach(() => vi.unstubAllGlobals());

  function screen(gesture: boolean) {
    const conn = new PlayerConnection({
      socket: new FakeSocket().asSocket(),
      local: memoryStorage(),
      session: memoryStorage(),
      createRecorder: () => {
        throw new Error("not in a server render");
      },
    });
    // the recorder's state as RecordingController publishes it
    conn.recording.store.set({
      status: {
        state: gesture ? "recording" : "idle",
        trackId: null,
        error: null,
        needsGesture: false,
        muted: false,
      },
      gesture,
      contextSampleRate: null,
    });
    const html = renderToString(createElement(MicCheckScreen, { conn, view: MIC_CHECK }));
    conn.telemetry.dispose();
    conn.clock.stop();
    return html;
  }

  it("asks for the Start click first; mounted again after it (a detached session came back) goes on listening", () => {
    expect(screen(false)).toContain("Start mic check");
    // the regression: a fresh mount showed "Start mic check" while the recorder was already recording
    const html = screen(true);
    expect(html).not.toContain("Start mic check");
    expect(html).toContain("Read this aloud");
  });
});
