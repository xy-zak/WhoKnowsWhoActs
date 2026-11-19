import {
  AUDIO_CONSENT_ITEM,
  type EventType,
  type PayloadOf,
  type SeatMicStats,
  SessionConfigSchema,
  type StoredEvent,
} from "@wkwa/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EventLog, TEST_MAP } from "../../../packages/shared/test/helpers";
import {
  audioSpans,
  backlogTone,
  calibrationAdvice,
  calibrationSummary,
  chunkAge,
  micCell,
  micCheckStatus,
  micsSummary,
  nextBacklogTrend,
  wrapUpAudioCheck,
} from "../src/facilitator/audioLive";
import { summarise } from "../src/facilitator/EventLog";
import { CalibrationCard } from "../src/facilitator/live/AudioPanels";

const code = (seat: number) => `WK-TEST-000${seat}-X`;
const TRACK = "3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b";
const SETTINGS = {
  sampleRate: 48000,
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};
const MIC_OK = {
  passed: true,
  attempts: 1,
  durationMs: 9000,
  settings: SETTINGS,
  noiseFloorDb: -58.2,
  speechDb: -21.7,
  speechMs: 2840,
};

/** An audio session in onboarding: 4 real seats bound, all consented with audio; optionally mic checks passed. */
function audioSession(opts: { consented?: number[]; checked?: number[]; fake?: number[] } = {}): EventLog {
  const log = new EventLog();
  const config = SessionConfigSchema.parse({ audio: { enabled: true } });
  log.push(
    "SessionCreated",
    {
      config,
      scenario: { id: "test", title: "Test", version: "1", hash: "test" },
      ...TEST_MAP,
      viewIds: ["Ka", "Kb", "Kc", "Kd"],
      harness: { version: "0", gitCommit: "test" },
      notes: "",
    },
    { actor: "facilitator" },
  );
  for (let seat = 1; seat <= 4; seat++) {
    const fake = opts.fake?.includes(seat) ?? false;
    log.push(
      "SeatBound",
      { seat, terminal: seat, bindingId: `b${seat}`, fake },
      { seat, code: fake ? null : code(seat), actor: "facilitator" },
    );
  }
  log.push(
    "OnboardingStarted",
    { steps: ["consent", "mic_check", "demographics", "briefing"] },
    { actor: "facilitator" },
  );
  for (const seat of opts.consented ?? [1, 2, 3, 4]) {
    if (opts.fake?.includes(seat)) continue;
    log.push("ConsentRecorded", fullConsent(), { seat, code: code(seat), actor: "player" });
  }
  for (const seat of opts.checked ?? [])
    log.push("MicCheckCompleted", MIC_OK, { seat, code: code(seat), actor: "player" });
  return log;
}

const fullConsent = () => ({
  formVersion: "1",
  textSha256: "x",
  answers: { participate: true, [AUDIO_CONSENT_ITEM]: true },
  consented: true,
  durationMs: 1,
});

const mic = (over: Partial<SeatMicStats> = {}): SeatMicStats => ({
  state: "recording",
  rmsDb: -32,
  peakDb: -12,
  lastChunkServerTs: 1_000_000,
  pendingChunks: 0,
  tracks: 1,
  recordedMs: 90_000,
  ...over,
});

/** A stored event for summarise() (no participant code). */
function ev<T extends EventType>(type: T, payload: PayloadOf<T>, seat: number | null = null): StoredEvent {
  return {
    sessionId: "S-TEST-0001",
    seq: 1,
    type,
    actorKind: "system",
    seat,
    participantCode: null,
    round: 0,
    serverTs: 1_700_000_000_000,
    serverWall: "2023-11-14T22:13:20.000Z",
    clientTs: null,
    clientSeq: null,
    payload,
  } as StoredEvent;
}
const say = (e: StoredEvent) => summarise(e, (id) => id);

describe("mic column state", () => {
  it("maps the browser's state, idle → off, and the facilitator's pause and skip", () => {
    const log = audioSession({ checked: [1, 2] });
    const st = log.state;
    expect(micCell(st, st.seats[1]!, mic()).state).toBe("recording");
    expect(micCell(st, st.seats[1]!, mic()).db).toBe(-32);
    expect(micCell(st, st.seats[1]!, mic({ state: "idle" })).state).toBe("off");
    expect(micCell(st, st.seats[1]!, undefined).state).toBe("off");
    expect(micCell(st, st.seats[1]!, mic({ state: "denied" })).state).toBe("denied");
    expect(micCell(st, st.seats[1]!, mic({ state: "denied" })).db).toBeNull();
    expect(micCell(st, st.seats[1]!, mic({ state: "no_signal" })).db).toBe(-32);

    log.push("MicCheckSkipped", { seat: 3, reason: "no working microphone" }, { actor: "facilitator" });
    expect(micCell(log.state, log.state.seats[3]!, mic()).state).toBe("skipped");

    log.push("RecordingPaused", { reason: "break" }, { actor: "facilitator" });
    expect(micCell(log.state, log.state.seats[1]!, mic()).state).toBe("paused");
    expect(micCell(log.state, log.state.seats[3]!, mic()).state).toBe("skipped");
  });

  it("is off before consent, for fake players and for a seat without audio consent", () => {
    const log = audioSession({ consented: [1], fake: [4] });
    log.push(
      "ConsentRecorded",
      { formVersion: "1", textSha256: "x", answers: { participate: true }, consented: true, durationMs: 1 },
      { seat: 2, code: code(2), actor: "player" },
    );
    const st = log.state;
    expect(micCell(st, st.seats[3]!, undefined)).toMatchObject({ state: "off" });
    expect(micCell(st, st.seats[3]!, undefined).tip).toMatch(/after consent/);
    expect(micCell(st, st.seats[4]!, mic()).tip).toMatch(/fake/);
    expect(micCell(st, st.seats[2]!, mic()).tip).toMatch(/did not permit audio/);
  });

  it("names the seat's own reason before a pause: its consent, or the consent hold", () => {
    const log = audioSession({ consented: [1, 2, 3] });
    const tip = (seat: number) => micCell(log.state, log.state.seats[seat]!, undefined).tip;
    expect(tip(1)).toMatch(/wait until every seat has finished consent/);
    expect(tip(4)).toMatch(/after consent/);
    // a pause does not hide why a seat would not record anyway
    log.push("RecordingPaused", {}, { actor: "facilitator" });
    expect(micCell(log.state, log.state.seats[1]!, mic()).state).toBe("recording");
    expect(tip(1)).toMatch(/wait until every seat has finished consent/);
    expect(tip(4)).toMatch(/after consent/);
    log.push("ConsentRecorded", fullConsent(), { seat: 4, code: code(4), actor: "player" });
    expect(micCell(log.state, log.state.seats[1]!, mic())).toMatchObject({ state: "paused", db: null });
  });

  it("shows the mic check status of consented seats", () => {
    const st = audioSession({ checked: [1] }).state;
    expect(micCheckStatus(st, st.seats[1]!)).toBe("passed");
    expect(micCheckStatus(st, st.seats[2]!)).toBe("pending");
    const before = audioSession({ consented: [] }).state;
    expect(micCheckStatus(before, before.seats[1]!)).toBeNull();
  });

  it("warns for a large or growing upload backlog", () => {
    let t = nextBacklogTrend(undefined, 0);
    t = nextBacklogTrend(t, 1);
    expect(t.growing).toBe(true);
    expect(backlogTone(1, t.growing)).toBe("neutral");
    t = nextBacklogTrend(t, 2);
    expect(backlogTone(2, t.growing)).toBe("warn");
    // the same reading again keeps the trend (dashboards also arrive for other reasons)
    expect(nextBacklogTrend(t, 2)).toBe(t);
    t = nextBacklogTrend(t, 1);
    expect(backlogTone(1, t.growing)).toBe("neutral");
    expect(backlogTone(3, false)).toBe("warn");
  });

  it("flags a stale last chunk only while recording", () => {
    expect(chunkAge(mic(), 1_010_000)).toEqual({ ageMs: 10_000, stale: false });
    expect(chunkAge(mic(), 1_020_000)).toEqual({ ageMs: 20_000, stale: true });
    expect(chunkAge(mic({ state: "paused" }), 1_020_000).stale).toBe(false);
    expect(chunkAge(mic({ lastChunkServerTs: null }), 1_020_000)).toEqual({ ageMs: null, stale: false });
  });
});

describe("status bar mic count", () => {
  it("counts the seats recording against the seats that should record", () => {
    const st = audioSession({ checked: [1, 2, 3, 4] }).state;
    const s = micsSummary(st, { 1: mic(), 2: mic(), 3: mic({ state: "no_signal" }), 4: undefined });
    expect(s).toMatchObject({ show: true, paused: false, recording: 2, expected: 4, missing: [3, 4] });
  });

  it("expects nothing while a seat is still in consent, and reports a pause", () => {
    const log = audioSession({ consented: [1, 2, 3] });
    expect(micsSummary(log.state, {}).expected).toBe(0);
    const all = audioSession();
    all.push("RecordingPaused", {}, { actor: "facilitator" });
    const s = micsSummary(all.state, {});
    expect(s.paused).toBe(true);
    expect(s.expected).toBe(4);
  });
});

describe("calibration advice", () => {
  it("gives plain advice per failing seat", () => {
    expect(calibrationAdvice({ seat: 1, ownDb: -22, bestOtherDb: -39, marginDb: 17, ok: true })).toBeNull();
    expect(calibrationAdvice({ seat: 3, ownDb: -30.1, bestOtherDb: -34.2, marginDb: 4.1, ok: false })).toBe(
      "Seat 3: own voice only +4.1 dB over the others. Check the headset is plugged in, chosen as microphone and its mic sits at the corner of the mouth, then redo the calibration.",
    );
    expect(calibrationAdvice({ seat: 4, ownDb: null, bestOtherDb: null, marginDb: null, ok: false })).toMatch(
      /^No audio from seat 4/,
    );
    expect(calibrationAdvice({ seat: 2, ownDb: -20, bestOtherDb: -35, marginDb: 15, ok: false })).toMatch(
      /hard to tell apart/,
    );
  });

  it("sums the calibration up in one tag: not run, who reads now, checking, the verdict", () => {
    const log = audioSession({ checked: [1, 2] });
    expect(calibrationSummary(log.state)).toMatchObject({ tone: "warn", text: "not run yet" });
    log.push(
      "CalibrationStarted",
      { order: [2, 1], sentenceIds: ["s1", "s2"], turnMs: 6000, gapMs: 1000 },
      { actor: "facilitator" },
    );
    expect(calibrationSummary(log.state).text).toBe("running · starting");
    log.push("CalibrationTurn", { index: 1, seat: 1, sentenceId: "s2" });
    expect(calibrationSummary(log.state)).toMatchObject({
      tone: "live",
      text: "running · seat 1 reading (2/2)",
    });
    log.push("CalibrationCompleted", { turns: [] });
    expect(calibrationSummary(log.state).text).toBe("done · checking the audio");
    log.push("CalibrationChecked", {
      perSeat: [
        { seat: 1, ownDb: -22, bestOtherDb: -40, marginDb: 18, ok: true },
        { seat: 2, ownDb: -22, bestOtherDb: -40, marginDb: 18, ok: true },
      ],
      ok: true,
    });
    expect(calibrationSummary(log.state)).toMatchObject({ tone: "live", text: "done · separation ok" });
  });

  it("renders the quality card: checking…, then the margins, verdicts and advice", () => {
    const log = audioSession({ checked: [1, 2, 3, 4] });
    log.push(
      "CalibrationStarted",
      { order: [1, 2, 3, 4], sentenceIds: ["s1", "s2", "s3", "s4"], turnMs: 6000, gapMs: 1000 },
      { actor: "facilitator" },
    );
    const render = () => renderToStaticMarkup(createElement(CalibrationCard, { st: log.state }));
    log.push("CalibrationTurn", { index: 0, seat: 1, sentenceId: "s1" });
    expect(render()).toContain("calibrating");
    expect(render()).toContain("Turn 1/4: seat 1 reads");
    log.push("CalibrationCompleted", { turns: [] });
    expect(render()).toContain("checking…");
    log.push("CalibrationChecked", {
      perSeat: [
        { seat: 1, ownDb: -22.4, bestOtherDb: -38.9, marginDb: 16.5, ok: true },
        { seat: 3, ownDb: -30.1, bestOtherDb: -34.2, marginDb: 4.1, ok: false },
        { seat: 4, ownDb: null, bestOtherDb: null, marginDb: null, ok: false },
      ],
      ok: false,
    });
    const html = render();
    expect(html).toContain("needs attention");
    expect(html).toContain("No audio from seat 4");
    expect(html).toContain("+16.5 dB");
  });

  it("is hidden while pending, and says so when the server cancelled a run", () => {
    const log = audioSession({ checked: [1, 2, 3, 4] });
    const render = () => renderToStaticMarkup(createElement(CalibrationCard, { st: log.state }));
    expect(render()).toBe("");
    log.push(
      "CalibrationStarted",
      { order: [1, 2, 3, 4], sentenceIds: ["s1", "s2", "s3", "s4"], turnMs: 6000, gapMs: 1000 },
      { actor: "facilitator" },
    );
    log.push("CalibrationSkipped", { reason: "recording paused", cancelled: true });
    expect(log.state.audio.calibration.status).toBe("pending");
    expect(render()).toContain("cancelled");
  });
});

describe("wrap-up audio check", () => {
  const track = (
    seat: number,
    over: Partial<{ status: string; stopReason: string | null; gaps: number }> = {},
  ) => ({
    seat,
    status: "closed" as const,
    stopReason: "game_complete",
    gaps: 0,
    ...over,
  });

  it("is uploaded when every track is closed and nothing is pending", () => {
    const st = audioSession({ checked: [1, 2, 3, 4] }).state;
    const tracks = [1, 2, 3, 4].map((s) => track(s));
    expect(wrapUpAudioCheck(st, {}, tracks)).toEqual({ uploaded: true, lines: [] });
    expect(wrapUpAudioCheck(st, {}, null).uploaded).toBe(false);
  });

  it("lists uploads still on their way and interrupted or missing audio", () => {
    const st = audioSession({ checked: [1, 2, 3, 4] }).state;
    const tracks = [
      track(1),
      track(2),
      track(3, { status: "open" as never, stopReason: null }),
      track(4, { status: "interrupted" as never, stopReason: "disconnect" }),
      track(4, { gaps: 2 }),
    ] as Parameters<typeof wrapUpAudioCheck>[2];
    const r = wrapUpAudioCheck(st, { 2: mic({ pendingChunks: 3 }) }, tracks);
    expect(r.uploaded).toBe(false);
    expect(r.lines.map((l) => l.text)).toEqual([
      "Seat 2 still uploading 3 chunks: keep that browser open.",
      "Seat 3: track still open (the browser has not finished): keep that browser open.",
      "Seat 4: track interrupted (disconnected).",
      "Seat 4: 2 chunks missing from the stored audio.",
    ]);
  });

  it("does not expect audio from a seat that withdrew", () => {
    const log = audioSession({ checked: [1, 2, 3] });
    log.push(
      "ParticipantWithdrawn",
      { seat: 4, by: "facilitator", phase: "onboarding" },
      { actor: "facilitator" },
    );
    expect(wrapUpAudioCheck(log.state, {}, [track(1), track(2), track(3)]).lines).toEqual([]);
  });

  it("notes a recorded seat without any audio, but not a skipped one", () => {
    const log = audioSession({ checked: [1, 2, 3] });
    log.push("MicCheckSkipped", { seat: 4, reason: "no microphone" }, { actor: "facilitator" });
    const r = wrapUpAudioCheck(log.state, {}, [track(1), track(2)]);
    expect(r.lines).toEqual([{ seat: 3, kind: "issue", text: "Seat 3: no audio recorded." }]);
    expect(r.uploaded).toBe(true);
  });
});

describe("timeline audio spans", () => {
  it("pairs track starts and stops, pauses, and the calibration with its logged turn windows", () => {
    const log = audioSession({ checked: [1] });
    const T2 = "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";
    log.push(
      "AudioTrackStarted",
      { trackId: TRACK, sampleRate: 16000, settings: SETTINGS, reason: "mic_check" },
      { seat: 1, code: code(1), actor: "player" },
    );
    log.push(
      "CalibrationStarted",
      { order: [1], sentenceIds: ["s1"], turnMs: 6000, gapMs: 1000 },
      { actor: "facilitator" },
    );
    log.push("CalibrationTurn", { index: 0, seat: 1, sentenceId: "s1" });
    const turnTs = log.events.at(-1)!.serverTs;
    log.push("CalibrationCompleted", {
      turns: [{ seat: 1, sentenceId: "s1", startTs: turnTs, endTs: turnTs + 6000 }],
    });
    log.push("RecordingPaused", { reason: "break" }, { actor: "facilitator" });
    log.push(
      "AudioTrackStopped",
      { trackId: TRACK, reason: "paused", samples: 160000, chunks: 2, droppedChunks: 0 },
      { seat: 1, code: code(1), actor: "player" },
    );
    log.push("RecordingResumed", {}, { actor: "facilitator" });
    log.push(
      "AudioTrackStarted",
      { trackId: T2, sampleRate: 16000, settings: SETTINGS, reason: "resume" },
      { seat: 1, code: code(1), actor: "player" },
    );
    const a = audioSpans(log.events);
    expect(a.firstTs).toBe(log.events.find((e) => e.type === "AudioTrackStarted")!.serverTs);
    expect(a.tracks).toHaveLength(2);
    expect(a.tracks[0]).toMatchObject({ seat: 1, reason: "mic_check", stopReason: "paused" });
    expect(a.tracks[0]!.e).not.toBeNull();
    expect(a.tracks[1]).toMatchObject({ reason: "resume", e: null });
    expect(a.pauses).toEqual([expect.objectContaining({ reason: "break" })]);
    expect(a.pauses[0]!.e).not.toBeNull();
    expect(a.calibrations).toHaveLength(1);
    expect(a.turns).toEqual([{ seat: 1, s: turnTs, e: turnTs + 6000 }]);
  });

  it("has no lanes without audio events", () => {
    expect(audioSpans([]).firstTs).toBeNull();
  });
});

describe("event log one-liners for audio events", () => {
  const PER_SEAT = [
    { seat: 1, ownDb: -22.4, bestOtherDb: -38.9, marginDb: 16.5, ok: true },
    { seat: 3, ownDb: -30.1, bestOtherDb: -34.2, marginDb: 4.1, ok: false },
    { seat: 4, ownDb: null, bestOtherDb: null, marginDb: null, ok: false },
  ];
  const stopped = (reason: "paused" | "disconnect", samples: number, chunks: number, droppedChunks: number) =>
    ev("AudioTrackStopped", { trackId: TRACK, reason, samples, chunks, droppedChunks });
  it.each<[string | RegExp, StoredEvent]>([
    // mic checks
    [
      "mic check passed (1 attempt) · speech −22 dB for 2.8 s, background −58 dB",
      ev("MicCheckCompleted", MIC_OK, 2),
    ],
    [
      /^mic check NOT passed \(2 attempts\)/,
      ev("MicCheckCompleted", { ...MIC_OK, passed: false, attempts: 2 }, 2),
    ],
    [
      "mic check of seat 3 skipped: “no working microphone” · not recorded",
      ev("MicCheckSkipped", { seat: 3, reason: "no working microphone" }),
    ],
    // tracks, with a short id only
    [
      "track 3f2a9c1e started (reconnect)",
      ev(
        "AudioTrackStarted",
        { trackId: TRACK, sampleRate: 16000, settings: SETTINGS, reason: "reconnect" },
        1,
      ),
    ],
    [
      "track 3f2a9c1e stopped (recording paused) · 10:00 stored in 120 chunks",
      stopped("paused", 9_600_000, 120, 0),
    ],
    [
      "track 3f2a9c1e stopped (disconnected) · 0:05 stored in 1 chunk, 2 DROPPED (audio missing)",
      stopped("disconnect", 80_000, 1, 2),
    ],
    // the calibration
    [
      "calibration started · order seat 1 → 2 → 3 → 4 · 6 s turns, 1 s gaps",
      ev("CalibrationStarted", {
        order: [1, 2, 3, 4],
        sentenceIds: ["a", "b", "c", "d"],
        turnMs: 6000,
        gapMs: 1000,
      }),
    ],
    [
      "turn 3: seat 3 reads sentence h01-03",
      ev("CalibrationTurn", { index: 2, seat: 3, sentenceId: "h01-03" }),
    ],
    [/^calibration complete · 0 turns/, ev("CalibrationCompleted", { turns: [] })],
    [
      "calibration NOT OK · own voice over the loudest other mic: seat 1 +16.5 dB ✓, seat 3 +4.1 dB ✗, seat 4 no audio ✗",
      ev("CalibrationChecked", { perSeat: PER_SEAT, ok: false }),
    ],
    [
      "calibration skipped: “everyone uses a headset”",
      ev("CalibrationSkipped", { reason: "everyone uses a headset" }),
    ],
    [
      "calibration cancelled (recording paused) · it has to be run again",
      ev("CalibrationSkipped", { reason: "recording paused", cancelled: true }),
    ],
    // recording pauses
    ["recording paused for everyone: “break”", ev("RecordingPaused", { reason: "break" })],
    ["recording paused for everyone", ev("RecordingPaused", {})],
    ["recording resumed for everyone", ev("RecordingResumed", {})],
  ])("%s", (text, e) => {
    if (typeof text === "string") expect(say(e)).toBe(text);
    else expect(say(e)).toMatch(text);
  });
});
