import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseSessionConfig } from "@wkwa/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HEADER_BYTES, RECORD_PREFIX_BYTES } from "../src/audio/crypto";
import { isAudioDerivativeKind } from "../src/audio/records";
import { verifyAudio } from "../src/audio/verify";
import { openDatabase } from "../src/db/database";
import { PersonalDataMap } from "../src/db/personalData";
import { Store } from "../src/db/store";
import { nowTs, REPO_ROOT } from "../src/runtime";
import { addTrack, insertBareSession, readTrackPcm, type TestTrack } from "./audioFixtures";
import { onboard } from "./direct";
import { cleanup, PASSPHRASE, startTestServer, type TestServer } from "./harness";

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

describe("audio: store, GDPR hooks and CLI", () => {
  let srv: TestServer;
  let sessionId: string;
  let codes: Record<number, string>;
  let tracks: Record<number, TestTrack>;

  beforeAll(async () => {
    srv = await startTestServer();
    // four bound seats (participant codes) in a session that has ended; no clients needed
    const m = srv.ctx.hub.createSession("demo", parseSessionConfig({ seatCount: 4, roundCount: 1 }), "");
    onboard(m);
    m.abort("test");
    sessionId = m.sessionId;
    codes = Object.fromEntries(Object.values(m.state.seats).map((s) => [s.seat, s.participantCode!]));
    tracks = {};
    for (const seat of [1, 2, 3, 4])
      tracks[seat] = await addTrack(srv.ctx.store, srv.ctx.audioFiles, sessionId, seat, codes[seat]!);
  }, 60_000);

  afterAll(async () => {
    await srv?.close();
    cleanup(srv.dir);
  });

  /** A cleaned track (a derivative with its own encrypted file) of one seat. */
  async function addCleanTrack(id: string, seat: number) {
    const { fileName, key } = await srv.ctx.audioFiles.createFile(sessionId);
    srv.ctx.store.insertAudioDerivative({
      derivativeId: id,
      sessionId,
      seat,
      participantCode: codes[seat]!,
      kind: "clean_track",
      sourceTracks: [tracks[seat]!.trackId],
      fileName,
      fileKey: key,
      data: null,
      params: {},
      engineVersion: "test",
    });
  }

  /** Speech segments of the whole session (no file), computed from the given seats' tracks. */
  function addSegments(id: string, seats: number[]) {
    srv.ctx.store.insertAudioDerivative({
      derivativeId: id,
      sessionId,
      seat: null,
      participantCode: null,
      kind: "speech_segments",
      sourceTracks: seats.map((s) => tracks[s]!.trackId),
      fileName: null,
      fileKey: null,
      data: [{ seat: 1, start: 0, end: 100 }],
      params: {},
      engineVersion: "test",
    });
  }

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
    const occ = new PersonalDataMap(store).lookup(codes[1]!).occurrences;
    expect(occ).toMatchObject([{ sessionId, seat: 1, audioTracks: 1, audioMs: 300 }]);
    expect(occ[0]!.events).toBeGreaterThan(0);
    // the file holds what the database says
    const pcm = await readTrackPcm(
      srv.ctx.audioFiles,
      sessionId,
      t.fileName!,
      store.getAudioTrackKey(t.trackId)!,
    );
    expect(pcm.pcm.equals(Buffer.concat(tracks[1]!.pcm))).toBe(true);
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

  it("REST erasure reports the participant's audio rows, derived results and files it removed", async () => {
    const { store, audioFiles } = srv.ctx;
    // session-wide speech segments (from every track), a cleaned track of seat 1 and one of seat 2
    addSegments("D-SEG", [1, 2, 3, 4]);
    await addCleanTrack("D-CLEAN-1", 1);
    await addCleanTrack("D-CLEAN-2", 2);
    expect(store.getAudioDerivative("D-SEG")).toMatchObject({ hasData: true, data: [{ seat: 1 }] });
    expect(store.listAudioDerivatives(sessionId)[0]).not.toHaveProperty("data");

    const code = codes[1]!;
    const res = await srv.api("POST", `/api/participants/${code}/erase`, {
      confirm: code,
      note: "audio test",
    });
    expect(res.status).toBe(200);
    expect(res.json.rows).toMatchObject({ audioTracks: 1, audioChunks: 3, audioDerivatives: 2 });
    expect(res.json.audioFiles).toEqual({ removed: 2, failed: [] });
    expect((await verifyAudio(store, audioFiles)).problems).toEqual([]);
  });

  it("delete-audio raw: files and keys go, timing metadata and non-audio results stay", async () => {
    const { store, audioFiles } = srv.ctx;
    expect(isAudioDerivativeKind("some_future_kind")).toBe(true); // unknown kinds err on the side of deleting
    addSegments("D-SEG-2", [2, 3, 4]);
    const before = store.listAudioTracks(sessionId);

    const r = new PersonalDataMap(srv.ctx.store).deleteAudio(sessionId, { scope: "raw", note: "retention" });
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
    expect(new PersonalDataMap(store).lookup(codes[2]!).occurrences[0]).toMatchObject({ audioTracks: 1 });
    expect(store.listAudioDeletions(sessionId)).toMatchObject([
      { scope: "raw", note: "retention", counts: { tracks: 3, files: 4 } },
    ]);
    // a deleted track takes no more chunks
    expect(() =>
      store.insertAudioChunk({ ...store.listAudioChunks(after[0]!.trackId)[0]!, seq: 99 }),
    ).toThrow(/deleted/);
    expect((await verifyAudio(store, audioFiles)).problems).toEqual([]);
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
