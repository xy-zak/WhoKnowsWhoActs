import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type DB, openDatabase, SCHEMA_VERSION } from "../src/db/database";
import { Store } from "../src/db/store";
import { cleanup } from "./harness";

const PASS = "migration test pass";
const SESSION_COLUMNS = `id, created_wall, scenario_id, scenario_version, scenario_hash, status, condition, notes,
  config_json, harness_version, git_commit, updated_wall`;

describe("database migrations", () => {
  let dir: string;
  let db: DB | undefined;
  afterEach(() => {
    db?.close();
    cleanup(dir);
  });

  /** A database at schema `version` with `sql` run on it, then opened (and migrated) at the current schema. */
  function migrateFrom(version: number, sql: string): DB {
    dir = mkdtempSync(path.join(os.tmpdir(), "wkwa-mig-"));
    const file = path.join(dir, "wkwa.db");
    const old = openDatabase(file, PASS, { targetVersion: version });
    old.prepare(sql).run();
    expect(old.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({
      value: String(version),
    });
    old.close();
    db = openDatabase(file, PASS);
    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({
      value: String(SCHEMA_VERSION),
    });
    return db;
  }

  it("v2 → condition becomes tags_json", () => {
    const db = migrateFrom(
      2,
      `INSERT INTO sessions (${SESSION_COLUMNS})
       VALUES ('S-OLD', '2026-01-01T00:00:00Z', 'demo', '1', 'h', 'closed', 'pilot, A', '', '{"condition":"pilot, A"}', '0', 'x', '2026-01-01T00:00:00Z')`,
    );
    expect(new Store(db).listSessions()[0]!.tags).toEqual(["pilot", "A"]);
  });

  it("v5 → adds the audio tables (v6)", () => {
    const db = migrateFrom(
      5,
      `INSERT INTO sessions (${SESSION_COLUMNS}, tags_json)
       VALUES ('S-V5', '2026-01-01T00:00:00Z', 'demo', '1', 'h', 'closed', '', '', '{}', '0', 'x', '2026-01-01T00:00:00Z', '[]')`,
    );
    const names = (db.prepare("SELECT name FROM sqlite_master").all() as Array<{ name: string }>).map(
      (t) => t.name,
    );
    for (const t of [
      "audio_tracks",
      "audio_chunks",
      "audio_derivatives",
      "audio_jobs",
      "audio_deletions",
      "audio_tracks_session",
      "audio_tracks_code",
      "audio_derivatives_session",
      "audio_derivatives_code",
    ])
      expect(names).toContain(t);

    const store = new Store(db);
    expect(store.listSessions()[0]).toMatchObject({ id: "S-V5", audioTracks: 0, audioMs: 0 });
    store.insertAudioTrack({
      trackId: "T-1",
      sessionId: "S-V5",
      seat: 1,
      participantCode: "WK-7F3K-Q9XM-4",
      fileName: `${"a".repeat(32)}.wka`,
      fileKey: Buffer.alloc(32, 1),
      sampleRate: 16_000,
      settings: {},
      reason: "test",
      startedServerTs: 1,
      startedClientTs: 1,
      clockOffsetMs: 0,
    });
    const chunk = {
      trackId: "T-1",
      seq: 0,
      startSample: 0,
      sampleCount: 80_000,
      clientTs: 1,
      clockOffsetMs: 0,
      serverTs: 2,
      round: 0,
      phase: "lobby",
      rmsDb: -30,
      peakDb: -10,
      clipped: 0,
    };
    expect(store.insertAudioChunk(chunk)).toBe(true);
    expect(store.insertAudioChunk(chunk)).toBe(false); // resent: idempotent
    expect(store.getAudioTrack("T-1")).toMatchObject({
      samples: 80_000,
      chunks: 1,
      bytes: 160_000,
      durationMs: 5000,
    });
    expect(store.listSessions()[0]).toMatchObject({ audioTracks: 1, audioMs: 5000 });
    expect(store.codeExists("WK-7F3K-Q9XM-4")).toBe(true);
    // the status is constrained
    expect(() => db.prepare("UPDATE audio_tracks SET status = 'lost'").run()).toThrow(/CHECK/);
  });

  it("v6 → the export register gains details_json (v7)", () => {
    const db = migrateFrom(
      6,
      `INSERT INTO exports (id, session_id, kind, created_wall, path, code_hashes_json, files_json)
       VALUES ('E-OLD', 'S-V6', 'standard', '2026-01-01T00:00:00Z', 'exports/old', '[]', '[]')`,
    );
    // existing rows get an empty object
    expect(db.prepare("SELECT details_json FROM exports WHERE id = 'E-OLD'").get()).toEqual({
      details_json: "{}",
    });
  });
});
