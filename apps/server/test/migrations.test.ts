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
});
