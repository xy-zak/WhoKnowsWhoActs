import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HEADER_BYTES, RECORD_PREFIX_BYTES } from "../src/audio/crypto";
import { verifyAudio } from "../src/audio/verify";
import { openDatabase } from "../src/db/database";
import { Store } from "../src/db/store";
import { deleteSessionAudio, isAudioDerivativeKind, SessionRunningError } from "../src/gdpr/deleteAudio";
import { deleteSession, listSessionDeletions } from "../src/gdpr/deleteSession";
import { listErasures, lookupParticipant } from "../src/gdpr/erase";
import { nowTs, REPO_ROOT, wall } from "../src/runtime";
import { addTrack, type TestTrack } from "./audioFixtures";
import { cleanup, PASSPHRASE, setupSession, startTestServer, type TestServer } from "./harness";

const TSX = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
const CLI = path.join(REPO_ROOT, "apps", "server", "src", "cli.ts");

function cli(srv: TestServer, args: string[]) {
  const r = spawnSync(TSX, [CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      WKWA_DATA_DIR: srv.runtime.dataDir,
      WKWA_EXPORTS_DIR: srv.runtime.exportsDir,
      WKWA_DB_PASSPHRASE: PASSPHRASE,
    },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/** A session row only (not attached to the hub), for the deletion tests. */
function insertBareSession(store: Store): string {
  const id = `S-20261118-${randomUUID().slice(0, 4).toUpperCase()}`;
  store.insertSession({
    id,
    created_wall: wall(nowTs()),
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
  return id;
}

function count(store: Store, sql: string, ...params: unknown[]): number {
  return (store.db.prepare(sql).get(...params) as { n: number }).n;
}

describe("audio: store, GDPR hooks and CLI", () => {
  let srv: TestServer;
  let sessionId: string;
  let codes: Record<number, string>;
  let tracks: Record<number, TestTrack>;
  let fac: Awaited<ReturnType<typeof setupSession>>["fac"];
  let bots: Awaited<ReturnType<typeof setupSession>>["bots"];

  beforeAll(async () => {
    srv = await startTestServer();
    const r = await setupSession(
      srv.url,
      { roundCount: 1, defaultRound: { quota: { propose: 1, decide: 1 } } },
      4,
      { minDelayMs: 5, maxDelayMs: 15 },
    );
    sessionId = r.sessionId;
    fac = r.fac;
    bots = r.bots;
    codes = Object.fromEntries(
      Object.values(srv.ctx.hub.session!.state.seats).map((s) => [s.seat, s.participantCode!]),
    );
    tracks = {};
    for (const seat of [1, 2, 3, 4])
      tracks[seat] = await addTrack(srv.ctx.store, srv.ctx.audioFiles, sessionId, seat, codes[seat]!);
  }, 60_000);

  afterAll(async () => {
    for (const b of bots ?? []) b.stop();
    fac?.close();
    await srv?.close();
    cleanup(srv.dir);
  });

  it("wires the file store into the participant database only", () => {
    expect(srv.ctx.store.audioFiles).toBe(srv.ctx.audioFiles);
    expect(srv.ctx.stores.simulated.audioFiles).toBeNull();
    expect(srv.ctx.audioFiles.root).toBe(path.join(srv.runtime.dataDir, "audio"));
  });

  it("counts audio per session and per participant", async () => {
    const store = srv.ctx.store;
    const t = store.getAudioTrack(tracks[1]!.trackId)!;
    expect(t).toMatchObject({
      seat: 1,
      status: "recording",
      chunks: 3,
      samples: 4800,
      bytes: 9600,
      durationMs: 300,
    });
    expect(t).not.toHaveProperty("fileKey");
    expect(store.getAudioTrackKey(t.trackId)!.equals(tracks[1]!.key)).toBe(true);
    expect(store.listAudioChunks(t.trackId).map((c) => c.seq)).toEqual([0, 1, 2]);
    expect(store.listAudioTracks(sessionId).map((x) => x.seat)).toEqual([1, 2, 3, 4]);
    expect(store.listAudioTracks(sessionId, { seat: 2 })).toHaveLength(1);
    expect(store.closeAudioTrack(t.trackId, { closedServerTs: nowTs(), stopReason: "test" })).toBe(true);
    expect(store.closeAudioTrack(t.trackId, { closedServerTs: nowTs(), stopReason: "again" })).toBe(false);
    expect(store.listSessions().find((s) => s.id === sessionId)).toMatchObject({
      audioTracks: 4,
      audioMs: 1200,
    });
    const occ = lookupParticipant(store, codes[1]!).occurrences;
    expect(occ).toMatchObject([{ sessionId, seat: 1, audioTracks: 1, audioMs: 300 }]);
    expect(occ[0]!.events).toBeGreaterThan(0);
    // the file holds what the database says
    const pcm = await srv.ctx.audioFiles.readTrackPcm(
      sessionId,
      t.fileName!,
      store.getAudioTrackKey(t.trackId)!,
    );
    expect(pcm.pcm.equals(Buffer.concat(tracks[1]!.pcm))).toBe(true);
    // jobs and derivatives
    store.upsertAudioJob({
      jobId: "J-1",
      sessionId,
      kind: "attribution",
      status: "running",
      progress: 0.5,
      params: { margin: 6 },
      result: null,
      error: null,
    });
    store.upsertAudioJob({
      ...store.getAudioJob("J-1")!,
      status: "done",
      progress: 1,
      result: { derivatives: ["D"] },
    });
    expect(store.getAudioJob("J-1")).toMatchObject({
      status: "done",
      progress: 1,
      result: { derivatives: ["D"] },
    });
    expect(store.listAudioJobs(sessionId)).toHaveLength(1);
  });

  it("refuses to delete audio while the session is running", async () => {
    expect(() => deleteSessionAudio(srv.ctx, sessionId, { scope: "raw" })).toThrow(SessionRunningError);
    await fac.cmd("round:start");
    await fac.waitForDashboard((d) => d.state?.phase === "game_complete", 20_000);
    for (const b of bots) await b.flushTelemetry();
  });

  it("verify authenticates every file and reports tampering, orphans and codes in names", async () => {
    const { store, audioFiles } = srv.ctx;
    const ok = await verifyAudio(store, audioFiles);
    expect(ok.problems).toEqual([]);
    expect(ok).toMatchObject({ filesChecked: 4, records: 12, orphans: [] });

    const file = audioFiles.pathOf(sessionId, tracks[2]!.fileName);
    const original = readFileSync(file);
    const tampered = Buffer.from(original);
    tampered[HEADER_BYTES + RECORD_PREFIX_BYTES + 20]! ^= 0xff;
    writeFileSync(file, tampered);
    const bad = await verifyAudio(store, audioFiles);
    expect(bad.problems.some((p) => p.includes("failed authentication"))).toBe(true);
    expect(bad.problems.some((p) => p.includes("have no valid record in the file (seq 0)"))).toBe(true);
    writeFileSync(file, original);

    const orphan = path.join(audioFiles.root, sessionId, `${"f".repeat(32)}.wka`);
    const named = path.join(audioFiles.root, sessionId, `${codes[3]}.wav`);
    writeFileSync(orphan, "x");
    writeFileSync(named, "x");
    const orphans = await verifyAudio(store, audioFiles);
    expect(orphans.orphans.map((o) => o.fileName).sort()).toEqual(
      [`${"f".repeat(32)}.wka`, `${codes[3]}.wav`].sort(),
    );
    expect(
      orphans.problems.some((p) => p.startsWith(`file name ${sessionId}/${codes[3]}.wav contains`)),
    ).toBe(true);
    rmSync(orphan);
    rmSync(named);
    expect((await verifyAudio(store, audioFiles)).problems).toEqual([]);
  });

  it("CLI: backup copies the audio folder, verify checks the audio", () => {
    const out = path.join(srv.dir, "backups", "wkwa-backup.db");
    const b = cli(srv, ["backup", "--out", out]);
    expect(b.status, b.out).toBe(0);
    expect(b.out).toContain(`${out}.audio`);
    for (const seat of [1, 2, 3, 4]) {
      const name = tracks[seat]!.fileName;
      const copy = readFileSync(path.join(`${out}.audio`, sessionId, name));
      expect(copy.equals(readFileSync(srv.ctx.audioFiles.pathOf(sessionId, name)))).toBe(true);
    }
    // the copy is self-contained: its database holds the keys of its files
    const copyDb = openDatabase(out, PASSPHRASE);
    expect(new Store(copyDb).getAudioTrackKey(tracks[4]!.trackId)!.equals(tracks[4]!.key)).toBe(true);
    copyDb.close();
    expect(cli(srv, ["backup", "--out", out]).status).not.toBe(0); // never overwrites

    const v = cli(srv, ["verify"]);
    expect(v.status, v.out).toBe(0);
    expect(v.out).toContain("audio: 4 encrypted files, 12 records authenticated, 0 orphan files");
    expect(v.out).toContain("✓ Database OK");
  }, 60_000);

  it("erasure removes the participant's audio rows, derived results and files", async () => {
    const { store, audioFiles } = srv.ctx;
    const all = [1, 2, 3, 4].map((s) => tracks[s]!.trackId);
    // session-wide speech segments (from every track), a cleaned track of seat 1 and one of seat 2
    store.insertAudioDerivative({
      derivativeId: "D-SEG",
      sessionId,
      seat: null,
      participantCode: null,
      kind: "speech_segments",
      sourceTracks: all,
      fileName: null,
      fileKey: null,
      data: [{ seat: 1, start: 0, end: 100 }],
      params: {},
      engineVersion: "test",
    });
    const clean1 = await audioFiles.createFile(sessionId);
    store.insertAudioDerivative({
      derivativeId: "D-CLEAN-1",
      sessionId,
      seat: 1,
      participantCode: codes[1]!,
      kind: "clean_track",
      sourceTracks: [tracks[1]!.trackId],
      fileName: clean1.fileName,
      fileKey: clean1.key,
      data: null,
      params: {},
      engineVersion: "test",
    });
    const clean2 = await audioFiles.createFile(sessionId);
    store.insertAudioDerivative({
      derivativeId: "D-CLEAN-2",
      sessionId,
      seat: 2,
      participantCode: codes[2]!,
      kind: "clean_track",
      sourceTracks: [tracks[2]!.trackId],
      fileName: clean2.fileName,
      fileKey: clean2.key,
      data: null,
      params: {},
      engineVersion: "test",
    });
    expect(store.getAudioDerivative("D-SEG")).toMatchObject({ hasData: true, data: [{ seat: 1 }] });
    expect(store.listAudioDerivatives(sessionId)[0]).not.toHaveProperty("data");

    const code = codes[1]!;
    const res = await fetch(`${srv.url}/api/participants/${code}/erase`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: code, note: "audio test" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      rows: { audioTracks: number; audioChunks: number; audioDerivatives: number };
      audioFiles: { removed: number; failed: string[] };
    };
    expect(body.rows).toMatchObject({ audioTracks: 1, audioChunks: 3, audioDerivatives: 2 });
    expect(body.audioFiles).toEqual({ removed: 2, failed: [] });

    for (const t of ["audio_tracks", "audio_derivatives", "events", "telemetry"])
      expect(count(store, `SELECT count(*) AS n FROM ${t} WHERE participant_code = ?`, code)).toBe(0);
    expect(
      count(store, "SELECT count(*) AS n FROM audio_chunks WHERE track_id = ?", tracks[1]!.trackId),
    ).toBe(0);
    expect(audioFiles.exists(sessionId, tracks[1]!.fileName)).toBe(false);
    expect(audioFiles.exists(sessionId, clean1.fileName)).toBe(false);
    // computed from seat 1's track too → gone; seat 2's own cleaned track stays
    expect(store.getAudioDerivative("D-SEG")).toBeUndefined();
    expect(store.getAudioDerivative("D-CLEAN-2")).toBeDefined();
    expect(store.listAudioTracks(sessionId).map((t) => t.seat)).toEqual([2, 3, 4]);
    expect(store.codeExists(code)).toBe(false);
    const reg = listErasures(store).at(-1)!;
    expect(reg.rows).toMatchObject({ audioTracks: 1, audioChunks: 3, audioDerivatives: 2, audioFiles: 2 });
    expect((await verifyAudio(store, audioFiles)).problems).toEqual([]);
  });

  it("delete-audio raw: files and keys go, timing metadata and non-audio results stay", async () => {
    const { store, audioFiles } = srv.ctx;
    expect(isAudioDerivativeKind("clean_track")).toBe(true);
    expect(isAudioDerivativeKind("aligned_track")).toBe(true);
    expect(isAudioDerivativeKind("speech_segments")).toBe(false);
    expect(isAudioDerivativeKind("transcript")).toBe(false);
    expect(isAudioDerivativeKind("some_future_kind")).toBe(true); // unknown kinds err on the side of deleting
    store.insertAudioDerivative({
      derivativeId: "D-SEG-2",
      sessionId,
      seat: null,
      participantCode: null,
      kind: "speech_segments",
      sourceTracks: [2, 3, 4].map((s) => tracks[s]!.trackId),
      fileName: null,
      fileKey: null,
      data: [],
      params: {},
      engineVersion: "test",
    });
    const before = store.listAudioTracks(sessionId);

    const r = deleteSessionAudio(srv.ctx, sessionId, { scope: "raw", note: "retention" });
    expect(r.counts).toMatchObject({ tracks: 3, chunks: 0, derivatives: 1, jobs: 0, files: 4, audioMs: 900 });
    expect(r.audioFiles).toEqual({ removed: 4, failed: [], dirRemoved: false });
    const after = store.listAudioTracks(sessionId);
    expect(after.map((t) => t.status)).toEqual(["deleted", "deleted", "deleted"]);
    expect(after.every((t) => !t.hasKey && store.getAudioTrackKey(t.trackId) === null)).toBe(true);
    // timing metadata kept: start times, counters, chunk rows
    expect(after.map((t) => [t.startedServerTs, t.samples, t.chunks])).toEqual(
      before.map((t) => [t.startedServerTs, t.samples, t.chunks]),
    );
    expect(store.listAudioChunks(after[0]!.trackId)).toHaveLength(3);
    for (const t of after) expect(audioFiles.exists(sessionId, t.fileName!)).toBe(false);
    expect(store.getAudioDerivative("D-CLEAN-2")).toBeUndefined();
    expect(store.getAudioDerivative("D-SEG-2")).toBeDefined();
    expect(store.listSessions().find((s) => s.id === sessionId)).toMatchObject({
      audioTracks: 0,
      audioMs: 0,
    });
    // the metadata still carries the codes, so erasure still finds it
    expect(lookupParticipant(store, codes[2]!).occurrences[0]).toMatchObject({ audioTracks: 1 });
    expect(store.listAudioDeletions(sessionId)).toMatchObject([
      { scope: "raw", note: "retention", counts: { tracks: 3, files: 4 } },
    ]);
    // a deleted track takes no more chunks
    expect(() =>
      store.insertAudioChunk({ ...store.listAudioChunks(after[0]!.trackId)[0]!, seq: 99 }),
    ).toThrow(/deleted/);
    expect((await verifyAudio(store, audioFiles)).problems).toEqual([]);
  });

  it("delete-audio all: every audio row, job and the folder go", () => {
    const { store, audioFiles } = srv.ctx;
    const r = deleteSessionAudio(srv.ctx, sessionId, { scope: "all" });
    expect(r.counts).toMatchObject({ tracks: 3, chunks: 9, derivatives: 1, jobs: 1, files: 0 });
    expect(r.audioFiles.dirRemoved).toBe(true);
    for (const t of ["audio_tracks", "audio_derivatives", "audio_jobs"])
      expect(count(store, `SELECT count(*) AS n FROM ${t} WHERE session_id = ?`, sessionId)).toBe(0);
    expect(count(store, "SELECT count(*) AS n FROM audio_chunks")).toBe(0);
    expect(existsSync(path.join(audioFiles.root, sessionId))).toBe(false);
    expect(store.listAudioDeletions(sessionId).map((d) => d.scope)).toEqual(["raw", "all"]);
    expect(() => deleteSessionAudio(srv.ctx, sessionId, { scope: "nope" as "raw" })).toThrow(/scope/);
    expect(() => deleteSessionAudio(srv.ctx, "S-UNKNOWN", { scope: "all" })).toThrow(/Unknown session/);
  });

  it("deleting a session removes its audio rows, jobs and folder, and hashes its audio codes", async () => {
    const { store, audioFiles } = srv.ctx;
    const id = insertBareSession(store);
    const code = "WK-0000-0000-0";
    const t = await addTrack(store, audioFiles, id, 1, code, 2);
    store.upsertAudioJob({
      jobId: "J-DEL",
      sessionId: id,
      kind: "attribution",
      status: "done",
      progress: 1,
      params: {},
      result: null,
      error: null,
    });
    writeFileSync(path.join(audioFiles.root, id, `${"e".repeat(32)}.wka`), "orphan in the same folder");
    const r = deleteSession(store, id, { exportsDir: srv.runtime.exportsDir });
    expect(r.rows).toMatchObject({ audioTracks: 1, audioChunks: 2, audioDerivatives: 0, audioJobs: 1 });
    expect(r.audio).toEqual({ dirRemoved: true, files: 2 });
    expect(existsSync(path.join(audioFiles.root, id))).toBe(false);
    expect(audioFiles.exists(id, t.fileName)).toBe(false);
    expect(store.getAudioTrack(t.trackId)).toBeUndefined();
    expect(store.getAudioJob("J-DEL")).toBeUndefined();
    const entry = listSessionDeletions(store).at(-1)!;
    expect(entry).toMatchObject({ sessionId: id, participants: 1, rows: { audioTracks: 1, audioChunks: 2 } });
  });

  it("CLI: delete-audio needs the typed session id", async () => {
    const { store, audioFiles } = srv.ctx;
    const id = insertBareSession(store);
    const t = await addTrack(store, audioFiles, id, 2, "WK-1111-1111-1", 2);
    const wrong = cli(srv, ["delete-audio", id, "--scope", "raw", "--confirm", "S-WRONG"]);
    expect(wrong.status).toBe(1);
    expect(audioFiles.exists(id, t.fileName)).toBe(true);
    const sim = cli(srv, ["delete-audio", id, "--scope", "raw", "--confirm", id, "--sim"]);
    expect(sim.status).toBe(1);
    const stray = cli(srv, ["delete-audio", id, "S-OTHER", "--scope", "raw", "--confirm", id]);
    expect(stray.out).toContain("Unexpected argument 'S-OTHER'");
    expect(audioFiles.exists(id, t.fileName)).toBe(true);
    const ok = cli(srv, ["delete-audio", id, "--scope", "raw", "--confirm", id]);
    expect(ok.status, ok.out).toBe(0);
    expect(ok.out).toContain("Register entry");
    expect(audioFiles.exists(id, t.fileName)).toBe(false);
    expect(store.getAudioTrack(t.trackId)).toMatchObject({ status: "deleted", hasKey: false, chunks: 2 });
  }, 60_000);
});
