import type {
  AudioDeletionScope,
  AudioDerivativeKind,
  NewEvent,
  SessionConfig,
  StoredEvent,
  StoredTelemetry,
  TelemetryItem,
} from "@wkwa/shared";
import type { AudioFileStore } from "../audio/fileStore";
import { nowTs, wall } from "../runtime";
import { type DB, fromRow, insert } from "./database";
import { AUDIO_MS_SQL, CODE_TABLES } from "./personalData";

export interface SessionRow {
  id: string;
  created_wall: string;
  scenario_id: string;
  scenario_version: string;
  scenario_hash: string;
  status: string;
  condition: string;
  tags_json: string;
  notes: string;
  config_json: string;
  harness_version: string;
  git_commit: string;
  updated_wall: string;
}

export interface SessionSummary {
  id: string;
  createdWall: string;
  updatedWall: string;
  scenarioId: string;
  scenarioVersion: string;
  status: string;
  tags: string[];
  notes: string;
  eventCount: number;
  telemetryCount: number;
  /** Seats bound to fake players (test clients the server created) at the end of the log; [] = none. */
  fakeSeats: number[];
  /** Audio tracks whose audio is still stored (tracks whose raw audio was deleted are not counted). */
  audioTracks: number;
  /** Recorded duration of those tracks, in ms (samples received / sample rate). */
  audioMs: number;
}

/* ─────────── audio rows (schema v6) ─────────── */

/** A track's lifecycle as stored (the REST `AudioTrackStatus` is derived from it and the stop reason). */
export type AudioTrackRowStatus = "recording" | "closed" | "deleted";

/** A new track: the file comes from AudioFileStore.createFile (name + key). */
export interface NewAudioTrack {
  /** Random UUID chosen by the client for one continuous capture run. */
  trackId: string;
  sessionId: string;
  seat: number;
  participantCode: string;
  fileName: string;
  fileKey: Buffer;
  /** 16000 for 16 kHz mono s16le. */
  sampleRate: number;
  /** Processing flags of `track.getSettings()` (never deviceId, label or groupId). */
  settings: Record<string, unknown>;
  /** Why the track started (e.g. mic check, reload, resume after a pause). */
  reason: string;
  startedServerTs: number;
  /** ClockSync time at the first sample (server epoch ms, as estimated by the client). */
  startedClientTs: number;
  clockOffsetMs: number;
}

/** A track as stored. The file key is never part of it: use Store.getAudioTrackKey. */
export interface AudioTrackRow extends Omit<NewAudioTrack, "fileName" | "fileKey"> {
  /** Kept after a raw-audio deletion (the file itself is gone). */
  fileName: string | null;
  /** False once the raw audio was deleted (the key is gone: crypto-shredded). */
  hasKey: boolean;
  closedServerTs: number | null;
  stopReason: string | null;
  /** Samples received (sum over unique chunks). */
  samples: number;
  /** Unique chunks received. */
  chunks: number;
  /** Chunks the client reported as lost (e.g. its resend buffer overflowed). */
  droppedChunks: number;
  /** Payload bytes received (PCM bytes of unique chunks). */
  bytes: number;
  status: AudioTrackRowStatus;
  /** samples / sampleRate, in ms. */
  durationMs: number;
}

export interface NewAudioChunk {
  trackId: string;
  /** Chunk number within the track (0, 1, 2, …); also the record's seq in the file. */
  seq: number;
  /** Index of the chunk's first sample within the track. */
  startSample: number;
  sampleCount: number;
  /** ClockSync time at the first sample of the chunk. */
  clientTs: number;
  clockOffsetMs: number;
  /** Server time when the chunk arrived. */
  serverTs: number;
  round: number;
  phase: string;
  rmsDb: number | null;
  peakDb: number | null;
  /** Number of clipped samples. */
  clipped: number;
  /** Payload bytes written to the file; defaults to sampleCount × 2 (s16 mono). Not stored per chunk. */
  bytes?: number;
}

export interface AudioChunkRow extends Omit<NewAudioChunk, "bytes"> {
  serverWall: string;
}

export interface NewAudioDerivative {
  derivativeId: string;
  sessionId: string;
  /** Null for session-wide results (e.g. speech segments of all seats). */
  seat: number | null;
  participantCode: string | null;
  /** e.g. speech_segments, clean, transcript (DERIVATIVE_KINDS in audio/records.ts says which hold sound). */
  kind: string;
  /** Track ids the result was computed from (erasure removes results computed from a participant's tracks). */
  sourceTracks: string[];
  /** Either an encrypted file (AudioFileStore.createFile) … */
  fileName: string | null;
  fileKey: Buffer | null;
  /** … or a small JSON result (null for none). */
  data: unknown;
  params: Record<string, unknown>;
  engineVersion: string;
  createdServerTs?: number;
}

/** A derivative as listed: no key, no data. */
export interface AudioDerivativeRow extends Omit<NewAudioDerivative, "fileKey" | "data" | "createdServerTs"> {
  hasKey: boolean;
  hasData: boolean;
  createdServerTs: number;
  createdWall: string;
}

export interface AudioDerivativeWithData extends AudioDerivativeRow {
  data: unknown;
}

export interface AudioJobRow {
  jobId: string;
  sessionId: string;
  kind: string;
  /** e.g. queued, running, done, failed. */
  status: string;
  /** 0…1 */
  progress: number;
  params: Record<string, unknown>;
  /** A small summary (e.g. the derivative ids produced). Personal results belong in audio_derivatives. */
  result: unknown;
  error: string | null;
  startedWall: string;
  finishedWall: string | null;
}

export type NewAudioJob = Omit<AudioJobRow, "startedWall" | "finishedWall"> & {
  startedWall?: string;
  finishedWall?: string | null;
};

export interface AudioDeletionRow {
  id: number;
  sessionId: string;
  scope: AudioDeletionScope;
  requestedWall: string;
  executedWall: string;
  counts: Record<string, number>;
  note: string;
}

/** A file the database refers to, with its key (for verify and maintenance only, never for REST). */
export interface AudioFileRef {
  owner: "track" | "derivative";
  id: string;
  sessionId: string;
  fileName: string;
  key: Buffer | null;
  /** Track status; null for derivatives. */
  status: AudioTrackRowStatus | null;
}

const TRACK_COLUMNS = `track_id, session_id, seat, participant_code, file_name, file_key IS NOT NULL AS has_key,
  sample_rate, settings_json, reason, started_server_ts, started_client_ts, clock_offset_ms, closed_server_ts,
  stop_reason, samples, chunks, dropped_chunks, bytes, status`;

const DERIVATIVE_COLUMNS = `derivative_id, session_id, seat, participant_code, kind, source_tracks_json, file_name,
  file_key IS NOT NULL AS has_key, data_json IS NOT NULL AS has_data, params_json, engine_version,
  created_server_ts, created_wall`;

function rowToTrack(r: unknown): AudioTrackRow {
  const t = fromRow<AudioTrackRow>(r);
  t.durationMs = t.sampleRate > 0 ? Math.round((t.samples * 1000) / t.sampleRate) : 0;
  return t;
}

/** Thin data-access layer over the encrypted SQLite database. */
export class Store {
  private nextSeq = new Map<string, number>();

  /**
   * @param audioFiles where this database's encrypted audio files live (data/audio).
   *   Only the participant database has one: simulated sessions never record audio.
   *   Erasure, session deletion and audio deletion (PersonalDataMap) unlink files through it.
   */
  constructor(
    readonly db: DB,
    readonly audioFiles: AudioFileStore | null = null,
  ) {}

  /** The audio file store, for code that only runs for a database that has one (it throws otherwise). */
  requireAudioFiles(): AudioFileStore {
    if (!this.audioFiles) throw new Error("This database stores no audio (the simulation database)");
    return this.audioFiles;
  }

  /* ─────────── sessions ─────────── */

  insertSession(row: Omit<SessionRow, "updated_wall" | "condition">) {
    this.db
      .prepare(
        `INSERT INTO sessions (id, created_wall, scenario_id, scenario_version, scenario_hash, status, condition, tags_json,
          notes, config_json, harness_version, git_commit, updated_wall)
         VALUES (@id, @created_wall, @scenario_id, @scenario_version, @scenario_hash, @status, @condition, @tags_json,
          @notes, @config_json, @harness_version, @git_commit, @created_wall)`,
      )
      // `condition` is the pre-v3 column; it keeps a readable copy of the tags
      .run({ ...row, condition: (JSON.parse(row.tags_json) as string[]).join(", ") });
  }

  setSessionStatus(id: string, status: string) {
    this.db
      .prepare("UPDATE sessions SET status = ?, updated_wall = ? WHERE id = ?")
      .run(status, wall(nowTs()), id);
  }

  getSession(id: string): SessionRow | undefined {
    return this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
  }

  sessionConfig(id: string): SessionConfig | null {
    const row = this.getSession(id);
    return row ? (JSON.parse(row.config_json) as SessionConfig) : null;
  }

  listSessions(): SessionSummary[] {
    const rows = this.db
      .prepare(
        `SELECT s.*, (SELECT count(*) FROM events e WHERE e.session_id = s.id) AS event_count,
                (SELECT count(*) FROM telemetry t WHERE t.session_id = s.id) AS telemetry_count,
                (SELECT count(*) FROM audio_tracks a WHERE a.session_id = s.id AND a.status != 'deleted') AS audio_tracks,
                (SELECT ${AUDIO_MS_SQL} FROM audio_tracks a WHERE a.session_id = s.id AND a.status != 'deleted') AS audio_ms
         FROM sessions s ORDER BY s.created_wall DESC`,
      )
      .all() as Array<
      SessionRow & { event_count: number; telemetry_count: number; audio_tracks: number; audio_ms: number }
    >;
    const fakes = this.fakeSeatsBySession();
    return rows.map((r) => ({
      id: r.id,
      createdWall: r.created_wall,
      updatedWall: r.updated_wall,
      scenarioId: r.scenario_id,
      scenarioVersion: r.scenario_version,
      status: r.status,
      tags: JSON.parse(r.tags_json ?? "[]") as string[],
      notes: r.notes,
      eventCount: r.event_count,
      telemetryCount: r.telemetry_count,
      fakeSeats: fakes.get(r.id) ?? [],
      audioTracks: r.audio_tracks,
      audioMs: Math.round(r.audio_ms),
    }));
  }

  /** Which seats of each session are bound to a fake player, from its SeatBound / SeatUnbound events. */
  private fakeSeatsBySession(): Map<string, number[]> {
    const rows = this.db
      .prepare(
        `SELECT session_id, type, payload_json FROM events
         WHERE type IN ('SeatBound', 'SeatUnbound') ORDER BY session_id, seq`,
      )
      .all() as Array<{ session_id: string; type: string; payload_json: string }>;
    const bound = new Map<string, Map<number, boolean>>();
    for (const r of rows) {
      const p = JSON.parse(r.payload_json) as { seat: number; fake?: boolean };
      const seats = bound.get(r.session_id) ?? new Map<number, boolean>();
      bound.set(r.session_id, seats);
      if (r.type === "SeatBound") seats.set(p.seat, p.fake === true);
      else seats.delete(p.seat);
    }
    const out = new Map<string, number[]>();
    for (const [id, seats] of bound) {
      const fake = [...seats].filter(([, f]) => f).map(([seat]) => seat);
      if (fake.length)
        out.set(
          id,
          fake.sort((a, b) => a - b),
        );
    }
    return out;
  }

  /** The most recently created session that has not ended (for resuming after a restart). */
  latestUnfinishedSession(): { id: string; createdWall: string } | null {
    const row = this.db
      .prepare(
        `SELECT id, created_wall FROM sessions WHERE status NOT IN ('closed', 'aborted')
         ORDER BY created_wall DESC LIMIT 1`,
      )
      .get() as { id: string; created_wall: string } | undefined;
    return row ? { id: row.id, createdWall: row.created_wall } : null;
  }

  /* ─────────── events ─────────── */

  private allocSeq(sessionId: string): number {
    let next = this.nextSeq.get(sessionId);
    if (next === undefined) {
      const row = this.db
        .prepare(
          `SELECT max(coalesce((SELECT max(seq) FROM events WHERE session_id = @id), 0),
                      coalesce((SELECT last_seq FROM sessions WHERE id = @id), 0)) AS m`,
        )
        .get({ id: sessionId }) as { m: number };
      next = row.m + 1;
    }
    this.nextSeq.set(sessionId, next + 1);
    return next;
  }

  /** Append an event. seq, timestamps and round are assigned here. */
  appendEvent(sessionId: string, ev: NewEvent, round: number, ts = nowTs()): StoredEvent {
    try {
      return this.insertEvent(sessionId, ev, round, ts);
    } catch (e) {
      // Another process (the CLI) may have appended to this session: refresh the seq cache and retry once.
      if ((e as { code?: string }).code !== "SQLITE_CONSTRAINT_PRIMARYKEY") throw e;
      this.nextSeq.delete(sessionId);
      return this.insertEvent(sessionId, ev, round, ts);
    }
  }

  private insertEvent(sessionId: string, ev: NewEvent, round: number, ts: number): StoredEvent {
    const seq = this.allocSeq(sessionId);
    const stored = {
      sessionId,
      seq,
      type: ev.type,
      actorKind: ev.actorKind,
      seat: ev.seat ?? null,
      participantCode: ev.participantCode ?? null,
      round,
      serverTs: ts,
      serverWall: wall(ts),
      clientTs: ev.clientTs ?? null,
      clientSeq: ev.clientSeq ?? null,
      payload: ev.payload,
    } as StoredEvent;
    try {
      this.db.transaction(() => {
        insert(this.db, "events", stored, ["payload"]);
        this.db.prepare("UPDATE sessions SET last_seq = max(last_seq, ?) WHERE id = ?").run(seq, sessionId);
      })();
    } catch (e) {
      this.nextSeq.delete(sessionId);
      throw e;
    }
    return stored;
  }

  listEvents(sessionId: string): StoredEvent[] {
    return this.db
      .prepare("SELECT * FROM events WHERE session_id = ? ORDER BY seq")
      .all(sessionId)
      .map(fromRow<StoredEvent>);
  }

  /** Forget cached sequence numbers (after erasure or external modification). */
  resetSeqCache() {
    this.nextSeq.clear();
  }

  /* ─────────── telemetry ─────────── */

  insertTelemetry(
    sessionId: string,
    seat: number,
    participantCode: string,
    round: number,
    clockOffsetMs: number,
    items: TelemetryItem[],
    ts = nowTs(),
  ): StoredTelemetry[] {
    const out: StoredTelemetry[] = [];
    const serverWall = wall(ts);
    this.db.transaction(() => {
      for (const it of items) {
        const row = {
          sessionId,
          seat,
          participantCode,
          round,
          type: it.type,
          clientTs: it.clientTs,
          clientOffsetMs: clockOffsetMs,
          serverTs: ts,
          serverWall,
          payload: it.payload,
        };
        out.push({ id: Number(insert(this.db, "telemetry", row, ["payload"]).lastInsertRowid), ...row });
      }
    })();
    return out;
  }

  listTelemetry(sessionId: string, opts: { afterId?: number; limit?: number } = {}): StoredTelemetry[] {
    return this.db
      .prepare("SELECT * FROM telemetry WHERE session_id = ? AND id > ? ORDER BY id LIMIT ?")
      .all(sessionId, opts.afterId ?? 0, opts.limit ?? 1_000_000)
      .map(fromRow<StoredTelemetry>);
  }

  /* ─────────── audio tracks and chunks ─────────── */

  /** Insert a track (status `recording`). Returns false if the track id already exists. */
  insertAudioTrack(t: NewAudioTrack): boolean {
    const row = { ...t, status: "recording" };
    return (
      insert(this.db, "audio_tracks", row, ["settings"], "ON CONFLICT (track_id) DO NOTHING").changes === 1
    );
  }

  /** Mark a recording track closed. Returns false if it was not recording (already closed, deleted or unknown). */
  closeAudioTrack(
    trackId: string,
    opts: { closedServerTs: number; stopReason: string; droppedChunks?: number },
  ): boolean {
    const info = this.db
      .prepare(
        `UPDATE audio_tracks SET status = 'closed', closed_server_ts = ?, stop_reason = ?,
          dropped_chunks = max(dropped_chunks, ?)
         WHERE track_id = ? AND status = 'recording'`,
      )
      .run(opts.closedServerTs, opts.stopReason, opts.droppedChunks ?? 0, trackId);
    return info.changes === 1;
  }

  /** Count chunks the client reports as lost. */
  addDroppedAudioChunks(trackId: string, count: number) {
    this.db
      .prepare("UPDATE audio_tracks SET dropped_chunks = dropped_chunks + ? WHERE track_id = ?")
      .run(count, trackId);
  }

  getAudioTrack(trackId: string): AudioTrackRow | undefined {
    const r = this.db.prepare(`SELECT ${TRACK_COLUMNS} FROM audio_tracks WHERE track_id = ?`).get(trackId);
    return r ? rowToTrack(r) : undefined;
  }

  /** The track's file key; null if the track is unknown or its raw audio was deleted. */
  getAudioTrackKey(trackId: string): Buffer | null {
    const r = this.db.prepare("SELECT file_key FROM audio_tracks WHERE track_id = ?").get(trackId) as
      | { file_key: Buffer | null }
      | undefined;
    return r?.file_key ?? null;
  }

  /** A session's tracks, by seat and start time. */
  listAudioTracks(
    sessionId: string,
    opts: { seat?: number; status?: AudioTrackRowStatus } = {},
  ): AudioTrackRow[] {
    return this.db
      .prepare(
        `SELECT ${TRACK_COLUMNS} FROM audio_tracks
         WHERE session_id = @sessionId AND (@seat IS NULL OR seat = @seat) AND (@status IS NULL OR status = @status)
         ORDER BY seat, started_server_ts, track_id`,
      )
      .all({ sessionId, seat: opts.seat ?? null, status: opts.status ?? null })
      .map(rowToTrack);
  }

  /**
   * Record a chunk and add it to the track's counters, in one transaction.
   * Idempotent: returns false (and changes nothing) if (trackId, seq) is
   * already stored, e.g. a chunk the client resent after reconnecting.
   * Throws for an unknown track or a track whose raw audio was deleted.
   */
  insertAudioChunk(c: NewAudioChunk): boolean {
    return this.db.transaction(() => {
      const track = this.db.prepare("SELECT status FROM audio_tracks WHERE track_id = ?").get(c.trackId) as
        | { status: AudioTrackRowStatus }
        | undefined;
      if (!track) throw new Error(`Unknown audio track ${c.trackId}`);
      if (track.status === "deleted") throw new Error(`The audio of track ${c.trackId} was deleted`);
      const { bytes: _bytes, ...chunk } = c;
      const row: AudioChunkRow = { ...chunk, serverWall: wall(c.serverTs) };
      if (insert(this.db, "audio_chunks", row, [], "ON CONFLICT (track_id, seq) DO NOTHING").changes !== 1)
        return false;
      this.db
        .prepare(
          "UPDATE audio_tracks SET samples = samples + ?, chunks = chunks + 1, bytes = bytes + ? WHERE track_id = ?",
        )
        .run(c.sampleCount, c.bytes ?? c.sampleCount * 2, c.trackId);
      return true;
    })();
  }

  hasAudioChunk(trackId: string, seq: number): boolean {
    return Boolean(
      this.db.prepare("SELECT 1 FROM audio_chunks WHERE track_id = ? AND seq = ?").get(trackId, seq),
    );
  }

  /** A track's chunks, by seq. */
  listAudioChunks(trackId: string): AudioChunkRow[] {
    return this.db
      .prepare("SELECT * FROM audio_chunks WHERE track_id = ? ORDER BY seq")
      .all(trackId)
      .map(fromRow<AudioChunkRow>);
  }

  /* ─────────── audio derivatives ─────────── */

  insertAudioDerivative(d: NewAudioDerivative): AudioDerivativeRow {
    const ts = d.createdServerTs ?? nowTs();
    const created = { ...d, createdServerTs: ts, createdWall: wall(ts) };
    insert(this.db, "audio_derivatives", created, ["sourceTracks", "data", "params"]);
    const { data: _data, ...row } = this.getAudioDerivative(d.derivativeId)!;
    return row;
  }

  /** One derivative with its JSON data (null when the result is a file). */
  getAudioDerivative(derivativeId: string): AudioDerivativeWithData | undefined {
    const r = this.db
      .prepare(`SELECT ${DERIVATIVE_COLUMNS}, data_json FROM audio_derivatives WHERE derivative_id = ?`)
      .get(derivativeId);
    return r ? fromRow<AudioDerivativeWithData>(r) : undefined;
  }

  getAudioDerivativeKey(derivativeId: string): Buffer | null {
    const r = this.db
      .prepare("SELECT file_key FROM audio_derivatives WHERE derivative_id = ?")
      .get(derivativeId) as { file_key: Buffer | null } | undefined;
    return r?.file_key ?? null;
  }

  /** A session's derivatives (without data), oldest first. */
  listAudioDerivatives(
    sessionId: string,
    opts: { kind?: AudioDerivativeKind; seat?: number } = {},
  ): AudioDerivativeRow[] {
    return this.db
      .prepare(
        `SELECT ${DERIVATIVE_COLUMNS} FROM audio_derivatives
         WHERE session_id = @sessionId AND (@kind IS NULL OR kind = @kind) AND (@seat IS NULL OR seat = @seat)
         ORDER BY created_server_ts, derivative_id`,
      )
      .all({ sessionId, kind: opts.kind ?? null, seat: opts.seat ?? null })
      .map(fromRow<AudioDerivativeRow>);
  }

  /**
   * Delete one derivative row (its key goes with it). Returns the removed row
   * so the caller can unlink its file with audioFiles.deleteFile, or null.
   */
  deleteAudioDerivative(derivativeId: string): AudioDerivativeRow | null {
    const found = this.getAudioDerivative(derivativeId);
    if (!found) return null;
    this.db.prepare("DELETE FROM audio_derivatives WHERE derivative_id = ?").run(derivativeId);
    const { data: _data, ...row } = found;
    return row;
  }

  /* ─────────── audio jobs ─────────── */

  /** Insert a job, or update an existing one (status, progress, params, result, error, finishedWall). */
  upsertAudioJob(job: NewAudioJob) {
    const row = {
      ...job,
      startedWall: job.startedWall ?? wall(nowTs()),
      finishedWall: job.finishedWall ?? null,
    };
    insert(
      this.db,
      "audio_jobs",
      row,
      ["params", "result"],
      `ON CONFLICT (job_id) DO UPDATE SET status = excluded.status, progress = excluded.progress,
         params_json = excluded.params_json, result_json = excluded.result_json, error = excluded.error,
         finished_wall = excluded.finished_wall`,
    );
  }

  getAudioJob(jobId: string): AudioJobRow | undefined {
    const r = this.db.prepare("SELECT * FROM audio_jobs WHERE job_id = ?").get(jobId);
    return r ? fromRow<AudioJobRow>(r) : undefined;
  }

  /** Jobs of one session (or of every session), newest first. */
  listAudioJobs(sessionId?: string): AudioJobRow[] {
    return this.db
      .prepare(
        `SELECT * FROM audio_jobs WHERE (@sessionId IS NULL OR session_id = @sessionId)
         ORDER BY started_wall DESC, job_id`,
      )
      .all({ sessionId: sessionId ?? null })
      .map(fromRow<AudioJobRow>);
  }

  /* ─────────── audio deletion register ─────────── */

  insertAudioDeletion(row: Omit<AudioDeletionRow, "id">): AudioDeletionRow {
    const info = insert(this.db, "audio_deletions", row, ["counts"]);
    return { id: Number(info.lastInsertRowid), ...row };
  }

  /** The audio-deletion register (of one session, or all), oldest first. */
  listAudioDeletions(sessionId?: string): AudioDeletionRow[] {
    return this.db
      .prepare(
        "SELECT * FROM audio_deletions WHERE (@sessionId IS NULL OR session_id = @sessionId) ORDER BY id",
      )
      .all({ sessionId: sessionId ?? null })
      .map(fromRow<AudioDeletionRow>);
  }

  /** Every file the database refers to (tracks, deleted ones included, and derivatives), with keys. */
  audioFileRefs(): AudioFileRef[] {
    const tracks = this.db.prepare(
      `SELECT 'track' AS owner, track_id AS id, session_id, file_name, file_key AS key, status FROM audio_tracks
       WHERE file_name IS NOT NULL`,
    );
    const derived = this.db.prepare(
      `SELECT 'derivative' AS owner, derivative_id AS id, session_id, file_name, file_key AS key, NULL AS status
       FROM audio_derivatives WHERE file_name IS NOT NULL`,
    );
    return [...tracks.all(), ...derived.all()].map(fromRow<AudioFileRef>);
  }

  /* ─────────── export register ─────────── */

  /**
   * Add an entry to the export register (`exports`). `codeHashes` are the SHA-256
   * of every participant code the export contains, so an erasure request finds it.
   */
  registerExport(e: {
    id: string;
    sessionId: string;
    kind: RegisteredExportKind;
    createdWall: string;
    path: string;
    codeHashes: string[];
    files: unknown[];
    details?: Record<string, unknown>;
  }) {
    const row = { ...e, codeHashes: [...e.codeHashes].sort(), details: e.details ?? {} };
    insert(this.db, "exports", row, ["codeHashes", "files", "details"]);
  }

  /** The export register, newest first (of one session and/or one kind when given). */
  listExports(filter: { sessionId?: string; kind?: RegisteredExportKind } = {}): ExportListRow[] {
    return this.db
      .prepare(
        `SELECT id, session_id, kind, created_wall, path, details_json, json_array_length(files_json) AS files
         FROM exports WHERE (@sessionId IS NULL OR session_id = @sessionId) AND (@kind IS NULL OR kind = @kind)
         ORDER BY created_wall DESC, id`,
      )
      .all({ sessionId: filter.sessionId ?? null, kind: filter.kind ?? null })
      .map(fromRow<ExportListRow>);
  }

  /** Audio rows (tracks and derivatives) in this database: the simulation database must have none. */
  audioRowCount(): number {
    return (
      this.db
        .prepare("SELECT (SELECT count(*) FROM audio_tracks) + (SELECT count(*) FROM audio_derivatives) AS n")
        .get() as { n: number }
    ).n;
  }

  /* ─────────── participant codes (the tables: CODE_TABLES in personalData.ts) ─────────── */

  codeExists(code: string): boolean {
    return CODE_TABLES.some((t) =>
      this.db.prepare(`SELECT 1 FROM ${t.table} WHERE ${t.codeColumn} = ? LIMIT 1`).get(code),
    );
  }

  /** Every participant code that occurs in a session, unordered. */
  sessionCodes(sessionId: string): string[] {
    const sql = CODE_TABLES.map(
      (t) =>
        `SELECT ${t.codeColumn} AS c FROM ${t.table} WHERE (${t.ofSession}) AND ${t.codeColumn} IS NOT NULL`,
    ).join(" UNION ");
    const rows = this.db.prepare(sql).all(...CODE_TABLES.map(() => sessionId)) as Array<{ c: string }>;
    return rows.map((r) => r.c);
  }

  /** Every participant code in the database, unordered (for integrity checks). */
  participantCodes(): string[] {
    const sql = CODE_TABLES.map(
      (t) => `SELECT ${t.codeColumn} AS c FROM ${t.table} WHERE ${t.codeColumn} IS NOT NULL`,
    ).join(" UNION ");
    return this.db.prepare(sql).pluck().all() as string[];
  }
}

/** Kinds in the export register: the two CSV exports and the separate "Export audio" action. */
export type RegisteredExportKind = "standard" | "anonymised" | "audio";

export interface ExportRow {
  id: string;
  sessionId: string;
  kind: RegisteredExportKind;
  createdWall: string;
  path: string;
}

/** An export register entry with what was asked for (`details`) and how many files it wrote. */
export interface ExportListRow extends ExportRow {
  details: Record<string, unknown>;
  files: number;
}
