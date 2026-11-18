import { normaliseParticipantCode, reduceEvents } from "@wkwa/shared";
import { sha256 } from "../content";
import { compactAfterDelete } from "../db/database";
import type { CodeOccurrence, Store } from "../db/store";
import { nowTs, wall } from "../runtime";
import { type ExportRow, exportsContaining } from "./exporter";

/** Where a participant code occurs in one session: events, telemetry and audio (track rows, duration). */
export type Occurrence = CodeOccurrence;

export interface LookupResult {
  code: string;
  occurrences: Occurrence[];
  exports: ExportRow[];
  previouslyErased: Array<{ executedWall: string }>;
}

export function parseCodeOrThrow(input: string): string {
  const code = normaliseParticipantCode(input);
  if (!code) throw new Error(`'${input}' is not a valid participant code (check for typos).`);
  return code;
}

export function lookupParticipant(store: Store, input: string): LookupResult {
  const code = parseCodeOrThrow(input);
  const h = sha256(code);
  const prev = store.db
    .prepare("SELECT executed_wall FROM erasures WHERE code_sha256 = ? ORDER BY id")
    .all(h) as Array<{
    executed_wall: string;
  }>;
  return {
    code,
    occurrences: store.lookupCode(code),
    exports: exportsContaining(store, code),
    previouslyErased: prev.map((p) => ({ executedWall: p.executed_wall })),
  };
}

/** Rows deleted by an erasure (also the shape of `erasures.rows_json`; older entries lack the audio counts). */
export interface ErasureRows {
  events: number;
  telemetry: number;
  audioTracks: number;
  audioChunks: number;
  audioDerivatives: number;
}

export interface AudioFilesRemoved {
  removed: number;
  /**
   * Files that could not be unlinked, as `<sessionId>/<fileName>`. Their keys
   * are gone with the rows, so they are unreadable; delete them by hand.
   */
  failed: string[];
}

export interface ErasureResult extends LookupResult {
  erased: boolean;
  rows: ErasureRows;
  /** Encrypted audio files unlinked after the commit. */
  audioFiles: AudioFilesRemoved;
}

const NO_ROWS: ErasureRows = { events: 0, telemetry: 0, audioTracks: 0, audioChunks: 0, audioDerivatives: 0 };

/**
 * Unlink audio files whose keys were just deleted. Runs after the commit:
 * failures are collected, never thrown, so the database part always stands.
 */
export function unlinkAudioFiles(
  store: Store,
  files: Array<{ sessionId: string; fileName: string }>,
): AudioFilesRemoved {
  const out: AudioFilesRemoved = { removed: 0, failed: [] };
  if (!store.audioFiles) return out;
  for (const f of files) {
    try {
      if (store.audioFiles.deleteFile(f.sessionId, f.fileName)) out.removed++;
    } catch {
      out.failed.push(`${f.sessionId}/${f.fileName}`);
    }
  }
  return out;
}

/**
 * Erase every record of a participant (GDPR takedown):
 *  1. DELETE all events and telemetry rows carrying the code, and their audio:
 *     the audio tracks (with their file keys) and chunks, and every audio
 *     derivative that carries the code or was computed from one of their
 *     tracks (e.g. session-wide speech segments: re-run the attribution),
 *  2. append ParticipantWithdrawn{by: "erasure"} (without the code) to each affected session,
 *  3. add an entry to the erasure register (SHA-256 of the code only),
 *  4. checkpoint + VACUUM so the deleted pages are physically gone (secure_delete is ON),
 *  5. unlink the encrypted audio files (already unreadable: their keys are gone).
 * Returns the exports that contained the code so they can be deleted/regenerated.
 */
export function eraseParticipant(store: Store, input: string, note = ""): ErasureResult {
  const found = lookupParticipant(store, input);
  const { code } = found;
  if (found.occurrences.length === 0) {
    return { ...found, erased: false, rows: { ...NO_ROWS }, audioFiles: { removed: 0, failed: [] } };
  }
  const rows: ErasureRows = { ...NO_ROWS };
  const files: Array<{ sessionId: string; fileName: string }> = [];
  const requested = wall(nowTs());
  const db = store.db;
  db.transaction(() => {
    for (const occ of found.occurrences) {
      rows.events += db
        .prepare("DELETE FROM events WHERE session_id = ? AND participant_code = ?")
        .run(occ.sessionId, code).changes;
      rows.telemetry += db
        .prepare("DELETE FROM telemetry WHERE session_id = ? AND participant_code = ?")
        .run(occ.sessionId, code).changes;

      const tracks = db
        .prepare(
          "SELECT track_id, file_name, status FROM audio_tracks WHERE session_id = ? AND participant_code = ?",
        )
        .all(occ.sessionId, code) as Array<{ track_id: string; file_name: string | null; status: string }>;
      const trackIds = new Set(tracks.map((t) => t.track_id));
      const derived = db
        .prepare(
          "SELECT derivative_id, participant_code, file_name, source_tracks_json FROM audio_derivatives WHERE session_id = ?",
        )
        .all(occ.sessionId) as Array<{
        derivative_id: string;
        participant_code: string | null;
        file_name: string | null;
        source_tracks_json: string;
      }>;
      for (const d of derived) {
        const sources = JSON.parse(d.source_tracks_json) as string[];
        if (d.participant_code !== code && !sources.some((t) => trackIds.has(t))) continue;
        rows.audioDerivatives += db
          .prepare("DELETE FROM audio_derivatives WHERE derivative_id = ?")
          .run(d.derivative_id).changes;
        if (d.file_name) files.push({ sessionId: occ.sessionId, fileName: d.file_name });
      }
      for (const t of tracks) {
        rows.audioChunks += db.prepare("DELETE FROM audio_chunks WHERE track_id = ?").run(t.track_id).changes;
        rows.audioTracks += db.prepare("DELETE FROM audio_tracks WHERE track_id = ?").run(t.track_id).changes;
        // a track whose raw audio was deleted keeps its file name, but the file is gone already
        if (t.file_name && t.status !== "deleted")
          files.push({ sessionId: occ.sessionId, fileName: t.file_name });
      }

      if (occ.seat !== null) {
        store.resetSeqCache();
        const state = reduceEvents(store.listEvents(occ.sessionId));
        store.appendEvent(
          occ.sessionId,
          {
            type: "ParticipantWithdrawn",
            actorKind: "system",
            seat: occ.seat,
            participantCode: null,
            payload: { seat: occ.seat, by: "erasure", phase: state.phase },
          },
          state.round,
        );
      }
    }
    db.prepare(
      "INSERT INTO erasures (code_sha256, requested_wall, executed_wall, sessions_json, rows_json, note) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      sha256(code),
      requested,
      wall(nowTs()),
      JSON.stringify(found.occurrences.map((o) => ({ sessionId: o.sessionId, seat: o.seat }))),
      JSON.stringify({ ...rows, audioFiles: files.length }),
      note,
    );
  })();
  store.resetSeqCache();
  compactAfterDelete(db);
  const audioFiles = unlinkAudioFiles(store, files);
  return { ...found, erased: true, rows, audioFiles };
}

export interface ErasureEntry {
  id: number;
  codeSha256: string;
  requestedWall: string;
  executedWall: string;
  sessions: Array<{ sessionId: string; seat: number | null }>;
  /**
   * Rows deleted, and `audioFiles`: encrypted audio files whose keys were deleted (crypto-shredded),
   * which are then unlinked. Audio counts are 0 for entries made before audio existed.
   */
  rows: ErasureRows & { audioFiles: number };
  note: string;
}

export function listErasures(store: Store): ErasureEntry[] {
  const rows = store.db.prepare("SELECT * FROM erasures ORDER BY id").all() as Array<{
    id: number;
    code_sha256: string;
    requested_wall: string;
    executed_wall: string;
    sessions_json: string;
    rows_json: string;
    note: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    codeSha256: r.code_sha256,
    requestedWall: r.requested_wall,
    executedWall: r.executed_wall,
    sessions: JSON.parse(r.sessions_json),
    rows: { ...NO_ROWS, audioFiles: 0, ...JSON.parse(r.rows_json) },
    note: r.note,
  }));
}
