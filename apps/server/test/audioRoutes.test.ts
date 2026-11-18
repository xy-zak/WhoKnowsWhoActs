import { readFileSync } from "node:fs";
import path from "node:path";
import { AttributionJobSchema, AudioSessionSummarySchema } from "@wkwa/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseWavHeader } from "../src/audio/wav";
import { type SeededSession, seedAudioSession } from "./audioSession";
import { cleanup, setupSession, startTestServer, type TestServer } from "./harness";

const CODE_RE = /WK-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]/;

describe("audio REST routes (DATABASE tab)", () => {
  let srv: TestServer;
  let seeded: SeededSession;
  let running: Awaited<ReturnType<typeof setupSession>>;

  const api = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${srv.url}${url}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, text, json: text ? JSON.parse(text) : null };
  };

  beforeAll(async () => {
    srv = await startTestServer();
    seeded = await seedAudioSession(srv.ctx.store, srv.ctx.audioFiles, { seed: 21, durationSec: 60 });
    running = await setupSession(srv.url, { roundCount: 1 }, 2, { minDelayMs: 5, maxDelayMs: 15 });
  }, 60_000);

  afterAll(async () => {
    for (const b of running?.bots ?? []) b.stop();
    running?.fac.close();
    await srv?.close();
    cleanup(srv.dir);
  });

  it("is facilitator-only: other computers without the admin token get 403", async () => {
    for (const [method, url] of [
      ["GET", `/api/sessions/${seeded.sessionId}/audio`],
      ["POST", `/api/sessions/${seeded.sessionId}/audio/attribution`],
      ["GET", `/api/sessions/${seeded.sessionId}/audio/segments`],
      ["POST", `/api/sessions/${seeded.sessionId}/audio/export`],
      ["POST", `/api/sessions/${seeded.sessionId}/audio/delete`],
      ["GET", "/api/audio/jobs/x"],
    ] as const) {
      const r = await srv.ctx.app.inject({ method, url, remoteAddress: "192.168.1.23", payload: {} });
      expect(r.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it("GET …/audio: the summary, without keys, file names or codes", async () => {
    const r = await api("GET", `/api/sessions/${seeded.sessionId}/audio`);
    expect(r.status).toBe(200);
    expect(AudioSessionSummarySchema.parse(r.json)).toBeTruthy();
    expect(r.json.tracks).toHaveLength(4);
    expect(r.json.seats).toHaveLength(4);
    expect(r.text).not.toMatch(CODE_RE);
    expect(r.text).not.toMatch(/fileKey|fileName|\.wka/);
    expect((await api("GET", "/api/sessions/S-20990101-NONE/audio")).status).toBe(404);
  });

  it("POST …/audio/attribution validates, queues (202), and the job can be polled to done", async () => {
    const url = `/api/sessions/${seeded.sessionId}/audio/attribution`;
    expect((await api("POST", url, { options: "loud" })).status).toBe(400);
    expect((await api("POST", url, { unknown: 1 })).status).toBe(400);
    const start = await api("POST", url, {});
    expect(start.status).toBe(202);
    expect(AttributionJobSchema.parse(start.json).status).toMatch(/queued|running/);
    expect((await api("POST", url, {})).status).toBe(409); // one job per session
    let job = start.json;
    for (let i = 0; i < 200 && job.status !== "done" && job.status !== "failed"; i++) {
      await new Promise((r) => setTimeout(r, 100));
      job = (await api("GET", `/api/audio/jobs/${start.json.jobId}`)).json;
    }
    expect(job.status).toBe("done");
    expect(AttributionJobSchema.parse(job).summary?.segments).toBeGreaterThan(5);
    expect(job.summary.grade).toMatch(/good|fair|poor/);
    expect((await api("GET", "/api/audio/jobs/not-a-job")).status).toBe(404);
  }, 60_000);

  it("GET …/audio/segments: who spoke when, timing only", async () => {
    const r = await api("GET", `/api/sessions/${seeded.sessionId}/audio/segments`);
    expect(r.status).toBe(200);
    expect(r.json.segments.length).toBeGreaterThan(5);
    expect(Object.keys(r.json.segments[0]).sort()).toEqual(
      [
        "confidence",
        "durationMs",
        "endTs",
        "meanDb",
        "overlap",
        "overlapMs",
        "overlapWith",
        "paused",
        "phase",
        "recordingPaused",
        "round",
        "seat",
        "startTs",
      ].sort(),
    );
    expect(r.text).not.toMatch(CODE_RE);
  });

  it("POST …/audio/export: validated, one seat or all, valid 16 kHz mono WAVs", async () => {
    const url = `/api/sessions/${seeded.sessionId}/audio/export`;
    expect((await api("POST", url, {})).status).toBe(400);
    expect((await api("POST", url, { kind: "mp3" })).status).toBe(400);
    expect((await api("POST", url, { kind: "raw", sessionId: "S-20990101-ELSE" })).status).toBe(400);
    expect((await api("POST", url, { kind: "raw", seats: [7] })).status).toBe(400);
    const one = await api("POST", url, {
      kind: "raw",
      seats: [3],
      sessionId: seeded.sessionId,
      note: "seat 3",
    });
    expect(one.status).toBe(200);
    expect(one.json.files.map((f: { name: string }) => f.name)).toEqual([
      `${seeded.sessionId}_seat3_raw.wav`,
    ]);
    const all = await api("POST", url, { kind: "both" });
    expect(all.json.files).toHaveLength(8);
    for (const f of all.json.files) {
      const h = parseWavHeader(readFileSync(path.join(all.json.dir, f.name)));
      expect(h).toMatchObject({ sampleRate: 16_000, channels: 1, bitsPerSample: 16, audioFormat: 1 });
    }
    expect(all.text).not.toMatch(CODE_RE);
    const reg = await api("GET", "/api/exports");
    expect(reg.json.filter((e: { kind: string }) => e.kind === "audio")).toHaveLength(2);
  }, 60_000);

  it("refuses while the session is running (409), and simulated sessions have no audio", async () => {
    const id = running.sessionId;
    expect((await api("POST", `/api/sessions/${id}/audio/attribution`, {})).status).toBe(409);
    expect((await api("POST", `/api/sessions/${id}/audio/export`, { kind: "raw" })).status).toBe(409);
    const del = await api("POST", `/api/sessions/${id}/audio/delete`, { confirm: id, scope: "raw" });
    expect(del.status).toBe(409);
    expect(del.json.error).toMatch(/still running/);
    const summary = await api("GET", `/api/sessions/${id}/audio`);
    expect(summary.json).toMatchObject({ running: true, tracks: [] });
  });

  it("POST …/audio/delete: typed confirmation, then re-running attribution answers 409", async () => {
    const id = seeded.sessionId;
    const url = `/api/sessions/${id}/audio/delete`;
    expect((await api("POST", url, { confirm: id })).status).toBe(400); // scope missing
    expect((await api("POST", url, { confirm: "nope", scope: "raw" })).status).toBe(400);
    const r = await api("POST", url, { confirm: id, scope: "raw", note: "retention" });
    expect(r.status).toBe(200);
    expect(r.json.record).toMatchObject({ scope: "raw", seats: [1, 2, 3, 4], tracks: 4, note: "retention" });
    const sum = (await api("GET", `/api/sessions/${id}/audio`)).json;
    expect(sum.deletions).toHaveLength(1);
    expect(sum.tracks.every((t: { status: string }) => t.status === "deleted")).toBe(true);
    const again = await api("POST", `/api/sessions/${id}/audio/attribution`, {});
    expect(again.status).toBe(409);
    expect(again.json.error).toMatch(/deleted/);
    expect((await api("POST", `/api/sessions/${id}/audio/export`, { kind: "raw" })).status).toBe(409);
    // speech segments survive "delete raw audio"
    expect((await api("GET", `/api/sessions/${id}/audio/segments`)).json.segments.length).toBeGreaterThan(5);
  });
});
