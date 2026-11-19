import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AUDIO_CONSENT_ITEM,
  AUDIO_LATE_CHUNK_GRACE_MS,
  AUDIO_SAMPLE_RATE,
  type AudioAck,
  type PlayerView,
  playerView,
  type SessionConfigInput,
  type StoredEvent,
} from "@wkwa/shared";
import pino from "pino";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AudioFileStore } from "../src/audio/fileStore";
import type { AudioStartMsg } from "../src/audio/live";
import { trackStatusOf } from "../src/audio/records";
import { verifyAudio } from "../src/audio/verify";
import { loadOnboardingContent, ScenarioLibrary, sha256 } from "../src/content";
import { openDatabase } from "../src/db/database";
import { Store } from "../src/db/store";
import { REPO_ROOT } from "../src/runtime";
import { CALIBRATION_CHECK_WAIT_MS, CommandError, SessionManager } from "../src/session/SessionManager";
import { Bot, FacilitatorClient } from "../src/tools/botClient";
import { readTrackPcm } from "./audioFixtures";
import { cleanup, PASSPHRASE, setupSession, startTestServer, type TestServer } from "./harness";

const CONFIG_DIR = path.join(REPO_ROOT, "config");
const SCENARIOS = new ScenarioLibrary(path.join(REPO_ROOT, "scenarios"));
const SETTINGS = {
  sampleRate: 48_000,
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 1,
};
const ROUND = { rule: "quota" as const, quota: { propose: 1, decide: 1 }, timeLimitSec: null };

/* ─────────────────────────── helpers ─────────────────────────── */

/** Speech-like noise (4 Hz syllables) at `db` dBFS over a noise floor; deterministic per seed. */
function pcm(n: number, db: number | null, seed = 1, floorDb = -60): Buffer {
  const out = Buffer.alloc(n * 2);
  let x = seed * 2654435761;
  const rnd = () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) / 4294967296) * 2 - 1;
  };
  const voice = db === null ? 0 : 32768 * 10 ** (db / 20);
  const floor = 32768 * 10 ** (floorDb / 20);
  for (let i = 0; i < n; i++) {
    const syl = 0.5 + 0.5 * Math.sin((2 * Math.PI * 4 * i) / AUDIO_SAMPLE_RATE);
    const v = rnd() * (floor + voice * syl * syl * 1.7);
    out.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v))), i * 2);
  }
  return out;
}

function chunkMsg(trackId: string, seq: number, samples: number, clientTs: number, data?: Buffer) {
  return {
    trackId,
    seq,
    startSample: seq * samples,
    sampleCount: samples,
    clientTs,
    clockOffsetMs: 0,
    rmsDb: -30,
    peakDb: -10,
    clippedSamples: 0,
    pcm: data ?? pcm(samples, -20, seq + 1),
  };
}

function startMsg(trackId: string = randomUUID(), clientTs = Date.now()): AudioStartMsg {
  return {
    trackId,
    reason: "mic_check" as const,
    sampleRate: AUDIO_SAMPLE_RATE,
    settings: SETTINGS,
    clientTs,
    clockOffsetMs: 0,
  };
}

/** All files under a folder (recursive). */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

interface Direct {
  m: SessionManager;
  store: Store;
  files: AudioFileStore;
  dir: string;
  events: StoredEvent[];
  close(): void;
}

/** A SessionManager on its own encrypted database, driven directly (no sockets). */
function direct(
  config: SessionConfigInput = { audio: { enabled: true } },
  opts: { clock?: () => number; sim?: boolean } = {},
): Direct {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wkwa-live-"));
  const db = openDatabase(path.join(dir, "wkwa.db"), PASSPHRASE);
  const files = new AudioFileStore(path.join(dir, "audio"));
  const store = new Store(db, opts.sim ? null : files);
  const events: StoredEvent[] = [];
  const audio = config.players !== "simulated" && config.audio?.enabled === true;
  const m = SessionManager.create(
    {
      store,
      scenario: SCENARIOS.load("demo"),
      onboarding: loadOnboardingContent(CONFIG_DIR, { audio }),
      serverSecret: "test-secret",
      log: pino({ level: "silent" }),
      onEvents: (e) => events.push(...e),
      clock: opts.clock,
    },
    { seatCount: 2, roundCount: 1, defaultRound: ROUND, ...config } as never,
    "live audio test",
  );
  return {
    m,
    store,
    files,
    dir,
    events,
    close() {
      m.dispose();
      db.close();
      cleanup(dir);
    },
  };
}

/** Bind seats (seat n on terminal n; `fake` seats as fake players), assign labels, start onboarding. */
function onboard(m: SessionManager, fake: number[] = []) {
  for (const s of Object.keys(m.state.seats).map(Number))
    m.bindSeat(s, s, fake.includes(s) ? { fake: true } : {});
  m.randomiseLabels();
  m.startOnboarding();
}

function consent(m: SessionManager, seat: number, audio = true, all = true) {
  const c = m.onboarding.consent;
  m.submitConsent(seat, {
    formVersion: c.version,
    textSha256: c.sha256,
    answers: Object.fromEntries(c.items.map((i) => [i.id, i.id === AUDIO_CONSENT_ITEM ? audio : all])),
    durationMs: 1000,
    clientTs: Date.now(),
  });
}

const MIC_OK = {
  passed: true,
  attempts: 1,
  durationMs: 1000,
  settings: SETTINGS,
  noiseFloorDb: -60,
  speechDb: -20,
  speechMs: 1500,
  clientTs: 0,
};

function finishOnboarding(m: SessionManager, seat: number) {
  const o = m.onboarding;
  m.submitDemographics(seat, {
    formVersion: o.demographics.version,
    answers: Object.fromEntries(o.demographics.questions.map((q) => [q.id, q.options[0]!.value])),
    durationMs: 1,
    clientTs: 0,
  });
  m.acknowledgeBriefing(seat, { textSha256: o.briefing.sha256, durationMs: 1, clientTs: 0 });
}

const types = (events: readonly StoredEvent[]) => events.map((e) => e.type);
const view = (m: SessionManager, seat: number) =>
  playerView(m.state, m.scenario, seat, m.onboarding, Date.now());
const refused = (a: AudioAck<unknown>) => !a.ok && !a.retry;

/* ─────────────────────────── consent composition ─────────────────────────── */

describe("consent composed per session", () => {
  it("adds the audio section and the required audio item only when the session records audio", () => {
    const off = loadOnboardingContent(CONFIG_DIR);
    const on = loadOnboardingContent(CONFIG_DIR, { audio: true });
    expect(off.consent.items.map((i) => i.id)).not.toContain(AUDIO_CONSENT_ITEM);
    expect(on.consent.items.find((i) => i.id === AUDIO_CONSENT_ITEM)).toMatchObject({ required: true });
    expect(off.consent.markdown).not.toContain("Audio recording");
    expect(on.consent.markdown).toContain("## Audio recording");
    for (const c of [off, on]) expect(c.consent.markdown).not.toMatch(/<!--\s*(if|end)/);
    // the text no longer claims something that is false with audio on
    expect(on.consent.markdown).not.toMatch(/no[^.]*device information/i);
    // version and hash identify the composed text
    expect(on.consent.version).toBe(`${off.consent.version}+audio`);
    expect(on.consent.sha256).not.toBe(off.consent.sha256);
    expect(on.consent.sha256).toBe(
      sha256(JSON.stringify({ md: on.consent.markdown, items: on.consent.items, study: on.study })),
    );
    expect(off.audio).toBeUndefined();
    expect(on.audio?.calibration.sentences.length).toBeGreaterThanOrEqual(4);
  });

  it("refuses an audio session whose consent form lacks the required audio item", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "wkwa-cfg-"));
    try {
      cpSync(CONFIG_DIR, dir, { recursive: true });
      const form = JSON.parse(readFileSync(path.join(dir, "consent.json"), "utf8"));
      form.items = form.items.filter((i: { id: string }) => i.id !== AUDIO_CONSENT_ITEM);
      writeFileSync(path.join(dir, "consent.json"), JSON.stringify(form));
      expect(() => loadOnboardingContent(dir, { audio: true })).toThrow(/audio_recording/);
      expect(() => loadOnboardingContent(dir)).not.toThrow();
    } finally {
      cleanup(dir);
    }
  });

  it("records the composed version and hash with the participant's answers", () => {
    const d = direct();
    try {
      onboard(d.m);
      consent(d.m, 1);
      const ev = d.events.find((e) => e.type === "ConsentRecorded")!;
      expect(ev.payload).toMatchObject({
        formVersion: d.m.onboarding.consent.version,
        textSha256: d.m.onboarding.consent.sha256,
        consented: true,
        answers: { [AUDIO_CONSENT_ITEM]: true },
      });
      expect(d.m.onboarding.consent.version).toMatch(/\+audio$/);
    } finally {
      d.close();
    }
  });
});

/* ─────────────────────────── steps, hold, mic check ─────────────────────────── */

describe("onboarding with audio: consent hold and mic check", () => {
  let d: Direct;
  afterEach(() => d.close());

  it("adds the mic check after consent and holds it until every real seat has consented", async () => {
    d = direct({ audio: { enabled: true }, seatCount: 3 });
    onboard(d.m, [3]); // seat 3: a fake player, which never holds anybody
    expect(d.m.state.onboardingSteps).toEqual(["consent", "mic_check", "demographics", "briefing"]);
    consent(d.m, 1);
    expect(d.m.state.seats[1]!.audioConsent).toBe(true);
    // seat 2 is still reading the consent form: seat 1 may not open its mic
    expect(() => d.m.submitMicCheck(1, MIC_OK)).toThrow(/consent/);
    const held = await d.m.audio.start(1, startMsg());
    expect(refused(held)).toBe(true);
    // a decline holds as well, until the facilitator withdraws that seat
    consent(d.m, 2, false);
    expect(d.m.state.seats[2]!.consent).toBe("declined");
    expect(refused(await d.m.audio.start(1, startMsg()))).toBe(true);
    d.m.withdraw(2);
    const t = randomUUID();
    expect(await d.m.audio.start(1, startMsg(t))).toEqual({ ok: true });
    d.m.submitMicCheck(1, MIC_OK);
    expect(d.m.state.seats[1]!.micCheck).toBe("passed");
    expect(types(d.events)).toContain("AudioTrackStarted");
    expect(types(d.events)).toContain("MicCheckCompleted");
    // a failed check leaves the step open
    expect(() => d.m.submitMicCheck(1, MIC_OK)).toThrow(/Please complete|already/);
  });

  it("lets the facilitator skip a mic check: the seat continues and is not recorded", async () => {
    d = direct();
    onboard(d.m);
    consent(d.m, 1);
    consent(d.m, 2);
    const t = randomUUID();
    expect((await d.m.audio.start(2, startMsg(t))).ok).toBe(true);
    d.m.skipMicCheck(2, "no working microphone");
    expect(d.m.state.seats[2]!.micCheck).toBe("skipped");
    // its open track is closed and further audio refused
    expect(d.store.getAudioTrack(t)).toMatchObject({ status: "closed", stopReason: "skipped" });
    expect(refused(await d.m.audio.start(2, startMsg()))).toBe(true);
    expect(refused(await d.m.audio.chunk(2, chunkMsg(t, 0, 1600, Date.now())))).toBe(true);
    expect(() => d.m.skipMicCheck(2, "again")).toThrow(/already/);
    finishOnboarding(d.m, 2);
    expect(d.m.state.seats[2]!.briefing).toBe(true);
  });

  it("never records without the audio item, fake players, or sessions without audio", async () => {
    d = direct();
    onboard(d.m, [2]);
    expect(d.m.state.seats[2]!.consent).toBe("skipped");
    expect(d.m.state.seats[2]!.audioConsent).toBe(false);
    expect(refused(await d.m.audio.start(2, startMsg()))).toBe(true);
    consent(d.m, 1, false, true); // required audio item unticked: declined
    expect(refused(await d.m.audio.start(1, startMsg()))).toBe(true);
    d.close();
    d = direct({ audio: { enabled: false } });
    onboard(d.m);
    expect(d.m.state.onboardingSteps).not.toContain("mic_check");
    consent(d.m, 1);
    const a = await d.m.audio.start(1, startMsg());
    expect(a).toMatchObject({ ok: false, retry: false });
    expect(() => d.m.submitMicCheck(1, MIC_OK)).toThrow(CommandError);
    expect(d.store.listAudioTracks(d.m.sessionId)).toEqual([]);
  });

  it("never records a simulated session, even if its draft had audio on", async () => {
    d = direct({ players: "simulated", audio: { enabled: true } }, { sim: true });
    expect(d.m.state.audio.enabled).toBe(false);
    d.m.randomiseLabels();
    d.m.startSimulation();
    expect(refused(await d.m.audio.start(1, startMsg()))).toBe(true);
    expect(d.store.listAudioTracks(d.m.sessionId)).toEqual([]);
  });

  it("refuses an audio session in a database without an audio store", () => {
    expect(() => direct({ audio: { enabled: true } }, { sim: true })).toThrow(/cannot store audio/);
  });
});

/* ─────────────────────────── ingest ─────────────────────────── */

describe("chunk ingest", () => {
  let d: Direct;
  let now = 1_800_000_000_000;
  const clock = () => now;
  afterEach(() => d.close());

  async function recording(): Promise<string> {
    d = direct({ audio: { enabled: true } }, { clock });
    onboard(d.m);
    consent(d.m, 1);
    consent(d.m, 2);
    const t = randomUUID();
    expect(await d.m.audio.start(1, startMsg(t, now))).toEqual({ ok: true });
    return t;
  }

  it("stores out-of-order chunks once, acks resends, and refuses bad ones", async () => {
    const t = await recording();
    const N = 1600;
    const at = (seq: number) => now + (seq * N * 1000) / AUDIO_SAMPLE_RATE;
    now += 1000;
    for (const seq of [0, 2, 1]) {
      const a = await d.m.audio.chunk(1, chunkMsg(t, seq, N, at(seq)));
      expect(a).toEqual({ ok: true, data: { trackId: t, seq }, duplicate: false });
    }
    // a resend (lost ack) and two copies at once are stored once
    expect(await d.m.audio.chunk(1, chunkMsg(t, 1, N, at(1)))).toMatchObject({ ok: true, duplicate: true });
    const [x, y] = await Promise.all([
      d.m.audio.chunk(1, chunkMsg(t, 3, N, at(3))),
      d.m.audio.chunk(1, chunkMsg(t, 3, N, at(3))),
    ]);
    expect(x.ok && y.ok).toBe(true);
    expect(d.store.getAudioTrack(t)).toMatchObject({ chunks: 4, samples: 4 * N });
    // permanent refusals
    expect(refused(await d.m.audio.chunk(2, chunkMsg(t, 4, N, at(4))))).toBe(true); // another seat's track
    expect(refused(await d.m.audio.chunk(1, chunkMsg(randomUUID(), 0, N, now)))).toBe(true); // unknown
    expect(refused(await d.m.audio.chunk(1, { ...chunkMsg(t, 1_000_000, N, now), seq: 5 }))).toBe(true);
    expect(refused(await d.m.audio.chunk(1, { ...chunkMsg(t, 5, N, now), startSample: 10_000_000 }))).toBe(
      true,
    );
    expect(refused(await d.m.audio.chunk(1, chunkMsg(t, 5, N, now + 60_000)))).toBe(true); // future
    // the stored audio decrypts to what was sent, in seq order
    const back = await readTrackPcm(
      d.files,
      d.m.sessionId,
      d.store.getAudioTrack(t)!.fileName!,
      d.store.getAudioTrackKey(t)!,
    );
    expect(back.seqs).toEqual([0, 1, 2, 3]);
    expect(back.pcm.subarray(0, N * 2).equals(chunkMsg(t, 0, N, 0).pcm)).toBe(true);
    expect(d.m.audio.seatStats(1)).toMatchObject({ tracks: 1, recordedMs: 400 });
    // a second start of the same track (lost ack) is fine; another seat may not reuse the id
    expect(await d.m.audio.start(1, startMsg(t, now))).toMatchObject({ ok: true, duplicate: true });
    expect(refused(await d.m.audio.start(2, startMsg(t, now)))).toBe(true);
  });

  it("pause: closes the tracks, keeps in-flight audio up to the pause and nothing after it", async () => {
    const t = await recording();
    const N = 16_000; // 1 s chunks
    const t0 = now;
    now = t0 + 2500;
    d.m.pauseRecording("private conversation");
    expect(d.store.getAudioTrack(t)).toMatchObject({ status: "closed", stopReason: "paused" });
    expect(trackStatusOf(d.store.getAudioTrack(t)!)).toBe("closed");
    expect(d.events.filter((e) => e.type === "AudioTrackStopped").map((e) => e.payload)).toMatchObject([
      { trackId: t, reason: "paused" },
    ]);
    now += 2000;
    // captured before the pause: stored; the chunk running into the pause is cut at the pause
    expect((await d.m.audio.chunk(1, chunkMsg(t, 0, N, t0))).ok).toBe(true);
    expect((await d.m.audio.chunk(1, chunkMsg(t, 1, N, t0 + 1000))).ok).toBe(true);
    expect((await d.m.audio.chunk(1, chunkMsg(t, 2, N, t0 + 2000))).ok).toBe(true);
    const rows = d.store.listAudioChunks(t);
    expect(rows.map((r) => r.sampleCount)).toEqual([N, N, N / 2]);
    // captured after the pause: refused for good
    expect(refused(await d.m.audio.chunk(1, chunkMsg(t, 3, N, t0 + 3000)))).toBe(true);
    // no new track while paused
    expect(refused(await d.m.audio.start(1, startMsg(randomUUID(), now)))).toBe(true);
    expect(view(d.m, 1).audio).toMatchObject({ record: false, paused: true });
    d.m.resumeRecording();
    expect(types(d.events)).toContain("RecordingResumed");
    // the old track does not take audio captured during the pause, even after resuming
    expect(refused(await d.m.audio.chunk(1, chunkMsg(t, 3, N, t0 + 3000)))).toBe(true);
    const t2 = randomUUID();
    expect(await d.m.audio.start(1, { ...startMsg(t2, now), reason: "resume" })).toEqual({ ok: true });
    expect((await d.m.audio.chunk(1, chunkMsg(t2, 0, N, now))).ok).toBe(true);
    expect(() => d.m.resumeRecording()).toThrow(/not paused/);
  });

  it("disconnect: the server closes the track and accepts its late chunks for the grace period", async () => {
    const t = await recording();
    const N = 1600;
    d.m.playerConnected(1);
    d.m.playerDisconnected(1, "transport close");
    expect(d.store.getAudioTrack(t)).toMatchObject({ status: "closed", stopReason: "disconnect" });
    expect(trackStatusOf(d.store.getAudioTrack(t)!)).toBe("interrupted");
    now += 60_000;
    expect((await d.m.audio.chunk(1, chunkMsg(t, 0, N, now - 59_000))).ok).toBe(true);
    // the grace period runs from the last late chunk
    now += AUDIO_LATE_CHUNK_GRACE_MS - 1000;
    expect((await d.m.audio.chunk(1, chunkMsg(t, 1, N, now - 1000))).ok).toBe(true);
    now += AUDIO_LATE_CHUNK_GRACE_MS + 1;
    expect(refused(await d.m.audio.chunk(1, chunkMsg(t, 2, N, now - 1000)))).toBe(true);
    // the browser's own stop after reconnecting is fine and adds its dropped chunks
    expect(d.m.audio.stop(1, { trackId: t, reason: "disconnect", droppedChunks: 2 })).toEqual({ ok: true });
    expect(d.store.getAudioTrack(t)!.droppedChunks).toBe(2);
  });

  it("a track stopped by the browser still takes a resend for the grace period; a new start ends a forgotten one", async () => {
    const t = await recording();
    expect(d.m.audio.stop(1, { trackId: t, reason: "client_stop", droppedChunks: 0 })).toEqual({ ok: true });
    expect(d.events.at(-1)).toMatchObject({ type: "AudioTrackStopped", actorKind: "player" });
    expect((await d.m.audio.chunk(1, chunkMsg(t, 0, 1600, now))).ok).toBe(true);
    now += AUDIO_LATE_CHUNK_GRACE_MS + 1;
    expect(refused(await d.m.audio.chunk(1, chunkMsg(t, 1, 1600, now - 1000)))).toBe(true);
    const a = randomUUID();
    const b = randomUUID();
    await d.m.audio.start(1, startMsg(a, now));
    await d.m.audio.start(1, startMsg(b, now));
    expect(d.store.getAudioTrack(a)).toMatchObject({ status: "closed", stopReason: "interrupted" });
    expect(d.store.getAudioTrack(b)!.status).toBe("recording");
    expect(refused(d.m.audio.stop(2, { trackId: b, reason: "client_stop", droppedChunks: 0 }))).toBe(true);
  });

  it("withdrawal closes the seat's track at once and refuses all further audio", async () => {
    const t = await recording();
    d.m.withdraw(1);
    expect(d.store.getAudioTrack(t)).toMatchObject({ status: "closed", stopReason: "withdrawn" });
    expect(refused(await d.m.audio.chunk(1, chunkMsg(t, 0, 1600, now - 100)))).toBe(true);
    expect(refused(await d.m.audio.start(1, startMsg()))).toBe(true);
  });

  it("game complete cuts the recording; close and abort leave nothing open", async () => {
    const t = await recording();
    d.m.submitMicCheck(1, MIC_OK);
    finishOnboarding(d.m, 1);
    d.m.skipMicCheck(2, "test");
    finishOnboarding(d.m, 2);
    expect(d.m.canStartRound()).toMatch(/calibration/);
    expect(() => d.m.startRound()).toThrow(/calibration/);
    d.m.skipCalibration("everyone uses a headset");
    expect(d.m.canStartRound()).toBeNull();
    d.m.startRound();
    const t0 = now;
    now += 3000;
    d.m.endGame();
    expect(d.store.getAudioTrack(t)).toMatchObject({ status: "closed", stopReason: "game_complete" });
    // a late chunk running past the end is cut there; one captured after it is refused
    expect((await d.m.audio.chunk(1, chunkMsg(t, 0, 64_000, t0))).ok).toBe(true);
    expect(d.store.listAudioChunks(t)[0]!.sampleCount).toBe(48_000);
    expect(refused(await d.m.audio.chunk(1, chunkMsg(t, 1, 1600, t0 + 4000)))).toBe(true);
    d.m.close();
    expect(refused(await d.m.audio.chunk(1, chunkMsg(t, 2, 1600, t0)))).toBe(true);
    expect(d.store.listAudioTracks(d.m.sessionId, { status: "recording" })).toEqual([]);
  });

  it("abort closes open tracks before SessionAborted", async () => {
    const t = await recording();
    d.m.abort("test");
    expect(d.store.getAudioTrack(t)).toMatchObject({ status: "closed", stopReason: "aborted" });
    const tail = types(d.events).slice(-2);
    expect(tail).toEqual(["AudioTrackStopped", "SessionAborted"]);
  });

  it("recovery: a reload closes tracks left open as interrupted; their resent chunks still count", async () => {
    const t = await recording();
    const store = d.store;
    const reloaded = SessionManager.load(
      {
        store,
        scenario: SCENARIOS.load("demo"),
        onboarding: loadOnboardingContent(CONFIG_DIR, { audio: true }),
        serverSecret: "test-secret",
        log: pino({ level: "silent" }),
        onEvents: () => {},
        clock,
      },
      d.m.sessionId,
    );
    try {
      expect(store.getAudioTrack(t)).toMatchObject({ status: "closed", stopReason: "interrupted" });
      expect(store.listEvents(d.m.sessionId).at(-1)).toMatchObject({
        type: "AudioTrackStopped",
        payload: { reason: "interrupted" },
      });
      expect((await reloaded.audio.chunk(1, chunkMsg(t, 0, 1600, now))).ok).toBe(true);
      expect(reloaded.audio.seatStats(1).tracks).toBe(1);
    } finally {
      reloaded.dispose();
    }
  });
});

/* ─────────────────────────── calibration (fake timers) ─────────────────────────── */

describe("calibration state machine", () => {
  let d: Direct;
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  });
  afterAll(() => vi.useRealTimers());
  afterEach(() => d.close());

  async function ready(): Promise<string[]> {
    d = direct({ audio: { enabled: true } }, { clock: () => Date.now() });
    onboard(d.m);
    const tracks: string[] = [];
    for (const s of [1, 2]) consent(d.m, s);
    expect(() => d.m.startCalibration()).toThrow(/mic check of seat 1, 2/);
    for (const s of [1, 2]) {
      const t = randomUUID();
      tracks.push(t);
      expect((await d.m.audio.start(s, startMsg(t, Date.now() - 2000))).ok).toBe(true);
      d.m.submitMicCheck(s, MIC_OK);
      finishOnboarding(d.m, s);
    }
    return tracks;
  }

  it("times one turn per seat, completes, and checks the leakage from the turns' audio", async () => {
    const tracks = await ready();
    const T0 = Date.now() - 2000;
    d.m.startCalibration();
    const c = () => d.m.state.audio.calibration;
    expect(c()).toMatchObject({ status: "running", order: [1, 2], turnMs: 6000, gapMs: 1000, turnIndex: 0 });
    expect(view(d.m, 1).audio.calibration).toMatchObject({ myTurn: true, turnSeat: 1 });
    expect(view(d.m, 1).audio.calibration.sentence).toBeTruthy();
    expect(view(d.m, 2).audio.calibration).toMatchObject({ myTurn: false, sentence: null });
    expect(() => d.m.startRound()).toThrow(/calibration/);
    await vi.advanceTimersByTimeAsync(6999);
    expect(c().turnIndex).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(c()).toMatchObject({ turnIndex: 1 });
    await vi.advanceTimersByTimeAsync(6000);
    expect(c().status).toBe("done");
    const done = d.events.find((e) => e.type === "CalibrationCompleted")!;
    const turns = (done.payload as { turns: Array<{ seat: number; startTs: number; endTs: number }> }).turns;
    expect(turns.map((x) => [x.seat, x.endTs - x.startTs])).toEqual([
      [1, 6000],
      [2, 6000],
    ]);
    // the browsers upload their audio: each seat loud in its own turn, 22 dB quieter in the other's
    const N = AUDIO_SAMPLE_RATE / 2;
    for (const [i, seat] of [1, 2].entries()) {
      for (let seq = 0; seq * 500 < Date.now() + 1000 - T0; seq++) {
        const ts = T0 + seq * 500;
        const turn = turns.find((x) => ts >= x.startTs - 1 && ts < x.endTs);
        const db = turn ? (turn.seat === seat ? -18 : -40) : null;
        const a = await d.m.audio.chunk(seat, chunkMsg(tracks[i]!, seq, N, ts, pcm(N, db, seq + seat * 100)));
        expect(a.ok).toBe(true);
      }
    }
    await vi.advanceTimersByTimeAsync(600);
    const checked = d.events.find((e) => e.type === "CalibrationChecked");
    expect(checked).toBeDefined();
    const q = c().quality!;
    expect(q.perSeat.map((s) => s.seat)).toEqual([1, 2]);
    for (const s of q.perSeat) {
      expect(s.ownDb).not.toBeNull();
      expect(s.marginDb!).toBeGreaterThan(10);
    }
    expect(d.m.canStartRound()).toBeNull();
  });

  it("reports missing audio after the wait, and a redo restarts cleanly with new sentences", async () => {
    await ready();
    d.m.startCalibration();
    const first = d.m.state.audio.calibration.sentenceIds;
    await vi.advanceTimersByTimeAsync(3000);
    // redo in the middle of the first run: the old run's timers no longer count
    d.m.startCalibration(true);
    expect(d.m.state.audio.calibration.sentenceIds).not.toEqual(first);
    await vi.advanceTimersByTimeAsync(4000 + 1); // the old run's next turn would have fired here
    expect(d.events.filter((e) => e.type === "CalibrationTurn")).toHaveLength(2); // run 1 turn 0, run 2 turn 0
    await vi.advanceTimersByTimeAsync(3000 + 6000);
    expect(d.m.state.audio.calibration.status).toBe("done");
    expect(d.events.filter((e) => e.type === "CalibrationTurn")).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(CALIBRATION_CHECK_WAIT_MS + 1000);
    expect(d.m.state.audio.calibration.quality).toMatchObject({
      ok: false,
      perSeat: [
        { seat: 1, ownDb: null, ok: false },
        { seat: 2, ownDb: null, ok: false },
      ],
    });
    expect(d.events.filter((e) => e.type === "CalibrationChecked")).toHaveLength(1);
    expect(() => d.m.startCalibration()).toThrow(/redo/);
    expect(() => d.m.skipCalibration("x")).toThrow(/already done/);
  });

  it("skip cancels a running calibration; pausing recording ends it; abort clears the timers", async () => {
    await ready();
    d.m.startCalibration();
    d.m.skipCalibration("headsets");
    expect(d.m.state.audio.calibration.status).toBe("skipped");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(d.events.filter((e) => e.type === "CalibrationTurn")).toHaveLength(1);
    d.m.startCalibration(true);
    d.m.pauseRecording();
    // stopped by the server: back to pending, so round 1 still waits for a calibration
    expect(d.m.state.audio.calibration.status).toBe("pending");
    expect(d.events.at(-1)).toMatchObject({ type: "CalibrationSkipped", payload: { cancelled: true } });
    expect(d.m.canStartRound()).toMatch(/calibration/);
    expect(() => d.m.startCalibration(true)).toThrow(/paused/);
    d.m.resumeRecording();
    d.m.startCalibration(true);
    d.m.abort("test");
    const n = d.events.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(d.events.length).toBe(n);
  });
});

/* ─────────────────────────── end to end over sockets ─────────────────────────── */

describe("live recording with audio bots (sockets)", () => {
  let srv: TestServer;
  let cfgDir: string;
  let result: Awaited<ReturnType<typeof setupSession>>;
  let pauseTs = 0;
  let resumeTs = 0;

  beforeAll(async () => {
    // short calibration turns, so the test runs in seconds
    cfgDir = mkdtempSync(path.join(os.tmpdir(), "wkwa-cfg-"));
    cpSync(CONFIG_DIR, cfgDir, { recursive: true });
    const audio = JSON.parse(readFileSync(path.join(cfgDir, "audio.json"), "utf8"));
    audio.calibration.turnMs = 2000;
    audio.calibration.gapMs = 200;
    writeFileSync(path.join(cfgDir, "audio.json"), JSON.stringify(audio));
    srv = await startTestServer({ configDir: cfgDir });
    result = await setupSession(
      srv.url,
      { audio: { enabled: true }, roundCount: 1, defaultRound: ROUND },
      2,
      { audio: true, audioChunkMs: 500, minDelayMs: 5, maxDelayMs: 20 },
    );
  }, 30_000);

  afterAll(async () => {
    for (const b of result?.bots ?? []) b.stop();
    result?.fac.close();
    await srv?.close();
    cleanup(srv.dir);
    cleanup(cfgDir);
  });

  it("gates round 1 on the calibration, runs it and shows the quality check", async () => {
    const { fac } = result;
    await expect(fac.cmd("round:start")).rejects.toThrow(/calibration/);
    await fac.cmd("calibration:start");
    const d = await fac.waitForDashboard((x) => x.state?.audio.calibration.quality !== null, 25_000);
    expect(d.state?.audio.calibration.status).toBe("done");
    const q = d.state!.audio.calibration.quality!;
    expect(q.perSeat.map((s) => s.seat)).toEqual([1, 2]);
    for (const s of q.perSeat) expect(s.ownDb).not.toBeNull();
    expect(d.stats[1]!.mic).toMatchObject({ state: "recording" });
    expect(d.stats[1]!.mic!.tracks).toBeGreaterThanOrEqual(1);
    expect(d.stats[1]!.mic!.recordedMs).toBeGreaterThan(1000);
  }, 30_000);

  it("pauses and resumes recording: every seat stops and starts a new track", async () => {
    const { fac, bots } = result;
    await fac.cmd("recording:pause", { reason: "test" });
    pauseTs = srv.ctx.hub.session!.state.lastTs!;
    await Promise.all(bots.map((b) => b.waitFor((v: PlayerView) => v.audio.paused && !v.audio.record)));
    await new Promise((r) => setTimeout(r, 1200));
    await fac.cmd("recording:resume");
    resumeTs = srv.ctx.hub.session!.state.lastTs!;
    await Promise.all(bots.map((b) => b.waitFor((v: PlayerView) => v.audio.record)));
    await new Promise((r) => setTimeout(r, 1200));
    for (const b of bots) expect(b.audioStats.stopReasons).toContain("paused");
  }, 20_000);

  it("plays the round; game complete closes every track; nothing paused is stored; files are encrypted", async () => {
    const { fac, bots, sessionId } = result;
    await fac.cmd("round:start");
    await fac.waitForDashboard((x) => x.state?.phase === "game_complete", 20_000);
    await Promise.all(bots.map((b) => b.audioSent()));
    const store = srv.ctx.store;
    const tracks = store.listAudioTracks(sessionId);
    for (const seat of [1, 2]) {
      const mine = tracks.filter((t) => t.seat === seat);
      expect(mine.length).toBeGreaterThanOrEqual(2);
      expect(mine.map((t) => t.reason)).toEqual(expect.arrayContaining(["mic_check", "resume"]));
      expect(mine.map((t) => t.stopReason)).toEqual(expect.arrayContaining(["paused", "game_complete"]));
      for (const t of mine) {
        expect(t.status).toBe("closed");
        expect(t.participantCode).toMatch(/^WK-/);
        expect(JSON.stringify(t.settings)).not.toMatch(/deviceId|label|groupId/);
      }
    }
    // nothing captured during the pause was stored
    for (const t of tracks) {
      for (const c of store.listAudioChunks(t.trackId)) {
        const end = c.clientTs + (c.sampleCount * 1000) / AUDIO_SAMPLE_RATE;
        expect(end <= pauseTs + 1 || c.clientTs >= resumeTs).toBe(true);
      }
    }
    // events: started/stopped pairs, never a participant code in a payload
    const events = store.listEvents(sessionId);
    const started = events.filter((e) => e.type === "AudioTrackStarted").length;
    expect(events.filter((e) => e.type === "AudioTrackStopped").length).toBe(started);
    for (const e of events) expect(JSON.stringify(e.payload)).not.toMatch(/WK-[0-9A-Z]{4}-/);
    // files encrypted at rest: no WAV/Ogg headers, and no stored plaintext PCM in any file
    const audioDir = path.join(srv.runtime.dataDir, "audio");
    const all = filesUnder(audioDir);
    expect(all.length).toBe(tracks.length);
    const sample = tracks.find((t) => t.chunks > 0)!;
    const plain = await readTrackPcm(
      srv.ctx.audioFiles,
      sessionId,
      sample.fileName!,
      store.getAudioTrackKey(sample.trackId)!,
    );
    const probe = plain.pcm.subarray(1000, 1064);
    for (const f of all) {
      expect(path.basename(f)).toMatch(/^[0-9a-f]{32}\.wka$/);
      const bytes = readFileSync(f);
      expect(statSync(f).size).toBeGreaterThan(0);
      expect(bytes.includes("RIFF")).toBe(false);
      expect(bytes.includes("OggS")).toBe(false);
      expect(bytes.includes(probe)).toBe(false);
    }
    const report = await verifyAudio(store, srv.ctx.audioFiles);
    expect(report.problems).toEqual([]);
    expect(report.records).toBeGreaterThan(0);
  }, 30_000);

  it("bots without --audio decline an audio session and wait without spinning", async () => {
    const fac = new FacilitatorClient(srv.url);
    await fac.connected();
    await fac.cmd("session:close");
    await fac.cmd("session:create", {
      scenarioId: "demo",
      config: { seatCount: 1, audio: { enabled: true } },
    });
    const bot = new Bot({ url: srv.url, name: "plain" });
    try {
      const terminal = await bot.waitForTerminal();
      await fac.cmd("seat:bind", { terminal, seat: 1 });
      await bot.waitFor((v) => v.phase === "lobby");
      await fac.cmd("labels:randomise");
      await fac.cmd("onboarding:start");
      await fac.waitForDashboard((x) => x.state?.seats[1]?.consent === "declined");
      await bot.waitFor((v) => v.me.consent === "declined");
      await new Promise((r) => setTimeout(r, 100));
      expect(bot.acks).toHaveLength(1);
      const acks = bot.acks.length;
      await new Promise((r) => setTimeout(r, 500));
      expect(bot.acks.length).toBe(acks); // nothing more sent
      expect(bot.audioStats.tracks).toBe(0);
    } finally {
      bot.stop();
      fac.close();
    }
  }, 15_000);
});
