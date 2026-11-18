import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { normaliseTags } from "@wkwa/shared";
import Database from "better-sqlite3-multiple-ciphers";

export type DB = Database.Database;

export class WrongPassphraseError extends Error {
  constructor() {
    super(
      "Could not open the database: wrong passphrase (or the file is not a Who Knows, Who Acts? database).",
    );
  }
}

export const SCHEMA_VERSION = 6;

/** A migration is SQL, or a function for data changes that need JavaScript. */
const MIGRATIONS: Record<number, string | ((db: DB) => void)> = {
  1: `
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

    CREATE TABLE sessions (
      id               TEXT PRIMARY KEY,
      created_wall     TEXT NOT NULL,
      scenario_id      TEXT NOT NULL,
      scenario_version TEXT NOT NULL,
      scenario_hash    TEXT NOT NULL,
      status           TEXT NOT NULL,
      condition        TEXT NOT NULL DEFAULT '',
      notes            TEXT NOT NULL DEFAULT '',
      config_json      TEXT NOT NULL,
      harness_version  TEXT NOT NULL,
      git_commit       TEXT NOT NULL,
      updated_wall     TEXT NOT NULL
    );

    CREATE TABLE events (
      session_id       TEXT NOT NULL REFERENCES sessions(id),
      seq              INTEGER NOT NULL,
      type             TEXT NOT NULL,
      actor_kind       TEXT NOT NULL,
      seat             INTEGER,
      participant_code TEXT,
      round            INTEGER NOT NULL,
      server_ts        REAL NOT NULL,
      server_wall      TEXT NOT NULL,
      client_ts        REAL,
      client_seq       INTEGER,
      payload_json     TEXT NOT NULL,
      PRIMARY KEY (session_id, seq)
    );
    CREATE INDEX events_code ON events(participant_code);

    CREATE TABLE telemetry (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id       TEXT NOT NULL REFERENCES sessions(id),
      seat             INTEGER NOT NULL,
      participant_code TEXT NOT NULL,
      round            INTEGER NOT NULL,
      type             TEXT NOT NULL,
      client_ts        REAL NOT NULL,
      client_offset_ms REAL NOT NULL,
      server_ts        REAL NOT NULL,
      server_wall      TEXT NOT NULL,
      payload_json     TEXT NOT NULL
    );
    CREATE INDEX telemetry_code ON telemetry(participant_code);
    CREATE INDEX telemetry_session ON telemetry(session_id, id);

    CREATE TABLE erasures (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      code_sha256    TEXT NOT NULL,
      requested_wall TEXT NOT NULL,
      executed_wall  TEXT NOT NULL,
      sessions_json  TEXT NOT NULL,
      rows_json      TEXT NOT NULL,
      note           TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE exports (
      id               TEXT PRIMARY KEY,
      session_id       TEXT NOT NULL,
      kind             TEXT NOT NULL,
      created_wall     TEXT NOT NULL,
      path             TEXT NOT NULL,
      code_hashes_json TEXT NOT NULL,
      files_json       TEXT NOT NULL
    );
  `,
  2: `
    -- high-water mark of events.seq: seq numbers are never reused, even after an erasure
    ALTER TABLE sessions ADD COLUMN last_seq INTEGER NOT NULL DEFAULT 0;
    UPDATE sessions SET last_seq = coalesce((SELECT max(seq) FROM events WHERE events.session_id = sessions.id), 0);
  `,
  // v3: free-text `condition` becomes a list of tags (the old column stays, unused)
  3: (db) => {
    db.exec("ALTER TABLE sessions ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]'");
    const rows = db.prepare("SELECT id, condition FROM sessions").all() as Array<{
      id: string;
      condition: string;
    }>;
    const upd = db.prepare("UPDATE sessions SET tags_json = ? WHERE id = ?");
    for (const r of rows) upd.run(JSON.stringify(normaliseTags(r.condition ?? "")), r.id);
  },
  // v4: register of deleted sessions (to re-apply a deletion after restoring a backup)
  4: `
    CREATE TABLE session_deletions (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id       TEXT NOT NULL,
      deleted_wall     TEXT NOT NULL,
      created_wall     TEXT NOT NULL,
      rows_json        TEXT NOT NULL,
      code_hashes_json TEXT NOT NULL,
      exports_json     TEXT NOT NULL,
      note             TEXT NOT NULL DEFAULT ''
    );
  `,
  // v5: find seat bindings (e.g. fake players for the session list) without scanning every event
  5: `
    CREATE INDEX events_type ON events(type, session_id, seq);
  `,
  // v6: microphone audio. The audio itself is in encrypted files (data/audio/<session>/<fileId>.wka);
  // these tables hold each file's key and the metadata. Codes appear only in participant_code columns.
  6: `
    -- one continuous capture run of one seat (a new track after a reload, a pause or a lost permission)
    CREATE TABLE audio_tracks (
      track_id          TEXT PRIMARY KEY,
      session_id        TEXT NOT NULL REFERENCES sessions(id),
      seat              INTEGER NOT NULL,
      participant_code  TEXT NOT NULL,
      file_name         TEXT,
      file_key          BLOB,
      sample_rate       INTEGER NOT NULL,
      settings_json     TEXT NOT NULL DEFAULT '{}',
      reason            TEXT NOT NULL DEFAULT '',
      started_server_ts REAL NOT NULL,
      started_client_ts REAL NOT NULL,
      clock_offset_ms   REAL NOT NULL,
      closed_server_ts  REAL,
      stop_reason       TEXT,
      samples           INTEGER NOT NULL DEFAULT 0,
      chunks            INTEGER NOT NULL DEFAULT 0,
      dropped_chunks    INTEGER NOT NULL DEFAULT 0,
      bytes             INTEGER NOT NULL DEFAULT 0,
      status            TEXT NOT NULL DEFAULT 'recording' CHECK (status IN ('recording', 'closed', 'deleted'))
    );
    CREATE INDEX audio_tracks_session ON audio_tracks(session_id, seat);
    CREATE INDEX audio_tracks_code ON audio_tracks(participant_code);

    -- one chunk (about 5 s) of a track; the PCM is record <seq> of the track's file. Idempotent per (track, seq).
    CREATE TABLE audio_chunks (
      track_id        TEXT NOT NULL REFERENCES audio_tracks(track_id),
      seq             INTEGER NOT NULL,
      start_sample    INTEGER NOT NULL,
      sample_count    INTEGER NOT NULL,
      client_ts       REAL NOT NULL,
      clock_offset_ms REAL NOT NULL,
      server_ts       REAL NOT NULL,
      server_wall     TEXT NOT NULL,
      round           INTEGER NOT NULL,
      phase           TEXT NOT NULL,
      rms_db          REAL,
      peak_db         REAL,
      clipped         INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (track_id, seq)
    );

    -- results computed from tracks: speech segments, cleaned or aligned tracks, later transcripts.
    -- A result is either an encrypted file (file_name + file_key) or small JSON (data_json).
    CREATE TABLE audio_derivatives (
      derivative_id      TEXT PRIMARY KEY,
      session_id         TEXT NOT NULL REFERENCES sessions(id),
      seat               INTEGER,
      participant_code   TEXT,
      kind               TEXT NOT NULL,
      source_tracks_json TEXT NOT NULL DEFAULT '[]',
      file_name          TEXT,
      file_key           BLOB,
      data_json          TEXT,
      params_json        TEXT NOT NULL DEFAULT '{}',
      engine_version     TEXT NOT NULL,
      created_server_ts  REAL NOT NULL,
      created_wall       TEXT NOT NULL
    );
    CREATE INDEX audio_derivatives_session ON audio_derivatives(session_id, kind);
    CREATE INDEX audio_derivatives_code ON audio_derivatives(participant_code);

    -- processing runs (e.g. speaker attribution) started from the DATABASE tab
    CREATE TABLE audio_jobs (
      job_id        TEXT PRIMARY KEY,
      session_id    TEXT NOT NULL REFERENCES sessions(id),
      kind          TEXT NOT NULL,
      status        TEXT NOT NULL,
      progress      REAL NOT NULL DEFAULT 0,
      params_json   TEXT NOT NULL DEFAULT '{}',
      result_json   TEXT,
      error         TEXT,
      started_wall  TEXT NOT NULL,
      finished_wall TEXT
    );
    CREATE INDEX audio_jobs_session ON audio_jobs(session_id, started_wall);

    -- register of audio deletions ("delete raw audio" / "delete all audio" of a session)
    CREATE TABLE audio_deletions (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id     TEXT NOT NULL,
      scope          TEXT NOT NULL CHECK (scope IN ('raw', 'all')),
      requested_wall TEXT NOT NULL,
      executed_wall  TEXT NOT NULL,
      counts_json    TEXT NOT NULL,
      note           TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX audio_deletions_session ON audio_deletions(session_id);
  `,
};

function applyKey(db: DB, passphrase: string) {
  db.pragma("cipher='sqlcipher'");
  db.pragma("legacy=4");
  db.key(Buffer.from(passphrase, "utf8"));
}

/**
 * Open (or create) the SQLCipher-encrypted database.
 * The passphrase never touches disk; a wrong passphrase throws WrongPassphraseError.
 */
export function openDatabase(file: string, passphrase: string, opts: { targetVersion?: number } = {}): DB {
  if (!passphrase) throw new Error("A database passphrase is required.");
  mkdirSync(path.dirname(file), { recursive: true });
  const isNew = !existsSync(file);
  const db = new Database(file);
  applyKey(db, passphrase);
  try {
    db.prepare("SELECT count(*) FROM sqlite_master").get();
  } catch {
    db.close();
    throw new WrongPassphraseError();
  }
  db.pragma("journal_mode = WAL");
  db.pragma("secure_delete = ON");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = FULL");
  migrate(db, isNew, opts.targetVersion ?? SCHEMA_VERSION);
  return db;
}

function migrate(db: DB, isNew: boolean, target: number) {
  const hasMeta = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'").get();
  let version = 0;
  if (hasMeta) {
    const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as
      | { value: string }
      | undefined;
    version = row ? Number(row.value) : 0;
  } else if (!isNew) {
    // An existing file without meta: refuse rather than guess.
    const tables = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get() as {
      n: number;
    };
    if (tables.n > 0) throw new Error("Database has unknown structure; refusing to migrate.");
  }
  for (let v = version + 1; v <= target; v++) {
    const sql = MIGRATIONS[v];
    if (!sql) throw new Error(`Missing migration ${v}`);
    db.transaction(() => {
      if (typeof sql === "function") sql(db);
      else db.exec(sql);
      if (v === 1) {
        db.prepare("INSERT INTO meta(key, value) VALUES ('server_secret', ?)").run(
          randomBytes(32).toString("hex"),
        );
        db.prepare("INSERT INTO meta(key, value) VALUES ('created_wall', ?)").run(new Date().toISOString());
      }
      db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('schema_version', ?)").run(String(v));
    })();
  }
}

export function getMeta(db: DB, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

/**
 * Change the database passphrase in place. Audio files need nothing: each is
 * encrypted with its own random key, and those keys are rows inside this
 * database, so they are re-encrypted along with it.
 */
export function rekeyDatabase(db: DB, newPassphrase: string) {
  if (!newPassphrase) throw new Error("New passphrase must not be empty.");
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.pragma("journal_mode = DELETE");
  db.rekey(Buffer.from(newPassphrase, "utf8"));
  db.pragma("journal_mode = WAL");
}

/**
 * Write an encrypted, consistent copy of the database (same cipher and passphrase).
 * SQLite's online-backup API cannot target a new encrypted file, but
 * SQLite3MultipleCiphers' `VACUUM INTO` writes the copy with the source's encryption.
 */
export async function backupDatabase(db: DB, target: string) {
  mkdirSync(path.dirname(target), { recursive: true });
  if (existsSync(target)) throw new Error(`${target} already exists`);
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
}

/** Make deleted data physically unrecoverable from the database file. */
export function compactAfterDelete(db: DB) {
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.exec("VACUUM");
  db.pragma("wal_checkpoint(TRUNCATE)");
}
