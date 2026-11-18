import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { sha256 } from "../content";
import { compactAfterDelete } from "../db/database";
import type { Store } from "../db/store";
import { nowTs, wall } from "../runtime";

/** Rows deleted with a session (also the shape of `session_deletions.rows_json`; older entries lack audio). */
export interface SessionDeletionRows {
  events: number;
  telemetry: number;
  exports: number;
  audioTracks: number;
  audioChunks: number;
  audioDerivatives: number;
  audioJobs: number;
}

export interface SessionDeletionResult {
  sessionId: string;
  rows: SessionDeletionRows;
  /** Export folders of this session (deleted from disk only when requested). */
  exportPaths: string[];
  exportsDeleted: boolean;
  /**
   * The session's encrypted audio folder (data/audio/<sessionId>), always removed.
   * `error` says why it could not be (its files are unreadable: their keys are gone).
   */
  audio: { dirRemoved: boolean; files: number; error?: string };
}

const NO_AUDIO_ROWS = { audioTracks: 0, audioChunks: 0, audioDerivatives: 0, audioJobs: 0 };

/**
 * Delete an ENTIRE session: its events, telemetry, audio rows (tracks with
 * their file keys, chunks, derivatives, jobs), export register rows and the
 * session row itself. The deletion is recorded in `session_deletions` (session
 * id, row counts, SHA-256 of the participant codes it contained) so it can be
 * re-applied after restoring an older backup. Export folders under
 * exportsDir/<sessionId> are removed only if `deleteExports` is set.
 * Then checkpoint + VACUUM so the pages are physically gone (secure_delete on),
 * and finally remove the session's audio folder (its keys are already gone).
 */
export function deleteSession(
  store: Store,
  sessionId: string,
  opts: { exportsDir: string; deleteExports?: boolean; note?: string },
): SessionDeletionResult {
  const row = store.getSession(sessionId);
  if (!row) throw new Error(`Unknown session ${sessionId}`);
  const db = store.db;
  const codes = (
    db
      .prepare(
        `SELECT DISTINCT participant_code AS c FROM events WHERE session_id = @id AND participant_code IS NOT NULL
         UNION SELECT DISTINCT participant_code FROM telemetry WHERE session_id = @id
         UNION SELECT DISTINCT participant_code FROM audio_tracks WHERE session_id = @id
         UNION SELECT DISTINCT participant_code FROM audio_derivatives
           WHERE session_id = @id AND participant_code IS NOT NULL`,
      )
      .all({ id: sessionId }) as Array<{ c: string }>
  ).map((r) => sha256(r.c));
  const exportRows = db.prepare("SELECT path FROM exports WHERE session_id = ?").all(sessionId) as Array<{
    path: string;
  }>;
  const sessionDir = path.join(opts.exportsDir, sessionId);
  const exportPaths = [
    ...new Set([...exportRows.map((r) => r.path), ...(existsSync(sessionDir) ? [sessionDir] : [])]),
  ];

  let events = 0;
  let telemetry = 0;
  let exports = 0;
  const audio = { ...NO_AUDIO_ROWS };
  db.transaction(() => {
    events = db.prepare("DELETE FROM events WHERE session_id = ?").run(sessionId).changes;
    telemetry = db.prepare("DELETE FROM telemetry WHERE session_id = ?").run(sessionId).changes;
    exports = db.prepare("DELETE FROM exports WHERE session_id = ?").run(sessionId).changes;
    audio.audioChunks = db
      .prepare(
        "DELETE FROM audio_chunks WHERE track_id IN (SELECT track_id FROM audio_tracks WHERE session_id = ?)",
      )
      .run(sessionId).changes;
    audio.audioTracks = db.prepare("DELETE FROM audio_tracks WHERE session_id = ?").run(sessionId).changes;
    audio.audioDerivatives = db
      .prepare("DELETE FROM audio_derivatives WHERE session_id = ?")
      .run(sessionId).changes;
    audio.audioJobs = db.prepare("DELETE FROM audio_jobs WHERE session_id = ?").run(sessionId).changes;
    db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
    db.prepare(
      `INSERT INTO session_deletions (session_id, deleted_wall, created_wall, rows_json, code_hashes_json, exports_json, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sessionId,
      wall(nowTs()),
      row.created_wall,
      JSON.stringify({ events, telemetry, exports, ...audio }),
      JSON.stringify(codes.sort()),
      JSON.stringify(exportPaths),
      opts.note ?? "",
    );
  })();
  store.resetSeqCache();
  compactAfterDelete(db);

  let exportsDeleted = false;
  if (opts.deleteExports && existsSync(sessionDir)) {
    // only ever inside the configured exports directory
    const resolved = path.resolve(sessionDir);
    if (resolved.startsWith(path.resolve(opts.exportsDir) + path.sep)) {
      rmSync(resolved, { recursive: true, force: true });
      exportsDeleted = true;
    }
  }
  // the audio folder goes regardless: its keys were rows of this session (AudioFileStore checks containment)
  let removed: { removed: boolean; files: number; error?: string } = { removed: false, files: 0 };
  try {
    removed = store.audioFiles?.deleteSessionDir(sessionId) ?? removed;
  } catch (e) {
    // the rows (and keys) are gone already: report instead of failing the deletion
    removed = { removed: false, files: 0, error: (e as Error).message };
  }
  return {
    sessionId,
    rows: { events, telemetry, exports, ...audio },
    exportPaths,
    exportsDeleted,
    audio: {
      dirRemoved: removed.removed,
      files: removed.files,
      ...(removed.error ? { error: removed.error } : {}),
    },
  };
}

export interface SessionDeletionEntry {
  id: number;
  sessionId: string;
  deletedWall: string;
  createdWall: string;
  /** Row counts (audio counts are 0 for entries made before audio existed). */
  rows: SessionDeletionRows;
  participants: number;
  note: string;
}

export function listSessionDeletions(store: Store): SessionDeletionEntry[] {
  const rows = store.db.prepare("SELECT * FROM session_deletions ORDER BY id").all() as Array<{
    id: number;
    session_id: string;
    deleted_wall: string;
    created_wall: string;
    rows_json: string;
    code_hashes_json: string;
    note: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    deletedWall: r.deleted_wall,
    createdWall: r.created_wall,
    rows: { ...NO_AUDIO_ROWS, ...JSON.parse(r.rows_json) },
    participants: (JSON.parse(r.code_hashes_json) as string[]).length,
    note: r.note,
  }));
}
