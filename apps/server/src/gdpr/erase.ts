import { normaliseParticipantCode, reduceEvents } from "@wkwa/shared";
import { sha256 } from "../content";
import { compactAfterDelete } from "../db/database";
import type { Store } from "../db/store";
import { nowTs, wall } from "../runtime";
import { type ExportRow, exportsContaining } from "./exporter";

export interface Occurrence {
  sessionId: string;
  seat: number | null;
  events: number;
  telemetry: number;
}

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

export interface ErasureResult extends LookupResult {
  erased: boolean;
  rows: { events: number; telemetry: number };
}

/**
 * Erase every record of a participant (GDPR takedown):
 *  1. DELETE all events and telemetry rows carrying the code,
 *  2. append ParticipantWithdrawn{by: "erasure"} (without the code) to each affected session,
 *  3. add an entry to the erasure register (SHA-256 of the code only),
 *  4. checkpoint + VACUUM so the deleted pages are physically gone (secure_delete is ON).
 * Returns the exports that contained the code so they can be deleted/regenerated.
 */
export function eraseParticipant(store: Store, input: string, note = ""): ErasureResult {
  const found = lookupParticipant(store, input);
  const { code } = found;
  if (found.occurrences.length === 0) {
    return { ...found, erased: false, rows: { events: 0, telemetry: 0 } };
  }
  let events = 0;
  let telemetry = 0;
  const requested = wall(nowTs());
  store.db.transaction(() => {
    for (const occ of found.occurrences) {
      events += store.db
        .prepare("DELETE FROM events WHERE session_id = ? AND participant_code = ?")
        .run(occ.sessionId, code).changes;
      telemetry += store.db
        .prepare("DELETE FROM telemetry WHERE session_id = ? AND participant_code = ?")
        .run(occ.sessionId, code).changes;
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
    store.db
      .prepare(
        "INSERT INTO erasures (code_sha256, requested_wall, executed_wall, sessions_json, rows_json, note) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        sha256(code),
        requested,
        wall(nowTs()),
        JSON.stringify(found.occurrences.map((o) => ({ sessionId: o.sessionId, seat: o.seat }))),
        JSON.stringify({ events, telemetry }),
        note,
      );
  })();
  store.resetSeqCache();
  compactAfterDelete(store.db);
  return { ...found, erased: true, rows: { events, telemetry } };
}

export interface ErasureEntry {
  id: number;
  codeSha256: string;
  requestedWall: string;
  executedWall: string;
  sessions: Array<{ sessionId: string; seat: number | null }>;
  rows: { events: number; telemetry: number };
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
    rows: JSON.parse(r.rows_json),
    note: r.note,
  }));
}
