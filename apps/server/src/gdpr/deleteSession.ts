import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { sha256 } from "../content";
import { compactAfterDelete } from "../db/database";
import type { Store } from "../db/store";
import { nowTs, wall } from "../runtime";

export interface SessionDeletionResult {
  sessionId: string;
  rows: { events: number; telemetry: number; exports: number };
  /** Export folders of this session (deleted from disk only when requested). */
  exportPaths: string[];
  exportsDeleted: boolean;
}

/**
 * Delete an ENTIRE session: its events, telemetry, export register rows and the
 * session row itself. The deletion is recorded in `session_deletions` (session
 * id, row counts, SHA-256 of the participant codes it contained) so it can be
 * re-applied after restoring an older backup. Export folders under
 * exportsDir/<sessionId> are removed only if `deleteExports` is set.
 * Finally checkpoint + VACUUM so the pages are physically gone (secure_delete on).
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
        `SELECT DISTINCT participant_code AS c FROM events WHERE session_id = ? AND participant_code IS NOT NULL
         UNION SELECT DISTINCT participant_code FROM telemetry WHERE session_id = ?`,
      )
      .all(sessionId, sessionId) as Array<{ c: string }>
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
  db.transaction(() => {
    events = db.prepare("DELETE FROM events WHERE session_id = ?").run(sessionId).changes;
    telemetry = db.prepare("DELETE FROM telemetry WHERE session_id = ?").run(sessionId).changes;
    exports = db.prepare("DELETE FROM exports WHERE session_id = ?").run(sessionId).changes;
    db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
    db.prepare(
      `INSERT INTO session_deletions (session_id, deleted_wall, created_wall, rows_json, code_hashes_json, exports_json, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      sessionId,
      wall(nowTs()),
      row.created_wall,
      JSON.stringify({ events, telemetry, exports }),
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
  return { sessionId, rows: { events, telemetry, exports }, exportPaths, exportsDeleted };
}

export interface SessionDeletionEntry {
  id: number;
  sessionId: string;
  deletedWall: string;
  createdWall: string;
  rows: { events: number; telemetry: number; exports: number };
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
    rows: JSON.parse(r.rows_json),
    participants: (JSON.parse(r.code_hashes_json) as string[]).length,
    note: r.note,
  }));
}
