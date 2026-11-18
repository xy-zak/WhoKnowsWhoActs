import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase, SCHEMA_VERSION } from "../src/db/database";
import { Store } from "../src/db/store";
import { cleanup } from "./harness";

describe("database migrations", () => {
  it("upgrades a schema-v2 database: condition → tags_json", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "wkwa-mig-"));
    const file = path.join(dir, "wkwa.db");
    const v2 = openDatabase(file, "migration test pass", { targetVersion: 2 });
    v2.prepare(
      `INSERT INTO sessions (id, created_wall, scenario_id, scenario_version, scenario_hash, status, condition, notes,
        config_json, harness_version, git_commit, updated_wall)
       VALUES ('S-OLD', '2026-01-01T00:00:00Z', 'demo', '1', 'h', 'closed', 'pilot, A', '', '{"condition":"pilot, A"}', '0', 'x', '2026-01-01T00:00:00Z')`,
    ).run();
    expect(v2.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({ value: "2" });
    v2.close();

    const db = openDatabase(file, "migration test pass");
    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({
      value: String(SCHEMA_VERSION),
    });
    const s = new Store(db).listSessions()[0]!;
    expect(s.tags).toEqual(["pilot", "A"]);
    db.close();
    cleanup(dir);
  });

  it("upgrades a schema-v5 database: adds the audio tables (v6)", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "wkwa-mig-"));
    const file = path.join(dir, "wkwa.db");
    const v5 = openDatabase(file, "migration test pass", { targetVersion: 5 });
    v5.prepare(
      `INSERT INTO sessions (id, created_wall, scenario_id, scenario_version, scenario_hash, status, condition, notes,
        config_json, harness_version, git_commit, updated_wall, tags_json)
       VALUES ('S-V5', '2026-01-01T00:00:00Z', 'demo', '1', 'h', 'closed', '', '', '{}', '0', 'x', '2026-01-01T00:00:00Z', '[]')`,
    ).run();
    const tablesV5 = v5.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
      name: string;
    }>;
    expect(tablesV5.map((t) => t.name)).not.toContain("audio_tracks");
    v5.close();

    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(6);
    const db = openDatabase(file, "migration test pass");
    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({
      value: String(SCHEMA_VERSION),
    });
    const names = (db.prepare("SELECT name FROM sqlite_master").all() as Array<{ name: string }>).map(
      (t) => t.name,
    );
    for (const t of ["audio_tracks", "audio_chunks", "audio_derivatives", "audio_jobs", "audio_deletions"])
      expect(names).toContain(t);
    for (const i of [
      "audio_tracks_session",
      "audio_tracks_code",
      "audio_derivatives_session",
      "audio_derivatives_code",
    ])
      expect(names).toContain(i);

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
    db.close();
    cleanup(dir);
  });

  it("upgrades a schema-v6 database: the export register gains details_json (v7)", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "wkwa-mig-"));
    const file = path.join(dir, "wkwa.db");
    const v6 = openDatabase(file, "migration test pass", { targetVersion: 6 });
    v6.prepare(
      `INSERT INTO exports (id, session_id, kind, created_wall, path, code_hashes_json, files_json)
       VALUES ('E-OLD', 'S-V6', 'standard', '2026-01-01T00:00:00Z', 'exports/old', '[]', '[]')`,
    ).run();
    v6.close();

    expect(SCHEMA_VERSION).toBe(7);
    const db = openDatabase(file, "migration test pass");
    expect(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()).toEqual({ value: "7" });
    // existing rows get an empty object; audio exports record who asked and what was exported
    expect(db.prepare("SELECT details_json FROM exports WHERE id = 'E-OLD'").get()).toEqual({
      details_json: "{}",
    });
    db.prepare(
      `INSERT INTO exports (id, session_id, kind, created_wall, path, code_hashes_json, files_json, details_json)
       VALUES ('AU-NEW', 'S-V6', 'audio', '2026-01-02T00:00:00Z', 'exports/new', '[]', '[]', '{"audioKind":"raw"}')`,
    ).run();
    expect(db.prepare("SELECT count(*) AS n FROM exports").get()).toEqual({ n: 2 });
    db.close();
    cleanup(dir);
  });
});
