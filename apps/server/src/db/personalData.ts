/**
 * The personal-data map: the one place that knows where participant data lives
 * (database tables and encrypted audio files) and how it is looked up and removed.
 *
 *   PERSONAL_DATA       which tables hold participant codes, session ids and audio file references
 *   PersonalDataMap     look-up, erasure, session deletion and audio deletion over Store + AudioFileStore
 *
 * Every removal runs in one transaction, writes its register row inside it, then
 * forgets cached sequence numbers, compacts the database (checkpoint + VACUUM, with
 * secure_delete on) and only then unlinks the audio files, whose keys are already gone.
 */
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import {
  type AudioDeleteResult,
  type AudioDeletionCounts,
  type AudioDeletionScope,
  type AudioFilesRemoved,
  type CodeOccurrence,
  type ErasureEntry,
  type ErasureResult,
  type ErasureRows,
  type ExportRow,
  type LookupResult,
  normaliseParticipantCode,
  reduceEvents,
  type SessionDeletionEntry,
  type SessionDeletionResult,
  type SessionDeletionRows,
  type SpeechSegmentRow,
} from "@wkwa/shared";
import { fileBytes, isAudioDerivativeKind } from "../audio/records";
import { sha256 } from "../content";
import { nowTs, wall } from "../runtime";
import { compactAfterDelete, fromRow } from "./database";
import type { AudioDeletionRow, AudioTrackRowStatus, Store } from "./store";

/* ─────────────────────────── the registry ─────────────────────────── */

/** Row counts of "delete all audio" (part of AudioDeletionCounts). */
type AudioRowCount = "tracks" | "chunks" | "derivatives" | "jobs";

/** Counts of a participant look-up (CodeOccurrence). */
type OccurrenceCount = "events" | "telemetry" | "audioTracks";

/** A table that holds a session's rows, and possibly participant codes or audio file references. */
export interface PersonalDataTable {
  readonly table: string;
  /** SQL condition selecting one session's rows, with one `?` for the session id. */
  readonly ofSession: string;
  /** Column holding participant codes in plain text (the code is personal data: erasure removes these rows). */
  readonly codeColumn: "participant_code" | null;
  /**
   * SQL condition selecting one participant's rows of a session, with `?` for the session id and
   * then the code. Derived from `codeColumn` when that is set; tables without a code column give one
   * for rows that depend on the participant's rows (chunks of their tracks).
   */
  readonly ofParticipant?: string;
  /** SQL condition for rows whose encrypted audio file (file_name, key in file_key) is still on disk. */
  readonly audioFile?: string;
  /** SHA-256 hashes of the codes the rows contain (a JSON array): look-up finds them, erasure keeps them. */
  readonly codeHashes?: string;
  /** Removed by "delete all audio" too. */
  readonly audio?: boolean;
  /** Where the deleted rows are counted (and, for look-up, the occurrence count and seat). */
  readonly counts: {
    readonly session?: keyof SessionDeletionRows;
    readonly erasure?: keyof ErasureRows;
    readonly audio?: AudioRowCount;
    readonly occurrence?: { readonly count?: OccurrenceCount; readonly seat: boolean; readonly ms?: boolean };
  };
}

/**
 * Every table that holds a session's data, children before their parents
 * (the order rows are deleted in). Deleting a session empties all of them;
 * erasing a participant empties every row selected by `ofParticipant`.
 */
export const PERSONAL_DATA: readonly PersonalDataTable[] = [
  {
    table: "events",
    ofSession: "session_id = ?",
    codeColumn: "participant_code",
    counts: { session: "events", erasure: "events", occurrence: { count: "events", seat: true } },
  },
  {
    table: "telemetry",
    ofSession: "session_id = ?",
    codeColumn: "participant_code",
    // the seat of an occurrence comes from events and audio (as it always did), not from telemetry
    counts: { session: "telemetry", erasure: "telemetry", occurrence: { count: "telemetry", seat: false } },
  },
  {
    table: "exports",
    ofSession: "session_id = ?",
    codeColumn: null,
    codeHashes: "code_hashes_json",
    counts: { session: "exports" },
  },
  {
    table: "audio_chunks",
    ofSession: "track_id IN (SELECT track_id FROM audio_tracks WHERE session_id = ?)",
    codeColumn: null,
    ofParticipant:
      "track_id IN (SELECT track_id FROM audio_tracks WHERE session_id = ? AND participant_code = ?)",
    audio: true,
    counts: { session: "audioChunks", erasure: "audioChunks", audio: "chunks" },
  },
  {
    table: "audio_tracks",
    ofSession: "session_id = ?",
    codeColumn: "participant_code",
    // a track whose raw audio was deleted keeps its file name, but the file is gone already
    audioFile: "file_name IS NOT NULL AND status != 'deleted'",
    audio: true,
    counts: {
      session: "audioTracks",
      erasure: "audioTracks",
      audio: "tracks",
      occurrence: { count: "audioTracks", seat: true, ms: true },
    },
  },
  {
    table: "audio_derivatives",
    ofSession: "session_id = ?",
    codeColumn: "participant_code",
    audioFile: "file_name IS NOT NULL",
    audio: true,
    counts: {
      session: "audioDerivatives",
      erasure: "audioDerivatives",
      audio: "derivatives",
      occurrence: { seat: true },
    },
  },
  {
    table: "audio_jobs",
    ofSession: "session_id = ?",
    codeColumn: null,
    audio: true,
    counts: { session: "audioJobs", audio: "jobs" },
  },
  { table: "sessions", ofSession: "id = ?", codeColumn: null, counts: {} },
];

/**
 * Registers of what was removed. They keep the session id and SHA-256 hashes
 * of codes (never a code) on purpose: to re-apply a removal after restoring an
 * older backup, and to answer "was this code erased?".
 */
export const DELETION_REGISTERS = ["erasures", "session_deletions", "audio_deletions"] as const;

/** Tables with a participant-code column. */
export const CODE_TABLES = PERSONAL_DATA.filter((t) => t.codeColumn !== null);

/** The participant's rows of a session (`?` session id, then `?` code). */
function ofParticipant(t: PersonalDataTable): string | null {
  return t.ofParticipant ?? (t.codeColumn ? `${t.ofSession} AND ${t.codeColumn} = ?` : null);
}

/** Milliseconds of audio in a set of tracks (SQL aggregate over `audio_tracks a`). */
export const AUDIO_MS_SQL =
  "coalesce(sum(CASE WHEN a.sample_rate > 0 THEN a.samples * 1000.0 / a.sample_rate END), 0)";

/* ─────────────────────────── results ─────────────────────────── */

/** What deleteAudio did (the REST result adds the register entry as `record`). */
export interface AudioDeletionResult extends Omit<AudioDeleteResult, "record" | "audioExportsOnDisk"> {
  /** The register entry (audio_deletions). */
  entry: AudioDeletionRow;
}

const NO_ERASURE_ROWS: ErasureRows = {
  events: 0,
  telemetry: 0,
  audioTracks: 0,
  audioChunks: 0,
  audioDerivatives: 0,
};

const NO_SESSION_ROWS: SessionDeletionRows = {
  events: 0,
  telemetry: 0,
  exports: 0,
  audioTracks: 0,
  audioChunks: 0,
  audioDerivatives: 0,
  audioJobs: 0,
};

const NO_AUDIO_ROWS = { audioTracks: 0, audioChunks: 0, audioDerivatives: 0, audioJobs: 0 };

type FileRef = { sessionId: string; fileName: string };

/** Parse a participant code as typed (any case, spaces or dashes); throws for anything else. */
export function parseCodeOrThrow(input: string): string {
  const code = normaliseParticipantCode(input);
  if (!code) throw new Error(`'${input}' is not a valid participant code (check for typos).`);
  return code;
}

/** A kept segment without the erased seat as overlap partner (its overlap time is then only an upper bound). */
function stripOverlap(x: SpeechSegmentRow, seat: number): SpeechSegmentRow {
  const overlapWith = x.overlapWith.filter((s) => s !== seat);
  return overlapWith.length ? { ...x, overlapWith } : { ...x, overlapWith, overlap: false, overlapMs: 0 };
}

/* ─────────────────────────── the module ─────────────────────────── */

/**
 * Look-up and removal of participant data in one database (pass the store that
 * holds the session; participant look-up and erasure only ever use the
 * participant database). Audio files are unlinked through `store.audioFiles`.
 *
 * None of these checks whether the server has the session attached and running:
 * callers refuse that first (REST routes) or warn (CLI).
 */
export class PersonalDataMap {
  constructor(private readonly store: Store) {}

  private get db() {
    return this.store.db;
  }

  /* ── look-up ── */

  /** Where a participant code occurs, which exports contain it and whether it was erased before. Throws for an invalid code. */
  lookup(input: string): LookupResult {
    const code = parseCodeOrThrow(input);
    const h = sha256(code);
    const prev = this.db
      .prepare("SELECT executed_wall FROM erasures WHERE code_sha256 = ? ORDER BY id")
      .all(h) as Array<{ executed_wall: string }>;
    return {
      code,
      occurrences: this.occurrences(code),
      exports: this.exportsContaining(h),
      previouslyErased: prev.map((p) => ({ executedWall: p.executed_wall })),
    };
  }

  /** Per session: the seat, and how many events, telemetry rows and audio tracks carry the code. */
  private occurrences(code: string): CodeOccurrence[] {
    const map = new Map<string, CodeOccurrence>();
    for (const t of CODE_TABLES) {
      const o = t.counts.occurrence;
      if (!o) continue;
      const rows = this.db
        .prepare(
          `SELECT a.session_id, ${o.seat ? "max(a.seat)" : "NULL"} AS seat, count(*) AS n${o.ms ? `, ${AUDIO_MS_SQL} AS ms` : ""}
           FROM ${t.table} a WHERE a.${t.codeColumn} = ? GROUP BY a.session_id`,
        )
        .all(code) as Array<{ session_id: string; seat: number | null; n: number; ms?: number }>;
      for (const r of rows) {
        const seat = r.seat;
        const e = map.get(r.session_id) ?? {
          sessionId: r.session_id,
          seat,
          events: 0,
          telemetry: 0,
          audioTracks: 0,
          audioMs: 0,
        };
        if (e.seat === null) e.seat = seat;
        map.set(r.session_id, e);
        if (o.count) e[o.count] = r.n;
        if (o.ms) e.audioMs = Math.round(r.ms ?? 0);
      }
    }
    return [...map.values()];
  }

  /** Exports whose register entry holds this code hash, oldest first. */
  private exportsContaining(codeHash: string): ExportRow[] {
    const out: ExportRow[] = [];
    for (const t of PERSONAL_DATA) {
      if (!t.codeHashes) continue;
      const rows = this.db
        .prepare(`SELECT id, session_id, kind, created_wall, path FROM ${t.table}
         WHERE EXISTS (SELECT 1 FROM json_each(${t.codeHashes}) WHERE value = ?) ORDER BY created_wall`)
        .all(codeHash);
      out.push(...rows.map(fromRow<ExportRow>));
    }
    return out;
  }

  /* ── erasure ── */

  /**
   * Erase every record of a participant (GDPR takedown):
   *  1. DELETE all their rows (events, telemetry, audio tracks with their file keys and chunks), and
   *     every audio derivative that carries the code or was computed from one of their tracks
   *     (e.g. session-wide speech segments: re-run the attribution); the other seats' kept
   *     segments forget the erased seat as overlap partner, job summaries are cleared,
   *  2. append ParticipantWithdrawn{by: "erasure"} (without the code) to each affected session
   *     whose seat the participant still holds (not after it was rebound to someone else),
   *  3. add an entry to the erasure register (SHA-256 of the code only),
   *  4. checkpoint + VACUUM so the deleted pages are physically gone (secure_delete is ON),
   *  5. unlink the encrypted audio files (already unreadable: their keys are gone).
   * Returns the exports that contained the code so they can be deleted/regenerated.
   *
   * The events are appended straight to the store, past the SessionManager: if the
   * server has one of these sessions attached, it must reload it afterwards.
   */
  erase(input: string, note = ""): ErasureResult {
    const found = this.lookup(input);
    const { code } = found;
    if (found.occurrences.length === 0) {
      return {
        ...found,
        erased: false,
        rows: { ...NO_ERASURE_ROWS },
        audioFiles: { removed: 0, failed: [] },
      };
    }
    const rows: ErasureRows = { ...NO_ERASURE_ROWS };
    const files: FileRef[] = [];
    const requested = wall(nowTs());
    const { store, db } = this;
    const unlink = this.removeInTransaction(() => {
      for (const occ of found.occurrences) {
        const { sessionId, seat } = occ;
        // read before the delete: a seat rebound to someone else since must not be withdrawn
        const holdsSeat =
          seat !== null && reduceEvents(store.listEvents(sessionId)).seats[seat]?.participantCode === code;
        this.eraseDerivedAudio(sessionId, code, seat, rows, files);
        for (const t of PERSONAL_DATA) {
          const where = ofParticipant(t);
          if (!where) continue;
          if (t.audioFile) {
            const names = db
              .prepare(`SELECT file_name FROM ${t.table} WHERE (${where}) AND (${t.audioFile})`)
              .pluck()
              .all(sessionId, code) as string[];
            for (const fileName of names) files.push({ sessionId, fileName });
          }
          const n = db.prepare(`DELETE FROM ${t.table} WHERE ${where}`).run(sessionId, code).changes;
          if (t.counts.erasure) rows[t.counts.erasure] += n;
        }
        if (holdsSeat) {
          store.resetSeqCache();
          const state = reduceEvents(store.listEvents(sessionId));
          store.appendEvent(
            sessionId,
            {
              type: "ParticipantWithdrawn",
              actorKind: "system",
              seat,
              participantCode: null,
              payload: { seat, by: "erasure", phase: state.phase },
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
      return files;
    });
    return { ...found, erased: true, rows, audioFiles: unlink() };
  }

  /**
   * Audio results that depend on the participant: derivatives with their code or
   * computed from one of their tracks are deleted (their files collected); the
   * other seats' kept speech segments drop the erased seat as overlap partner,
   * and job summaries (per-seat talk time) are cleared.
   */
  private eraseDerivedAudio(
    sessionId: string,
    code: string,
    seat: number | null,
    rows: ErasureRows,
    files: FileRef[],
  ) {
    const db = this.db;
    const trackIds = new Set(
      db
        .prepare("SELECT track_id FROM audio_tracks WHERE session_id = ? AND participant_code = ?")
        .pluck()
        .all(sessionId, code) as string[],
    );
    const derived = db
      .prepare(
        "SELECT derivative_id, participant_code, file_name, source_tracks_json, data_json FROM audio_derivatives WHERE session_id = ?",
      )
      .all(sessionId) as Array<{
      derivative_id: string;
      participant_code: string | null;
      file_name: string | null;
      source_tracks_json: string;
      data_json: string | null;
    }>;
    for (const d of derived) {
      const sources = JSON.parse(d.source_tracks_json) as string[];
      if (d.participant_code !== code && !sources.some((t) => trackIds.has(t))) continue;
      rows.audioDerivatives += db
        .prepare("DELETE FROM audio_derivatives WHERE derivative_id = ?")
        .run(d.derivative_id).changes;
      if (d.file_name) files.push({ sessionId, fileName: d.file_name });
    }
    if (seat === null) return;
    // the other seats' kept segments name the erased seat as an overlap partner: drop it
    for (const d of derived) {
      if (d.participant_code === code || !d.data_json) continue;
      const data = JSON.parse(d.data_json) as { segments?: SpeechSegmentRow[] } | null;
      if (!data?.segments?.some((x) => x.overlapWith.includes(seat))) continue;
      data.segments = data.segments.map((x) => stripOverlap(x, seat));
      db.prepare("UPDATE audio_derivatives SET data_json = ? WHERE derivative_id = ?").run(
        JSON.stringify(data),
        d.derivative_id,
      );
    }
    // job summaries hold per-seat talk time and warnings: re-run the attribution for new ones
    db.prepare("UPDATE audio_jobs SET result_json = NULL WHERE session_id = ?").run(sessionId);
  }

  /** The erasure register, oldest first. */
  erasures(): ErasureEntry[] {
    return (
      this.db
        .prepare("SELECT * FROM erasures ORDER BY id")
        .all()
        .map(fromRow<ErasureEntry>)
        // entries made before audio existed lack the audio counts
        .map((e) => ({
          ...e,
          rows: { ...NO_ERASURE_ROWS, audioFiles: 0, ...(e.rows as Partial<ErasureEntry["rows"]>) },
        }))
    );
  }

  /* ── session deletion ── */

  /**
   * Delete an ENTIRE session: its rows in every PERSONAL_DATA table (events,
   * telemetry, export register rows, audio rows with their file keys, the
   * session row itself). The deletion is recorded in `session_deletions`
   * (session id, row counts, SHA-256 of the participant codes it contained) so
   * it can be re-applied after restoring an older backup. Export folders under
   * exportsDir/<sessionId> are removed only if `deleteExports` is set.
   * Then checkpoint + VACUUM so the pages are physically gone (secure_delete on),
   * and finally remove the session's audio folder (its keys are already gone).
   * Throws for an unknown session.
   */
  deleteSession(
    sessionId: string,
    opts: { exportsDir: string; deleteExports?: boolean; note?: string },
  ): SessionDeletionResult {
    const { store, db } = this;
    const row = store.getSession(sessionId);
    if (!row) throw new Error(`Unknown session ${sessionId}`);
    const codes = store.sessionCodes(sessionId).map(sha256);
    const exportRows = db.prepare("SELECT path FROM exports WHERE session_id = ?").all(sessionId) as Array<{
      path: string;
    }>;
    const sessionDir = path.join(opts.exportsDir, sessionId);
    const exportPaths = [
      ...new Set([...exportRows.map((r) => r.path), ...(existsSync(sessionDir) ? [sessionDir] : [])]),
    ];

    const rows: SessionDeletionRows = { ...NO_SESSION_ROWS };
    const done = this.removeInTransaction(() => {
      for (const t of PERSONAL_DATA) {
        const n = db.prepare(`DELETE FROM ${t.table} WHERE ${t.ofSession}`).run(sessionId).changes;
        if (t.counts.session) rows[t.counts.session] = n;
      }
      db.prepare(
        `INSERT INTO session_deletions (session_id, deleted_wall, created_wall, rows_json, code_hashes_json, exports_json, note)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        sessionId,
        wall(nowTs()),
        row.created_wall,
        JSON.stringify(rows),
        JSON.stringify(codes.sort()),
        JSON.stringify(exportPaths),
        opts.note ?? "",
      );
      return [];
    });
    // shortcut: a failed compaction still fails the committed deletion (no audio files to unlink here),
    // report it in SessionDeletionResult once the delete popup can show it
    const { compactionError } = done();
    if (compactionError) throw new Error(compactionError);

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
      rows,
      exportPaths,
      exportsDeleted,
      audio: {
        dirRemoved: removed.removed,
        files: removed.files,
        ...(removed.error ? { error: removed.error } : {}),
      },
    };
  }

  /** The session-deletion register, oldest first. */
  sessionDeletions(): SessionDeletionEntry[] {
    return this.db
      .prepare(
        `SELECT id, session_id, deleted_wall, created_wall, rows_json,
           json_array_length(code_hashes_json) AS participants, note FROM session_deletions ORDER BY id`,
      )
      .all()
      .map(fromRow<SessionDeletionEntry>)
      .map((e) => ({ ...e, rows: { ...NO_AUDIO_ROWS, ...e.rows } }));
  }

  /* ── audio deletion ── */

  /**
   * Delete a session's audio and record it in the `audio_deletions` register.
   *
   *  - `raw`: delete the raw tracks' files and keys (crypto-shredding) but keep
   *    the track rows as `status = 'deleted'` with their timing metadata, and
   *    keep the chunk rows (times, levels): speaking-time analysis still works.
   *    Derivatives that hold sound (isAudioDerivativeKind: cleaned and aligned
   *    tracks) are deleted too; the others (speech segments, transcripts, …) stay.
   *  - `all`: delete the session's rows in every audio table of PERSONAL_DATA
   *    (tracks, chunks, derivatives, jobs) and its whole audio folder.
   *
   * Throws for an unknown scope or session. Refusing a running session is the caller's job.
   * Audio exists only in the participant database: pass the participant store.
   */
  deleteAudio(sessionId: string, opts: { scope: AudioDeletionScope; note?: string }): AudioDeletionResult {
    const { store, db } = this;
    const { scope } = opts;
    if (scope !== "raw" && scope !== "all") throw new Error(`Unknown scope '${String(scope)}' (raw or all)`);
    if (!store.getSession(sessionId)) throw new Error(`Unknown session ${sessionId}`);
    const requestedWall = wall(nowTs());
    const counts: AudioDeletionCounts = {
      tracks: 0,
      audioMs: 0,
      chunks: 0,
      derivatives: 0,
      jobs: 0,
      files: 0,
      bytes: 0,
      seatMask: 0,
    };
    let entry!: AudioDeletionRow;

    const unlink = this.removeInTransaction(() => {
      const files: FileRef[] = [];
      const tracks = (
        db
          .prepare(
            "SELECT track_id, seat, file_name, samples, sample_rate, status FROM audio_tracks WHERE session_id = ?",
          )
          .all(sessionId) as Array<{
          track_id: string;
          seat: number;
          file_name: string | null;
          samples: number;
          sample_rate: number;
          status: AudioTrackRowStatus;
        }>
      ).filter((t) => scope === "all" || t.status !== "deleted");
      const derived = (
        db
          .prepare("SELECT derivative_id, seat, kind, file_name FROM audio_derivatives WHERE session_id = ?")
          .all(sessionId) as Array<{
          derivative_id: string;
          seat: number | null;
          kind: string;
          file_name: string | null;
        }>
      ).filter((d) => scope === "all" || isAudioDerivativeKind(d.kind));

      for (const t of tracks) {
        if (t.seat > 0 && t.seat < 31) counts.seatMask |= 1 << t.seat;
        counts.audioMs += t.sample_rate > 0 ? (t.samples * 1000) / t.sample_rate : 0;
        if (t.file_name && t.status !== "deleted") files.push({ sessionId, fileName: t.file_name });
      }
      for (const d of derived) {
        if (d.seat !== null && d.seat > 0 && d.seat < 31) counts.seatMask |= 1 << d.seat;
        if (d.file_name) files.push({ sessionId, fileName: d.file_name });
      }
      if (scope === "all") {
        for (const t of PERSONAL_DATA) {
          if (!t.audio) continue;
          const n = db.prepare(`DELETE FROM ${t.table} WHERE ${t.ofSession}`).run(sessionId).changes;
          if (t.counts.audio) counts[t.counts.audio] = n;
        }
      } else {
        for (const t of tracks)
          counts.tracks += db
            .prepare("UPDATE audio_tracks SET status = 'deleted', file_key = NULL WHERE track_id = ?")
            .run(t.track_id).changes;
        for (const d of derived)
          counts.derivatives += db
            .prepare("DELETE FROM audio_derivatives WHERE derivative_id = ?")
            .run(d.derivative_id).changes;
      }
      counts.audioMs = Math.round(counts.audioMs);
      counts.files = files.length;
      counts.bytes = files.reduce((n, f) => n + fileBytes(store, f.sessionId, f.fileName), 0);
      entry = store.insertAudioDeletion({
        sessionId,
        scope,
        requestedWall,
        executedWall: wall(nowTs()),
        counts: { ...counts },
        note: opts.note ?? "",
      });
      return files;
    });

    const removed = unlink();
    let dirRemoved = false;
    if (scope === "all" && store.audioFiles) {
      try {
        dirRemoved = store.audioFiles.deleteSessionDir(sessionId).removed;
      } catch (e) {
        removed.failed.push(`${sessionId}/ (${(e as Error).message})`);
      }
    }
    return { sessionId, scope, counts, audioFiles: { ...removed, dirRemoved }, entry };
  }

  /* ── the removal protocol ── */

  /**
   * Run `remove` in one transaction (it writes its register row inside), then
   * forget cached event sequence numbers and compact the database. Returns a
   * function that unlinks the audio files `remove` returned: call it after the
   * commit. Unlink and compaction failures are reported, never thrown, so the
   * database part always stands (the files are unreadable: their keys are gone).
   */
  private removeInTransaction(remove: () => FileRef[]): () => AudioFilesRemoved {
    const files = this.db.transaction(remove)();
    this.store.resetSeqCache();
    let compactionError: string | undefined;
    try {
      compactAfterDelete(this.db);
    } catch (e) {
      compactionError = (e as Error).message;
    }
    return () => {
      const out: AudioFilesRemoved = { removed: 0, failed: [], ...(compactionError && { compactionError }) };
      const audioFiles = this.store.audioFiles;
      if (!audioFiles) return out;
      for (const f of files) {
        try {
          if (audioFiles.deleteFile(f.sessionId, f.fileName)) out.removed++;
        } catch {
          out.failed.push(`${f.sessionId}/${f.fileName}`);
        }
      }
      return out;
    };
  }
}
