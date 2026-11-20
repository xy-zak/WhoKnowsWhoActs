import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AudioDerivativeKind, SpeechSegmentRow } from "@wkwa/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HttpError } from "../src/api/http";
import { AudioJobRunner, runInWorker, scrubError, type TaskRunner } from "../src/audio/jobs";
import { seqOrderedChunks } from "../src/audio/jobWorker";
import { AudioService } from "../src/audio/service";
import { parseWavHeader } from "../src/audio/wav";
import { PersonalDataMap } from "../src/db/personalData";
import { exportSession } from "../src/gdpr/exporter";
import { SessionGuard } from "../src/session/sessionGuard";
import { insertBareSession, readTrackPcm, tempStore } from "./audioFixtures";
import { type SeededSession, seedAudioSession } from "./audioSession";
import { readCsv } from "./harness";

const CODE_RE = /WK-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]/;

const scenarios = {
  load: () => {
    throw new Error("no scenario in this test");
  },
} as unknown as Parameters<typeof exportSession>[0]["scenarios"];

describe("audio processing: jobs, derivatives, export", () => {
  const env = tempStore();
  const runner = new AudioJobRunner(env.store);
  const guard = new SessionGuard({ hub: null, jobs: runner });
  const service = new AudioService({
    store: env.store,
    guard,
    exportsDir: env.exportsDir,
    runner,
    runTask: runInWorker,
    speechModel: false,
  });
  let seeded: SeededSession;

  beforeAll(async () => {
    seeded = await seedAudioSession(env.store, env.files, { seed: 11, durationSec: 70 });
  }, 60_000);

  afterAll(async () => {
    await runner.close();
    env.close();
  });

  it("runs the attribution in a worker thread and stores encrypted, per-seat derivatives", async () => {
    const { sessionId, codes } = seeded;
    const queued = service.startAttribution(sessionId);
    expect(queued.status).toBe("queued");
    expect(() => service.startAttribution(sessionId)).toThrow(HttpError); // one job per session
    await runner.whenIdle();
    const job = service.job(queued.jobId);
    expect(job.status).toBe("done");
    expect(job.progress).toBe(1);
    expect(job).toMatchObject({
      jobId: queued.jobId,
      kind: "attribution",
      error: null,
      finishedWall: expect.any(String),
    });
    const s = job.summary!;
    expect(s.segments).toBeGreaterThan(10);
    expect(Object.keys(s.talkTimeMs).sort()).toEqual(["1", "2", "3", "4"]);
    expect(s.quality.calibrated).toBe(true);
    expect(s.quality.perSeat).toHaveLength(4);
    expect(["good", "fair", "poor"]).toContain(s.grade);

    const kinds = (k: AudioDerivativeKind) => env.store.listAudioDerivatives(sessionId, { kind: k });
    for (const k of ["talk_time", "quality_report", "leakage_matrix"] as const) {
      expect(kinds(k)).toHaveLength(1);
      expect(kinds(k)[0]!.participantCode).toBeNull();
    }
    const segs = kinds("speech_segments");
    expect(segs.map((d) => d.seat).sort()).toEqual([1, 2, 3, 4]);
    for (const d of segs) {
      expect(d.participantCode).toBe(codes[d.seat!]);
      expect(d.sourceTracks).toEqual(seeded.trackIds[d.seat!]);
      expect(d.hasKey).toBe(false);
      expect(d.engineVersion).toMatch(/^wkwa-gate-attribution\//);
    }
    const clean = kinds("clean");
    expect(clean).toHaveLength(4);
    for (const d of clean) {
      expect(d.hasKey).toBe(true);
      expect(d.fileName).toMatch(/^[0-9a-f]{32}\.wka$/);
      const key = env.store.getAudioDerivativeKey(d.derivativeId)!;
      const { pcm, issues } = await readTrackPcm(env.files, sessionId, d.fileName!, key);
      expect(issues).toEqual([]);
      expect(pcm.length).toBe((d.params.samples as number) * 2);
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

  it("summary: tracks, cleaned tracks, jobs and per-seat totals, typed by the shared schemas, no keys or codes", async () => {
    const sum = await service.summary(seeded.sessionId);
    expect(sum).toMatchObject({
      sessionId: seeded.sessionId,
      jobs: expect.any(Array),
      deletions: expect.any(Array),
    });
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
    expect(new PersonalDataMap(env.store).lookup(codes[3]!).exports.map((e) => e.id)).toContain(r.exportId);

    await expect(
      service.exportAudio(sessionId, { kind: "raw", seats: [9], requestedBy: "t" }),
    ).rejects.toThrow(/Seat 9 has no audio/);
    expect((await service.summary(sessionId)).audioExports).toHaveLength(1);
  }, 60_000);

  it("a damaged record of a cleaned track plays as silence in its own place, the rest stays aligned", async () => {
    const { sessionId } = seeded;
    const exportSeat1 = async () => {
      const r = await service.exportAudio(sessionId, { kind: "clean", seats: [1], requestedBy: "test" });
      expect(readdirSync(path.dirname(r.dir)).some((n) => n.endsWith(".partial"))).toBe(false);
      const bytes = readFileSync(path.join(r.dir, r.files[0]!.name));
      return { r, pcm: new Int16Array(bytes.buffer, bytes.byteOffset + 44, (bytes.length - 44) / 2) };
    };
    const before = await exportSeat1();
    const d = env.store.listAudioDerivatives(sessionId, { kind: "clean" }).find((x) => x.seat === 1)!;
    const file = env.files.pathOf(sessionId, d.fileName!);
    const bytes = readFileSync(file);
    const at = Math.floor(bytes.length / 2);
    bytes[at] = bytes[at]! ^ 0xff;
    writeFileSync(file, bytes);
    const after = await exportSeat1();
    expect(after.r.warnings.some((w) => w.includes("damaged records"))).toBe(true);
    expect(after.pcm.length).toBe(before.pcm.length);
    const changed: number[] = [];
    for (let i = 0; i < before.pcm.length; i++) if (after.pcm[i] !== before.pcm[i]) changed.push(i);
    expect(changed.length).toBeGreaterThan(0);
    // one 5 s record, now silent; everything after it is unchanged (not shifted forward)
    const block = Math.floor(changed[0]! / 80_000);
    expect(changed.every((i) => Math.floor(i / 80_000) === block)).toBe(true);
    expect(after.pcm.subarray(block * 80_000, (block + 1) * 80_000).every((v) => v === 0)).toBe(true);
    // restore the file for the tests below
    bytes[at] = bytes[at]! ^ 0xff;
    writeFileSync(file, bytes);
  }, 60_000);

  it("CSV exports gain audio_tracks.csv and speech_segments.csv (pseudonymised like the other files)", () => {
    const { sessionId, codes } = seeded;
    const deps = { store: env.store, scenarios, exportsDir: env.exportsDir };
    const std = exportSession(deps, sessionId);
    const tracks = readCsv(std.dir, "audio_tracks.csv");
    expect(tracks).toHaveLength(4);
    expect(tracks.map((t) => t.participant_code).sort()).toEqual(Object.values(codes).sort());
    expect(
      tracks.every((t) => t.status === "closed" && t.sample_rate === "16000" && t.echo_cancellation === "0"),
    ).toBe(true);
    const segs = readCsv(std.dir, "speech_segments.csv");
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
    const aTracks = readCsv(anon.dir, "audio_tracks.csv");
    const aSegs = readCsv(anon.dir, "speech_segments.csv");
    expect(aTracks.every((t) => /^A-[0-9A-Z]{6}$/.test(t.participant_code!))).toBe(true);
    // the same random id per participant across the files of one export
    const bySeat = new Map(aTracks.map((t) => [t.seat, t.participant_code]));
    expect(aSegs.every((s) => bySeat.get(s.seat) === s.participant_code)).toBe(true);
  });

  it("writes every audio_tracks.csv and speech_segments.csv column from its own field", async () => {
    const id = "S-20261118-COLS";
    insertBareSession(env.store, id);
    const t0 = 1_800_000_000_000;
    const { fileName, key } = await env.files.createFile(id);
    const trackId = "11111111-2222-4333-8444-555555555555";
    env.store.insertAudioTrack({
      trackId,
      sessionId: id,
      seat: 3,
      participantCode: "WK-COLS-0003-X",
      fileName,
      fileKey: key,
      sampleRate: 16_000,
      settings: {
        sampleRate: 44_100,
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: false,
        channelCount: 2,
      },
      reason: "reconnect",
      startedServerTs: t0,
      startedClientTs: t0 - 37,
      clockOffsetMs: 0,
    });
    // seqs 0 and 4: three chunks missing, more than the two the browser dropped
    for (const seq of [0, 4])
      env.store.insertAudioChunk({
        trackId,
        seq,
        startSample: seq * 1600,
        sampleCount: 1600,
        clientTs: t0 - 37 + seq * 100,
        clockOffsetMs: 0,
        serverTs: t0 + seq * 100,
        round: 1,
        phase: "round_active",
        rmsDb: -20,
        peakDb: -6,
        clipped: 0,
      });
    env.store.closeAudioTrack(trackId, {
      closedServerTs: t0 + 9000,
      stopReason: "disconnect",
      droppedChunks: 2,
    });
    env.store.insertAudioDerivative({
      derivativeId: "D-COLS",
      sessionId: id,
      seat: 3,
      participantCode: "WK-COLS-0003-X",
      kind: "speech_segments",
      sourceTracks: [trackId],
      fileName: null,
      fileKey: null,
      data: {
        segments: [
          {
            seat: 3,
            startTs: t0 + 100,
            endTs: t0 + 900,
            durationMs: 800,
            round: 1,
            phase: "round_active",
            paused: false,
            recordingPaused: true,
            meanDb: -23.5,
            confidence: 0.75,
            overlap: true,
            overlapMs: 120,
            overlapWith: [],
          },
        ],
      },
      params: {},
      engineVersion: "test-engine",
    });
    const r = exportSession({ store: env.store, scenarios, exportsDir: env.exportsDir }, id);
    expect(readCsv(r.dir, "audio_tracks.csv")).toEqual([
      {
        session_id: id,
        seat: "3",
        participant_code: "WK-COLS-0003-X",
        track_id: trackId,
        status: "interrupted",
        start_reason: "reconnect",
        stop_reason: "disconnect",
        started_server_ts: String(t0),
        first_sample_ts: String(t0 - 37),
        closed_server_ts: String(t0 + 9000),
        duration_ms: "200",
        samples: "3200",
        chunks: "2",
        dropped_chunks: "2",
        gaps: "3",
        sample_rate: "16000",
        capture_sample_rate: "44100",
        echo_cancellation: "0",
        noise_suppression: "1",
        auto_gain_control: "0",
        channel_count: "2",
      },
    ]);
    expect(readCsv(r.dir, "speech_segments.csv")).toEqual([
      {
        session_id: id,
        seat: "3",
        participant_code: "WK-COLS-0003-X",
        start_server_ts: String(t0 + 100),
        end_server_ts: String(t0 + 900),
        duration_ms: "800",
        round: "1",
        phase: "round_active",
        paused: "0",
        recording_paused: "1",
        mean_db: "-23.5",
        confidence: "0.75",
        overlap: "1",
        overlap_ms: "120",
        overlap_with: "",
        engine_version: "test-engine",
      },
    ]);
  });

  it("a session without audio has nothing to attribute", () => {
    const id = insertBareSession(env.store);
    expect(() => service.startAttribution(id)).toThrow(/no audio/);
  });

  it("raw export before any attribution uses the timestamps; clean export needs an attribution", async () => {
    const fresh = await seedAudioSession(
      env.store,
      env.files,
      { seed: 12, durationSec: 40 },
      { calibration: false },
    );
    const pending = service.exportAudio(fresh.sessionId, { kind: "raw", requestedBy: "test" });
    // the export is registered with the guard that erasure and session deletion share
    expect(guard.deleteSession(fresh.sessionId, () => "deleted")).toMatchObject({
      ok: false,
      reason: "exporting",
    });
    // while the WAVs are being written, nothing may delete or replace what they are read from
    expect(() => service.deleteAudio(fresh.sessionId, { confirm: fresh.sessionId, scope: "all" })).toThrow(
      /export of this session is being written/,
    );
    expect(() => service.startAttribution(fresh.sessionId)).toThrow(/being written/);
    const r = await pending;
    expect(guard.check("delete-audio", fresh.sessionId).ok).toBe(true);
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
    new PersonalDataMap(env.store).erase(codes[2]!, "test");
    const r = exportSession({ store: env.store, scenarios, exportsDir: env.exportsDir }, sessionId);
    const tracks = readCsv(r.dir, "audio_tracks.csv");
    const segs = readCsv(r.dir, "speech_segments.csv");
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
    // in the database too: kept segments no longer name seat 2, job summaries (talk time per seat) are cleared
    for (const d of env.store.listAudioDerivatives(sessionId, { kind: "speech_segments" })) {
      const data = env.store.getAudioDerivative(d.derivativeId)!.data as { segments: SpeechSegmentRow[] };
      expect(data.segments.some((x) => x.overlapWith.includes(2))).toBe(false);
    }
    expect(env.store.listAudioJobs(sessionId).every((j) => j.result === null)).toBe(true);
  });
});

describe("seqOrderedChunks: streams a track in sample order", () => {
  const env = tempStore();
  afterAll(() => env.close());

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
  const env = tempStore();
  afterAll(() => env.close());

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
    expect(row.error).toBe("could not read the track of [participant code]");
    expect(scrubError("x".repeat(900))).toHaveLength(500); // and cut short
    expect(row.finishedWall).not.toBeNull();
    expect(row.params.pendingFiles).toBeUndefined();
    expect(env.files.exists(seeded.sessionId, created)).toBe(false);
    expect(env.store.listAudioDerivatives(seeded.sessionId)).toHaveLength(0);
    // the session is free again
    expect(runner.activeJob(seeded.sessionId)).toBeUndefined();

    // jobs run one at a time: a second session's job waits in the queue
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let started!: () => void;
    const firstStarted = new Promise<void>((r) => (started = r));
    const slow: TaskRunner = async (input, hooks) => {
      hooks.onProgress?.(0.5, "x");
      started();
      await gate;
      throw new Error(`stopped ${input.sessionId}`);
    };
    const second = await seedAudioSession(env.store, env.files, { seed: 14, durationSec: 30 });
    const s2 = new AudioService({ store: env.store, exportsDir: env.exportsDir, runner, runTask: slow });
    const a = s2.startAttribution(seeded.sessionId);
    const b = s2.startAttribution(second.sessionId);
    await firstStarted;
    expect(env.store.getAudioJob(a.jobId)!.status).toBe("running");
    expect(env.store.getAudioJob(b.jobId)!.status).toBe("queued");
    open();
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

  it("on start-up, half-written audio export folders are removed", () => {
    const partial = path.join(env.exportsDir, "S-20261118-PART", "audio-AU-20261118-120000-ABCD.partial");
    const done = path.join(env.exportsDir, "S-20261118-PART", "audio-AU-20261118-110000-ABCD");
    for (const d of [partial, done]) {
      mkdirSync(d, { recursive: true });
      writeFileSync(path.join(d, "x.wav"), "x");
    }
    new AudioService({ store: env.store, exportsDir: env.exportsDir, runner: new AudioJobRunner(env.store) });
    expect(existsSync(partial)).toBe(false);
    expect(existsSync(done)).toBe(true);
  });
});
