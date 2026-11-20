import type { AttributionSummaryView, AudioSessionView, SeatAudioSummary } from "@wkwa/shared";
import { describe, expect, it } from "vitest";
import { PLACEHOLDER } from "../src/common/format";
import {
  attributionBlock,
  audioCell,
  DELETE_SCOPES,
  deleteBlock,
  exportBlock,
  isJobBusy,
  JOB_IDLE,
  JOB_POLL_MAX_ERRORS,
  type JobAction,
  type JobState,
  jobReducer,
  progressCells,
  scopeSentence,
  shortSha,
  talkBars,
  timelineBars,
  timelineSpan,
} from "../src/facilitator/database/audioModel";

const seat = (n: number, over: Partial<SeatAudioSummary> = {}): SeatAudioSummary => ({
  seat: n,
  tracks: 2,
  durationMs: 60_000,
  gaps: 0,
  trackBreaks: 1,
  spanMs: 65_000,
  missingMs: 5_000,
  firstServerTs: 1_000,
  lastServerTs: 66_000,
  rawDeleted: false,
  ...over,
});

const view = (over: Partial<AudioSessionView> = {}): AudioSessionView => ({
  sessionId: "S-TEST",
  tracks: [],
  derivatives: [],
  jobs: [],
  deletions: [],
  seats: [seat(1), seat(2)],
  attribution: null,
  audioExports: [],
  running: false,
  ...over,
});

const clean = (n: number) => ({
  derivativeId: `d${n}`,
  seat: n,
  kind: "clean" as const,
  sourceTrackIds: [],
  jobId: "J1",
  engineVersion: "1",
  params: {},
  createdServerTs: 0,
  samples: 16_000,
  durationMs: 1000,
  bytes: 32_000,
});

const summary: AttributionSummaryView = {
  engineVersion: "1",
  talkTimeMs: { "1": 1000, "2": 3000 },
  segments: 4,
  overlapMs: 200,
  quality: { calibrated: true, perSeat: [], ambiguousShare: 0.1, warnings: [] },
  grade: "good",
};

describe("sessions list and hashes", () => {
  it("shows the sessions list's audio cell and shortens hashes", () => {
    expect(audioCell(0, 0)).toBe(PLACEHOLDER);
    expect(audioCell(undefined, undefined)).toBe(PLACEHOLDER);
    expect(audioCell(4, 192_000)).toBe("4 tr · 3:12");
    expect(shortSha("0123456789abcdef0123")).toBe("0123456789ab…");
    expect(shortSha("abc")).toBe("abc");
  });
});

describe("attribution result helpers", () => {
  it("builds talk-time bars relative to the longest talker", () => {
    const bars = talkBars({ "2": 3000, "1": 1000, "3": 0 }, 10);
    expect(bars.map((b) => b.seat)).toEqual([1, 2, 3]);
    expect(bars.map((b) => b.filled)).toEqual([3, 10, 0]);
    expect(bars[1]!.share).toBeCloseTo(0.75);
    expect(talkBars({ "1": 0 })[0]!.filled).toBe(0);
  });

  it("lays out speech segments on the session span, clamped, with a minimum width", () => {
    const seg = (s: number, a: number, b: number) => ({
      seat: s,
      startTs: a,
      endTs: b,
      durationMs: b - a,
      round: 1,
      phase: null,
      paused: false,
      recordingPaused: false,
      meanDb: -30,
      confidence: 1,
      overlap: false,
      overlapMs: 0,
      overlapWith: [],
    });
    const bars = timelineBars([seg(1, 0, 500), seg(2, 900, 2000), seg(1, 500, 500)], 0, 1000);
    expect(bars.get(1)![0]).toMatchObject({ left: 0, width: 50 });
    expect(bars.get(1)![1]!.width).toBeCloseTo(0.15);
    expect(bars.get(2)![0]).toMatchObject({ left: 90, width: 10 });
    expect(timelineBars([seg(1, 0, 1)], 5, 5).size).toBe(0);
    expect(timelineSpan([seat(1, { firstServerTs: 100, lastServerTs: 900 })], [seg(1, 50, 400)])).toEqual({
      t0: 50,
      t1: 900,
    });
    expect(timelineSpan([], [])).toBeNull();
  });
});

describe("deletion scopes", () => {
  it("says what each scope removes and keeps", () => {
    expect(scopeSentence("raw")).toMatch(
      /^Deletes .*microphone audio.*cleaned tracks.*Keeps .*speech segments/,
    );
    expect(DELETE_SCOPES.raw.keeps).toMatch(/talk time/);
    expect(DELETE_SCOPES.raw.keeps).toMatch(/quality report/);
    expect(DELETE_SCOPES.all.removes).toMatch(/speech segments/);
    expect(DELETE_SCOPES.all.keeps).toMatch(/register/);
  });
});

describe("availability of the actions", () => {
  it("refuses attribution while running, while a job is busy, without audio or after a raw deletion", () => {
    expect(attributionBlock(view(), JOB_IDLE)).toBeNull();
    expect(attributionBlock(view({ running: true }), JOB_IDLE)).toMatch(/still running/);
    expect(attributionBlock(view(), { phase: "starting" })).toMatch(/queued or running/);
    expect(attributionBlock(view({ seats: [] }), JOB_IDLE)).toMatch(/no audio/);
    expect(attributionBlock(view({ seats: [seat(1, { rawDeleted: true })] }), JOB_IDLE)).toMatch(/deleted/);
    const deletedTrack = {
      trackId: "00000000-0000-4000-8000-000000000000",
      seat: 2,
      startedServerTs: 0,
      closedServerTs: 1,
      stopReason: null,
      samples: 0,
      durationMs: 0,
      chunks: 0,
      gaps: 0,
      bytes: 0,
      status: "deleted" as const,
    };
    // like the server: one deleted track is enough to refuse
    expect(attributionBlock(view({ tracks: [deletedTrack] }), JOB_IDLE)).toMatch(/deleted/);
  });

  it("allows a clean export only once a cleaned track exists", () => {
    expect(exportBlock(view(), JOB_IDLE, "raw", "all")).toBeNull();
    expect(exportBlock(view(), JOB_IDLE, "clean", "all")).toMatch(/attribution first/);
    expect(exportBlock(view({ derivatives: [clean(1)] }), JOB_IDLE, "clean", 1)).toBeNull();
    expect(exportBlock(view({ derivatives: [clean(1)] }), JOB_IDLE, "both", "all")).toMatch(
      /attribution first/,
    );
    expect(exportBlock(view(), JOB_IDLE, "raw", 3)).toMatch(/Seat 3 has no audio/);
    expect(exportBlock(view({ seats: [seat(1, { rawDeleted: true })] }), JOB_IDLE, "raw", 1)).toMatch(
      /raw audio of seat 1 was deleted/,
    );
    expect(exportBlock(view({ running: true }), JOB_IDLE, "raw", "all")).toMatch(/still running/);
  });

  it("refuses deletion while running or while a job is busy", () => {
    expect(deleteBlock(view(), JOB_IDLE)).toBeNull();
    expect(deleteBlock(view({ running: true }), JOB_IDLE)).toMatch(/still running/);
    const active: JobState = {
      phase: "active",
      jobId: "J1",
      status: "running",
      progress: 0.2,
      polls: 0,
      errors: 0,
    };
    expect(deleteBlock(view(), active)).toMatch(/queued or running/);
    expect(deleteBlock(view({ seats: [] }), JOB_IDLE)).toMatch(/no audio/);
  });
});

describe("attribution job state machine", () => {
  const job = (status: "queued" | "running" | "done" | "failed", progress = 0, jobId = "J1") => ({
    type: "job" as const,
    job: {
      jobId,
      status,
      progress,
      error: status === "failed" ? "worker crashed" : null,
      ...(status === "done" ? { summary } : {}),
    },
  });
  const run = (...actions: JobAction[]) => actions.reduce(jobReducer, JOB_IDLE);

  it("goes idle → starting → active → done", () => {
    let s = jobReducer(JOB_IDLE, { type: "start" });
    expect(s).toEqual({ phase: "starting" });
    expect(isJobBusy(s)).toBe(true);
    s = jobReducer(s, job("queued"));
    expect(s).toMatchObject({ phase: "active", jobId: "J1", status: "queued", progress: 0, polls: 0 });
    s = jobReducer(s, job("running", 0.4));
    expect(s).toMatchObject({ phase: "active", status: "running", progress: 0.4, polls: 1 });
    s = jobReducer(s, job("done", 1));
    expect(s).toEqual({ phase: "done", jobId: "J1", summary });
    expect(isJobBusy(s)).toBe(false);
  });

  it("keeps progress monotonic and changes state on every poll (so the next poll is armed)", () => {
    const a = run({ type: "start" }, job("running", 0.6));
    const b = jobReducer(a, job("running", 0.3));
    expect(b).toMatchObject({ progress: 0.6 });
    expect(b).not.toBe(a);
    expect(jobReducer(b, job("running", 7))).toMatchObject({ progress: 1 });
  });

  it("does not start twice and ignores late answers", () => {
    const active = run({ type: "start" }, job("running", 0.5));
    expect(jobReducer(active, { type: "start" })).toBe(active);
    expect(jobReducer(active, { type: "reset" })).toBe(active);
    expect(jobReducer(active, job("running", 0.9, "OTHER"))).toBe(active);
    const done = jobReducer(active, job("done", 1));
    expect(jobReducer(done, job("running", 0.7))).toBe(done);
    expect(jobReducer(done, { type: "error", error: "late" })).toBe(done);
  });

  it("retries failed polls and gives up only after several in a row", () => {
    let s = run({ type: "start" }, job("running", 0.5));
    for (let i = 1; i < JOB_POLL_MAX_ERRORS; i++) {
      const next = jobReducer(s, { type: "error", error: "Network down" });
      expect(next).toMatchObject({ phase: "active", progress: 0.5, errors: i });
      expect(next).not.toBe(s);
      s = next;
    }
    expect(jobReducer(s, job("running", 0.6))).toMatchObject({ phase: "active", errors: 0 });
    const gaveUp = jobReducer(s, { type: "error", error: "Network down" });
    expect(gaveUp).toMatchObject({ phase: "failed", jobId: "J1" });
    expect(gaveUp.phase === "failed" && gaveUp.error).toMatch(/^Network down/);
  });

  it("fails with the job's error, or the refusal of the start request verbatim", () => {
    expect(run({ type: "start" }, job("running", 0.1), job("failed"))).toEqual({
      phase: "failed",
      jobId: "J1",
      error: "worker crashed",
    });
    expect(run({ type: "start" }, { type: "error", error: "The session is still running." })).toEqual({
      phase: "failed",
      jobId: null,
      error: "The session is still running.",
    });
    const failed = run({ type: "start" }, { type: "error", error: "x" });
    expect(jobReducer(failed, { type: "start" })).toEqual({ phase: "starting" });
    expect(jobReducer(failed, { type: "reset" })).toBe(JOB_IDLE);
  });

  it("draws progress as cells", () => {
    expect(progressCells(0.34)).toEqual({ on: 3, off: 7, pct: 34 });
    expect(progressCells(2, 5)).toEqual({ on: 5, off: 0, pct: 100 });
    expect(progressCells(Number.NaN)).toEqual({ on: 0, off: 10, pct: 0 });
  });
});
