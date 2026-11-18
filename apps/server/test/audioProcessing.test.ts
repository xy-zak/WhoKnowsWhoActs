import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AttributionJobSchema,
  AudioDeletionRecordSchema,
  AudioSessionSummarySchema,
  EXPORT_FILES,
  expandColumns,
  exportFile,
} from "@wkwa/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AudioFileStore } from "../src/audio/fileStore";
import { AudioJobRunner, runInline, runInWorker, scrubError, type TaskRunner } from "../src/audio/jobs";
import { seqOrderedChunks } from "../src/audio/jobWorker";
import { AudioRequestError, AudioService } from "../src/audio/service";
import { parseWavHeader } from "../src/audio/wav";
import { openDatabase } from "../src/db/database";
import { Store } from "../src/db/store";
import { eraseParticipant, lookupParticipant } from "../src/gdpr/erase";
import { exportSession } from "../src/gdpr/exporter";
import { type SeededSession, seedAudioSession } from "./audioSession";
import { cleanup, PASSPHRASE } from "./harness";

const CODE_RE = /WK-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]/;

function parseCsv(text: string): Array<Record<string, string>> {
  const [head, ...lines] = text.trimEnd().split("\n");
  const cols = head!.split(",");
  return lines.filter(Boolean).map((l) => {
    const cells = l.split(","); // test data has no quoted commas
    return Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? ""]));
  });
}

function makeEnv() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wkwa-audio-proc-"));
  const db = openDatabase(path.join(dir, "data", "wkwa.db"), PASSPHRASE);
  const files = new AudioFileStore(path.join(dir, "data", "audio"));
  const store = new Store(db, files);
  const exportsDir = path.join(dir, "exports");
  return { dir, db, files, store, exportsDir };
}

const scenarios = {
  load: () => {
    throw new Error("no scenario in this test");
  },
} as unknown as Parameters<typeof exportSession>[0]["scenarios"];

describe("audio processing: jobs, derivatives, export", () => {
  const env = makeEnv();
  const runner = new AudioJobRunner(env.store);
  const service = new AudioService({
    store: env.store,
    exportsDir: env.exportsDir,
    runner,
    runTask: runInWorker,
  });
  let seeded: SeededSession;

  beforeAll(async () => {
    seeded = await seedAudioSession(env.store, env.files, { seed: 11, durationSec: 70 });
  }, 60_000);

  afterAll(async () => {
    await runner.close();
    env.db.close();
    cleanup(env.dir);
  });

  it("runs the attribution in a worker thread and stores encrypted, per-seat derivatives", async () => {
    const { sessionId, codes } = seeded;
    const queued = service.startAttribution(sessionId);
    expect(queued.status).toBe("queued");
    expect(() => service.startAttribution(sessionId)).toThrow(AudioRequestError); // one job per session
    await runner.whenIdle();
    const job = service.job(queued.jobId);
    expect(job.status).toBe("done");
    expect(job.progress).toBe(1);
    expect(AttributionJobSchema.parse(job)).toBeTruthy();
    const s = job.summary!;
    expect(s.segments).toBeGreaterThan(10);
    expect(Object.keys(s.talkTimeMs).sort()).toEqual(["1", "2", "3", "4"]);
    expect(s.quality.calibrated).toBe(true);
    expect(s.quality.perSeat).toHaveLength(4);
    expect(["good", "fair", "poor"]).toContain(s.grade);

    const kinds = (k: string) => env.store.listAudioDerivatives(sessionId, { kind: k });
    for (const k of ["talk_time", "quality_report", "leakage_matrix"]) {
      expect(kinds(k)).toHaveLength(1);
      expect(kinds(k)[0]!.participantCode).toBeNull();
    }
    const segs = kinds("speech_segments");
    expect(segs.map((d) => d.seat).sort()).toEqual([1, 2, 3, 4]);
    for (const d of segs) {
      expect(d.participantCode).toBe(codes[d.seat!]);
      expect(d.sourceTracks).toEqual(seeded.trackIds[d.seat!]);
      expect(d.hasKey).toBe(false);
      expect(d.engineVersion).toMatch(/^wkwa-energy-attribution\//);
    }
    const clean = kinds("clean");
    expect(clean).toHaveLength(4);
    for (const d of clean) {
      expect(d.hasKey).toBe(true);
      expect(d.fileName).toMatch(/^[0-9a-f]{32}\.wka$/);
      const key = env.store.getAudioDerivativeKey(d.derivativeId)!;
      const { pcm, issues } = await env.files.readTrackPcm(sessionId, d.fileName!, key);
      expect(issues).toEqual([]);
      expect(pcm.length).toBe((d.params.samples as number) * 2);
      // encrypted at rest: a stretch of the decrypted audio does not appear in the file
      const onDisk = readFileSync(env.files.pathOf(sessionId, d.fileName!));
      expect(onDisk.subarray(0, 4).toString()).toBe("WKA1");
      let off = pcm.findIndex((b, i) => i % 2 === 0 && b !== 0) + 20_000;
      off -= off % 2;
      expect(onDisk.includes(pcm.subarray(off, off + 64))).toBe(false);
    }

    // integration sanity: most attributed speech lies inside the seat's true speech (accuracy itself is U5's)
    const { segments } = service.speechSegments(sessionId);
    let inside = 0;
    let total = 0;
    const truth = seeded.synth.speech;
    for (const g of segments) {
      total += g.durationMs;
      for (const u of truth)
        if (u.seat === g.seat)
          inside += Math.max(0, Math.min(g.endTs, u.end + 150) - Math.max(g.startTs, u.start - 150));
    }
    expect(inside / total).toBeGreaterThan(0.85);
    // annotated from the event log: a segment that starts inside the game pause is flagged
    const mid = seeded.synth.t0 + seeded.synth.durationSec * 600;
    for (const g of segments) expect(g.paused).toBe(g.startTs >= mid && g.startTs < mid + 5000);
    expect(JSON.stringify(segments)).not.toMatch(CODE_RE);
  }, 120_000);

  it("re-running replaces the previous run's derivatives and unlinks its files", async () => {
    const { sessionId } = seeded;
    const before = env.store.listAudioDerivatives(sessionId);
    const oldFiles = before.filter((d) => d.fileName).map((d) => d.fileName!);
    service.startAttribution(sessionId);
    await runner.whenIdle();
    const after = env.store.listAudioDerivatives(sessionId);
    expect(after).toHaveLength(before.length);
    const ids = new Set(before.map((d) => d.derivativeId));
    expect(after.some((d) => ids.has(d.derivativeId))).toBe(false);
    for (const f of oldFiles) expect(env.files.exists(sessionId, f)).toBe(false);
    // no orphans: every file in the session folder is a raw track or a current derivative
    const known = env.store.audioFileRefs().map((r) => ({ sessionId: r.sessionId, fileName: r.fileName }));
    expect(env.files.findOrphans(known)).toEqual([]);
  }, 120_000);

  it("summary: tracks, cleaned tracks, jobs and per-seat totals, typed by the shared schemas, no keys or codes", () => {
    const sum = service.summary(seeded.sessionId);
    expect(AudioSessionSummarySchema.parse(sum)).toBeTruthy();
    expect(sum.tracks).toHaveLength(4);
    expect(sum.tracks.every((t) => t.status === "closed" && t.bytes > t.samples * 2)).toBe(true);
    expect(sum.derivatives).toHaveLength(4);
    expect(sum.jobs.map((j) => j.status)).toEqual(["done", "done"]);
    expect(sum.seats.map((s) => s.seat)).toEqual([1, 2, 3, 4]);
    expect(sum.seats.every((s) => s.durationMs > 60_000 && s.tracks === 1)).toBe(true);
    expect(sum.attribution?.segments).toBeGreaterThan(10);
    const json = JSON.stringify(sum);
    expect(json).not.toMatch(CODE_RE);
    expect(json).not.toMatch(/fileKey|"key"|\.wka/);
  });

  it("exports audio as registered WAV files named by seat and session, never by code", async () => {
    const { sessionId, codes } = seeded;
    const r = await service.exportAudio(sessionId, { kind: "both", note: "pilot", requestedBy: "test" });
    expect(r.timing).toBe("attribution");
    expect(r.files).toHaveLength(8);
    const names = readdirSync(r.dir).sort();
    expect(names).toEqual(
      [
        "manifest.json",
        ...[1, 2, 3, 4].flatMap((s) => [`${sessionId}_seat${s}_clean.wav`, `${sessionId}_seat${s}_raw.wav`]),
      ].sort(),
    );
    expect(path.dirname(r.dir)).toBe(path.join(env.exportsDir, sessionId));
    expect(path.basename(r.dir)).toMatch(/^audio-AU-\d{8}-\d{6}-[0-9A-Z]{4}$/);
    const lengths = new Set<number>();
    for (const f of r.files) {
      const file = path.join(r.dir, f.name);
      const bytes = readFileSync(file);
      const h = parseWavHeader(bytes, bytes.length);
      expect(h).toMatchObject({
        sampleRate: 16_000,
        channels: 1,
        bitsPerSample: 16,
        audioFormat: 1,
        truncated: false,
      });
      expect(h.frames).toBe(f.samples);
      expect(statSync(file).size).toBe(44 + f.samples * 2);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(f.sha256);
      lengths.add(f.samples);
    }
    expect(lengths.size).toBe(1); // every seat on one timeline: the files line up sample for sample
    const manifest = readFileSync(path.join(r.dir, "manifest.json"), "utf8");
    expect(manifest).not.toMatch(CODE_RE);
    expect(JSON.parse(manifest)).toMatchObject({
      kind: "audio",
      audioKind: "both",
      sessionId,
      note: "pilot",
    });
    for (const n of names) expect(n).not.toMatch(CODE_RE);

    // registered: the export register holds it (with hashed codes, so a takedown finds it)
    const row = env.db.prepare("SELECT * FROM exports WHERE id = ?").get(r.exportId) as {
      kind: string;
      details_json: string;
      files_json: string;
      code_hashes_json: string;
    };
    expect(row.kind).toBe("audio");
    expect(JSON.parse(row.details_json)).toMatchObject({
      requestedBy: "test",
      audioKind: "both",
      seats: [1, 2, 3, 4],
    });
    expect(JSON.parse(row.files_json)).toHaveLength(9);
    expect(JSON.parse(row.code_hashes_json)).toHaveLength(4);
    expect(lookupParticipant(env.store, codes[3]!).exports.map((e) => e.id)).toContain(r.exportId);

    // a single seat (the DATABASE tab's "download WAV")
    const one = await service.exportAudio(sessionId, { kind: "clean", seats: [2], requestedBy: "test" });
    expect(one.files.map((f) => f.name)).toEqual([`${sessionId}_seat2_clean.wav`]);
    await expect(
      service.exportAudio(sessionId, { kind: "raw", seats: [9], requestedBy: "t" }),
    ).rejects.toThrow(/Seat 9 has no audio/);
    expect(service.summary(sessionId).audioExports).toHaveLength(2);
  }, 60_000);

  it("CSV exports gain audio_tracks.csv and speech_segments.csv (pseudonymised like the other files)", () => {
    const { sessionId, codes } = seeded;
    const deps = { store: env.store, scenarios, exportsDir: env.exportsDir };
    const std = exportSession(deps, sessionId);
    for (const f of ["audio_tracks.csv", "speech_segments.csv"]) {
      const header = readFileSync(path.join(std.dir, f), "utf8").split("\n")[0]!.split(",");
      expect(header).toEqual(expandColumns(exportFile(f)).map((c) => c.name));
    }
    const tracks = parseCsv(readFileSync(path.join(std.dir, "audio_tracks.csv"), "utf8"));
    expect(tracks).toHaveLength(4);
    expect(tracks.map((t) => t.participant_code).sort()).toEqual(Object.values(codes).sort());
    expect(
      tracks.every((t) => t.status === "closed" && t.sample_rate === "16000" && t.echo_cancellation === "0"),
    ).toBe(true);
    const segs = parseCsv(readFileSync(path.join(std.dir, "speech_segments.csv"), "utf8"));
    expect(segs.length).toBe(service.speechSegments(sessionId).segments.length);
    expect(new Set(segs.map((s) => s.seat))).toEqual(new Set(["1", "2", "3", "4"]));
    // no audio, keys or file names in any CSV
    const all = readdirSync(std.dir)
      .map((f) => readFileSync(path.join(std.dir, f), "utf8"))
      .join("\n");
    expect(all).not.toMatch(/\.wka|RIFF/);

    const anon = exportSession(deps, sessionId, "anonymised");
    const anonText = readdirSync(anon.dir)
      .map((f) => readFileSync(path.join(anon.dir, f), "utf8"))
      .join("\n");
    expect(anonText).not.toMatch(CODE_RE);
    const aTracks = parseCsv(readFileSync(path.join(anon.dir, "audio_tracks.csv"), "utf8"));
    const aSegs = parseCsv(readFileSync(path.join(anon.dir, "speech_segments.csv"), "utf8"));
    expect(aTracks.every((t) => /^A-[0-9A-Z]{6}$/.test(t.participant_code!))).toBe(true);
    // the same random id per participant across the files of one export
    const bySeat = new Map(aTracks.map((t) => [t.seat, t.participant_code]));
    expect(aSegs.every((s) => bySeat.get(s.seat) === s.participant_code)).toBe(true);
  });

  it("a session without audio still gets both files, header only", () => {
    env.store.insertSession({
      id: "S-20261118-NOAU",
      created_wall: "2026-11-18T10:00:00.000Z",
      scenario_id: "demo",
      scenario_version: "1",
      scenario_hash: "h",
      status: "closed",
      tags_json: "[]",
      notes: "",
      config_json: "{}",
      harness_version: "0",
      git_commit: "x",
    });
    const r = exportSession({ store: env.store, scenarios, exportsDir: env.exportsDir }, "S-20261118-NOAU");
    expect(readdirSync(r.dir).sort()).toEqual(EXPORT_FILES.map((f) => f.file).sort());
    for (const f of ["audio_tracks.csv", "speech_segments.csv"])
      expect(readFileSync(path.join(r.dir, f), "utf8").trimEnd().split("\n")).toHaveLength(1);
    expect(() => service.startAttribution("S-20261118-NOAU")).toThrow(/no audio/);
  });

  it("raw export before any attribution uses the timestamps; clean export needs an attribution", async () => {
    const fresh = await seedAudioSession(
      env.store,
      env.files,
      { seed: 12, durationSec: 40 },
      { calibration: false },
    );
    const pending = service.exportAudio(fresh.sessionId, { kind: "raw", requestedBy: "test" });
    // while the WAVs are being written, nothing may delete or replace what they are read from
    expect(() => service.deleteAudio(fresh.sessionId, { confirm: fresh.sessionId, scope: "all" })).toThrow(
      /export of this session is being written/,
    );
    expect(() => service.startAttribution(fresh.sessionId)).toThrow(/being written/);
    const r = await pending;
    expect(r.timing).toBe("timestamps");
    expect(r.warnings).toEqual([]);
    expect(r.files).toHaveLength(4);
    for (const f of r.files) {
      const h = parseWavHeader(readFileSync(path.join(r.dir, f.name)));
      expect(h.durationMs).toBeGreaterThan(35_000);
    }
    await expect(
      service.exportAudio(fresh.sessionId, { kind: "clean", requestedBy: "test" }),
    ).rejects.toMatchObject({
      statusCode: 409,
    });
  }, 60_000);

  it("erasure afterwards removes the participant's tracks and segments from future exports", () => {
    const { sessionId, codes } = seeded;
    eraseParticipant(env.store, codes[2]!, "test");
    const r = exportSession({ store: env.store, scenarios, exportsDir: env.exportsDir }, sessionId);
    const tracks = parseCsv(readFileSync(path.join(r.dir, "audio_tracks.csv"), "utf8"));
    const segs = parseCsv(readFileSync(path.join(r.dir, "speech_segments.csv"), "utf8"));
    expect(tracks.map((t) => t.seat).sort()).toEqual(["1", "3", "4"]);
    expect(segs.some((s) => s.seat === "2")).toBe(false);
    expect(segs.length).toBeGreaterThan(0); // the other seats' segments stay
    // …without naming the erased seat in their overlaps (that would show when it spoke)
    expect(segs.some((s) => (s.overlap_with ?? "").split(" ").includes("2"))).toBe(false);
    expect(readFileSync(path.join(r.dir, "speech_segments.csv"), "utf8")).not.toContain(codes[2]!);
    // session-wide results, and the cleaned tracks (masks from every seat, other voices audible),
    // were computed from every seat: gone, re-run to refresh them
    expect(env.store.listAudioDerivatives(sessionId, { kind: "talk_time" })).toHaveLength(0);
    expect(env.store.listAudioDerivatives(sessionId, { kind: "clean" })).toHaveLength(0);
  });

  it("delete raw audio: typed confirmation, registered, then attribution and export answer 409", async () => {
    const { sessionId } = seeded;
    expect(() => service.deleteAudio(sessionId, { confirm: "S-WRONG", scope: "raw" })).toThrow(
      /does not match/,
    );
    const r = service.deleteAudio(sessionId, {
      confirm: ` ${sessionId} `,
      scope: "raw",
      note: "retention 30 days",
    });
    expect(AudioDeletionRecordSchema.parse(r.record)).toBeTruthy();
    expect(r.record).toMatchObject({ scope: "raw", seats: [1, 3, 4], tracks: 3, note: "retention 30 days" });
    expect(r.record.bytes).toBeGreaterThan(0);
    expect(r.audioExportsOnDisk.length).toBeGreaterThan(0); // WAV exports are the researcher's to delete
    const sum = service.summary(sessionId);
    expect(sum.deletions).toHaveLength(1);
    expect(sum.tracks.every((t) => t.status === "deleted" && t.bytes === 0)).toBe(true);
    expect(sum.derivatives).toHaveLength(0); // cleaned tracks hold sound: deleted with the raw audio
    expect(service.speechSegments(sessionId).segments.length).toBeGreaterThan(0); // timing kept
    expect(() => service.startAttribution(sessionId)).toThrow(/deleted/);
    try {
      service.startAttribution(sessionId);
    } catch (e) {
      expect((e as AudioRequestError).statusCode).toBe(409);
    }
    await expect(service.exportAudio(sessionId, { kind: "raw", requestedBy: "t" })).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("refuses attribution, export and deletion while the session is running", async () => {
    const hub = {
      session: { sessionId: seeded.sessionId, isFinal: false, state: { phase: "round_active" } },
    };
    const live = new AudioService({
      store: env.store,
      hub,
      exportsDir: env.exportsDir,
      runner,
      runTask: runInline,
    });
    for (const fn of [
      () => live.startAttribution(seeded.sessionId),
      () => live.deleteAudio(seeded.sessionId, { confirm: seeded.sessionId, scope: "all" }),
    ])
      expect(fn).toThrow(/still running/);
    await expect(live.exportAudio(seeded.sessionId, { kind: "raw", requestedBy: "t" })).rejects.toThrow(
      /still running/,
    );
  });
});

describe("seqOrderedChunks: streams a track in sample order", () => {
  const env = makeEnv();
  afterAll(() => {
    env.db.close();
    cleanup(env.dir);
  });

  it("puts a late resent chunk back in place, drops duplicates, and skips tampered or missing chunks", async () => {
    const sid = "S-20261118-ORDR";
    const { fileName, key } = await env.files.createFile(sid);
    const n = 160;
    const pcm = (seq: number) => Buffer.from(new Int16Array(n).fill(seq + 1).buffer);
    // file order: 0, 2, 3, 1 (resent late), 3 (duplicate), 5 (seq 4 never arrived), 6
    for (const seq of [0, 2, 3, 1, 3, 5, 6]) await env.files.appendRecord(sid, fileName, key, seq, pcm(seq));
    const chunks = [0, 1, 2, 3, 4, 5, 6].map((seq) => ({
      seq,
      startSample: seq * n,
      sampleCount: n,
      clientTs: seq * 10,
      serverTs: seq * 10,
    }));
    const read = async (maxHeld?: number) => {
      const out: number[] = [];
      for await (const c of seqOrderedChunks(env.files, sid, fileName, key, chunks, { maxHeld }))
        out.push(c.startSample / n);
      return out;
    };
    expect(await read()).toEqual([0, 1, 2, 3, 5, 6]);
    expect(await read(1)).toEqual([0, 2, 3, 5, 6]); // seq 1 came after it was given up on
    // a tampered record is skipped at once (reported), the rest still streams
    const file = env.files.pathOf(sid, fileName);
    const bytes = readFileSync(file);
    bytes[bytes.length - 20] = bytes[bytes.length - 20]! ^ 0xff; // inside seq 6's ciphertext
    writeFileSync(file, bytes);
    const issues: string[] = [];
    const out: number[] = [];
    for await (const c of seqOrderedChunks(env.files, sid, fileName, key, chunks, {
      onIssue: (i) => issues.push(i.kind),
    }))
      out.push(c.startSample / n);
    expect(out).toEqual([0, 1, 2, 3, 5]);
    expect(issues).toEqual(["tag_mismatch"]);
  });
});

describe("audio jobs: lifecycle", () => {
  const env = makeEnv();
  afterAll(() => {
    env.db.close();
    cleanup(env.dir);
  });

  it("a failing job is marked failed, its error scrubbed of codes and its files removed", async () => {
    const seeded = await seedAudioSession(env.store, env.files, { seed: 13, durationSec: 40 });
    const runner = new AudioJobRunner(env.store);
    let created = "";
    const failing: TaskRunner = async (input, hooks) => {
      const f = await env.files.createFile(input.sessionId);
      created = f.fileName;
      hooks.onFile?.(f.fileName);
      hooks.onProgress?.(0.4, "envelopes");
      throw new Error(`could not read the track of ${seeded.codes[1]}`);
    };
    const service = new AudioService({
      store: env.store,
      exportsDir: env.exportsDir,
      runner,
      runTask: failing,
    });
    const job = service.startAttribution(seeded.sessionId);
    await runner.whenIdle();
    const row = env.store.getAudioJob(job.jobId)!;
    expect(row.status).toBe("failed");
    expect(row.error).toContain("[participant code]");
    expect(row.error).not.toMatch(CODE_RE);
    expect(row.finishedWall).not.toBeNull();
    expect(row.params.pendingFiles).toBeUndefined();
    expect(env.files.exists(seeded.sessionId, created)).toBe(false);
    expect(env.store.listAudioDerivatives(seeded.sessionId)).toHaveLength(0);
    // the session is free again
    expect(runner.activeJob(seeded.sessionId)).toBeUndefined();

    // jobs run one at a time: a second session's job waits in the queue
    const slow: TaskRunner = (input, hooks) =>
      new Promise((_resolve, reject) => {
        hooks.onProgress?.(0.5, "x");
        setTimeout(() => reject(new Error(`stopped ${input.sessionId}`)), 50);
      });
    const second = await seedAudioSession(env.store, env.files, { seed: 14, durationSec: 30 });
    const s2 = new AudioService({ store: env.store, exportsDir: env.exportsDir, runner, runTask: slow });
    const a = s2.startAttribution(seeded.sessionId);
    const b = s2.startAttribution(second.sessionId);
    await new Promise((r) => setTimeout(r, 10));
    expect(env.store.getAudioJob(a.jobId)!.status).toBe("running");
    expect(env.store.getAudioJob(b.jobId)!.status).toBe("queued");
    await runner.whenIdle();
    expect(env.store.getAudioJob(b.jobId)!.status).toBe("failed");
  }, 60_000);

  it("on start-up, jobs left running by a stopped server are marked failed and their files removed", async () => {
    const sessionId = env.store.listSessions()[0]!.id;
    const f = await env.files.createFile(sessionId);
    env.store.upsertAudioJob({
      jobId: "stale-job",
      sessionId,
      kind: "attribution",
      status: "running",
      progress: 0.6,
      params: { pendingFiles: [f.fileName] },
      result: null,
      error: null,
    });
    const recovered = new AudioJobRunner(env.store).recoverStale();
    expect(recovered).toEqual(["stale-job"]);
    const row = env.store.getAudioJob("stale-job")!;
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/server stopped/);
    expect(env.files.exists(sessionId, f.fileName)).toBe(false);
  });

  it("scrubs anything code-like from error texts", () => {
    expect(scrubError(new Error("seat WK-7F3K-Q9XM-4 failed"))).toBe("seat [participant code] failed");
    expect(scrubError("x".repeat(900))).toHaveLength(500);
  });
});
