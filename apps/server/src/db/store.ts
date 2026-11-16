import type {
  EventType,
  NewEvent,
  SessionConfig,
  StoredEvent,
  StoredTelemetry,
  TelemetryItem,
} from "@wkwa/shared";
import { nowTs, wall } from "../runtime";
import type { DB } from "./database";

export interface SessionRow {
  id: string;
  created_wall: string;
  scenario_id: string;
  scenario_version: string;
  scenario_hash: string;
  status: string;
  condition: string;
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
  condition: string;
  notes: string;
  eventCount: number;
  telemetryCount: number;
}

interface EventRow {
  session_id: string;
  seq: number;
  type: string;
  actor_kind: string;
  seat: number | null;
  participant_code: string | null;
  round: number;
  server_ts: number;
  server_wall: string;
  client_ts: number | null;
  client_seq: number | null;
  payload_json: string;
}

interface TelemetryRow {
  id: number;
  session_id: string;
  seat: number;
  participant_code: string;
  round: number;
  type: string;
  client_ts: number;
  client_offset_ms: number;
  server_ts: number;
  server_wall: string;
  payload_json: string;
}

function rowToEvent(r: EventRow): StoredEvent {
  return {
    sessionId: r.session_id,
    seq: r.seq,
    type: r.type as EventType,
    actorKind: r.actor_kind as StoredEvent["actorKind"],
    seat: r.seat,
    participantCode: r.participant_code,
    round: r.round,
    serverTs: r.server_ts,
    serverWall: r.server_wall,
    clientTs: r.client_ts,
    clientSeq: r.client_seq,
    payload: JSON.parse(r.payload_json),
  } as StoredEvent;
}

function rowToTelemetry(r: TelemetryRow): StoredTelemetry {
  return {
    id: r.id,
    sessionId: r.session_id,
    seat: r.seat,
    participantCode: r.participant_code,
    round: r.round,
    type: r.type as StoredTelemetry["type"],
    clientTs: r.client_ts,
    clientOffsetMs: r.client_offset_ms,
    serverTs: r.server_ts,
    serverWall: r.server_wall,
    payload: JSON.parse(r.payload_json),
  };
}

/** Thin data-access layer over the encrypted SQLite database. */
export class Store {
  private nextSeq = new Map<string, number>();

  constructor(readonly db: DB) {}

  /* ─────────── sessions ─────────── */

  insertSession(row: Omit<SessionRow, "updated_wall">) {
    this.db
      .prepare(
        `INSERT INTO sessions (id, created_wall, scenario_id, scenario_version, scenario_hash, status, condition, notes,
          config_json, harness_version, git_commit, updated_wall)
         VALUES (@id, @created_wall, @scenario_id, @scenario_version, @scenario_hash, @status, @condition, @notes,
          @config_json, @harness_version, @git_commit, @created_wall)`,
      )
      .run(row);
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
                (SELECT count(*) FROM telemetry t WHERE t.session_id = s.id) AS telemetry_count
         FROM sessions s ORDER BY s.created_wall DESC`,
      )
      .all() as Array<SessionRow & { event_count: number; telemetry_count: number }>;
    return rows.map((r) => ({
      id: r.id,
      createdWall: r.created_wall,
      updatedWall: r.updated_wall,
      scenarioId: r.scenario_id,
      scenarioVersion: r.scenario_version,
      status: r.status,
      condition: r.condition,
      notes: r.notes,
      eventCount: r.event_count,
      telemetryCount: r.telemetry_count,
    }));
  }

  /* ─────────── events ─────────── */

  private allocSeq(sessionId: string): number {
    let next = this.nextSeq.get(sessionId);
    if (next === undefined) {
      const row = this.db.prepare("SELECT max(seq) AS m FROM events WHERE session_id = ?").get(sessionId) as {
        m: number | null;
      };
      next = (row.m ?? 0) + 1;
    }
    this.nextSeq.set(sessionId, next + 1);
    return next;
  }

  /** Append an event. seq, timestamps and round are assigned here. */
  appendEvent(sessionId: string, ev: NewEvent, round: number, ts = nowTs()): StoredEvent {
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
      this.db
        .prepare(
          `INSERT INTO events (session_id, seq, type, actor_kind, seat, participant_code, round, server_ts, server_wall,
            client_ts, client_seq, payload_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          sessionId,
          seq,
          stored.type,
          stored.actorKind,
          stored.seat,
          stored.participantCode,
          round,
          ts,
          stored.serverWall,
          stored.clientTs,
          stored.clientSeq,
          JSON.stringify(stored.payload),
        );
    } catch (e) {
      this.nextSeq.delete(sessionId);
      throw e;
    }
    return stored;
  }

  listEvents(sessionId: string): StoredEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE session_id = ? ORDER BY seq")
      .all(sessionId) as EventRow[];
    return rows.map(rowToEvent);
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
    const stmt = this.db.prepare(
      `INSERT INTO telemetry (session_id, seat, participant_code, round, type, client_ts, client_offset_ms, server_ts,
        server_wall, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const out: StoredTelemetry[] = [];
    const serverWall = wall(ts);
    this.db.transaction(() => {
      for (const it of items) {
        const info = stmt.run(
          sessionId,
          seat,
          participantCode,
          round,
          it.type,
          it.clientTs,
          clockOffsetMs,
          ts,
          serverWall,
          JSON.stringify(it.payload),
        );
        out.push({
          id: Number(info.lastInsertRowid),
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
        });
      }
    })();
    return out;
  }

  listTelemetry(sessionId: string, opts: { afterId?: number; limit?: number } = {}): StoredTelemetry[] {
    const rows = this.db
      .prepare("SELECT * FROM telemetry WHERE session_id = ? AND id > ? ORDER BY id LIMIT ?")
      .all(sessionId, opts.afterId ?? 0, opts.limit ?? 1_000_000) as TelemetryRow[];
    return rows.map(rowToTelemetry);
  }

  /* ─────────── participants ─────────── */

  codeExists(code: string): boolean {
    const a = this.db.prepare("SELECT 1 FROM events WHERE participant_code = ? LIMIT 1").get(code);
    const b = this.db.prepare("SELECT 1 FROM telemetry WHERE participant_code = ? LIMIT 1").get(code);
    return Boolean(a || b);
  }

  /** Where does a participant code occur? (for takedown look-ups) */
  lookupCode(
    code: string,
  ): Array<{ sessionId: string; seat: number | null; events: number; telemetry: number }> {
    const ev = this.db
      .prepare(
        "SELECT session_id, max(seat) AS seat, count(*) AS n FROM events WHERE participant_code = ? GROUP BY session_id",
      )
      .all(code) as Array<{ session_id: string; seat: number | null; n: number }>;
    const tel = this.db
      .prepare(
        "SELECT session_id, count(*) AS n FROM telemetry WHERE participant_code = ? GROUP BY session_id",
      )
      .all(code) as Array<{ session_id: string; n: number }>;
    const map = new Map<
      string,
      { sessionId: string; seat: number | null; events: number; telemetry: number }
    >();
    for (const r of ev)
      map.set(r.session_id, { sessionId: r.session_id, seat: r.seat, events: r.n, telemetry: 0 });
    for (const r of tel) {
      const e = map.get(r.session_id) ?? { sessionId: r.session_id, seat: null, events: 0, telemetry: 0 };
      e.telemetry = r.n;
      map.set(r.session_id, e);
    }
    return [...map.values()];
  }
}
