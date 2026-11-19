import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  generateParticipantCode,
  type NewEvent,
  parseSessionConfig,
  reduceEvents,
  type TelemetryItem,
} from "@wkwa/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AudioFileStore } from "../src/audio/fileStore";
import { sha256 } from "../src/content";
import { type DB, openDatabase } from "../src/db/database";
import {
  CODE_TABLES,
  DELETION_REGISTERS,
  PERSONAL_DATA,
  PersonalDataMap,
  type PersonalDataTable,
} from "../src/db/personalData";
import { Store } from "../src/db/store";
import { nowTs, wall } from "../src/runtime";
import { addTrack } from "./audioFixtures";
import { cleanup, PASSPHRASE } from "./harness";

/** Tables that hold no session's data and no participant code. */
const NOT_PERSONAL = ["meta"];

interface Column {
  name: string;
  type: string;
}

function schema(db: DB): Map<string, Column[]> {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .pluck()
    .all() as string[];
  return new Map(tables.map((t) => [t, db.prepare(`PRAGMA table_info(${t})`).all() as Column[]]));
}

/** Rows per table in which any text column contains `needle` (BLOB columns, i.e. keys, are skipped). */
function rowsContaining(db: DB, needle: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [table, columns] of schema(db)) {
    const text = columns.filter((c) => c.type.toUpperCase() !== "BLOB").map((c) => c.name);
    const where = text.map((c) => `instr(CAST(${c} AS TEXT), @needle) > 0`).join(" OR ");
    const n = (
      db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get({ needle }) as { n: number }
    ).n;
    if (n) out[table] = n;
  }
  return out;
}

function count(db: DB, t: PersonalDataTable, where: string, ...params: string[]): number {
  return (db.prepare(`SELECT count(*) AS n FROM ${t.table} WHERE ${where}`).get(...params) as { n: number })
    .n;
}

/** The participant's rows of a session, as erasure selects them. */
function participantWhere(t: PersonalDataTable): string | null {
  return t.ofParticipant ?? (t.codeColumn ? `${t.ofSession} AND ${t.codeColumn} = ?` : null);
}

let n = 0;
/** A session with four participants and a row in every PERSONAL_DATA table. */
async function seedSession(store: Store, files: AudioFileStore, codes: Record<number, string>) {
  const sessionId = `S-20261119-T${String(++n).padStart(3, "0")}`;
  store.insertSession({
    id: sessionId,
    created_wall: wall(nowTs()),
    scenario_id: "demo",
    scenario_version: "1",
    scenario_hash: "h",
    status: "closed",
    tags_json: "[]",
    notes: "",
    config_json: "{}",
    harness_version: "0",
    git_commit: "test",
  });
  // the replay needs it to have seats
  store.appendEvent(
    sessionId,
    {
      type: "SessionCreated",
      actorKind: "system",
      payload: { config: parseSessionConfig({}), scenario: {}, regionIds: [], viewIds: [] },
    } as unknown as NewEvent,
    0,
  );
  const seats = Object.keys(codes).map(Number);
  const trackIds: Record<number, string> = {};
  for (const seat of seats) {
    const code = codes[seat]!;
    store.appendEvent(
      sessionId,
      {
        type: "SeatBound",
        actorKind: "facilitator",
        seat,
        participantCode: code,
        payload: { seat, terminal: seat, bindingId: `b-${seat}` },
      } as NewEvent,
      0,
    );
    store.insertTelemetry(sessionId, seat, code, 1, 0, [
      { type: "screen_view", clientTs: nowTs(), payload: { screen: "map" } } as unknown as TelemetryItem,
    ]);
    const t = await addTrack(store, files, sessionId, seat, code, 2);
    trackIds[seat] = t.trackId;
    const clean = await files.createFile(sessionId);
    store.insertAudioDerivative({
      derivativeId: `${sessionId}-clean-${seat}`,
      sessionId,
      seat,
      participantCode: code,
      kind: "clean_track",
      sourceTracks: [t.trackId],
      fileName: clean.fileName,
      fileKey: clean.key,
      data: null,
      params: {},
      engineVersion: "test",
    });
  }
  store.appendEvent(
    sessionId,
    { type: "SessionNote", actorKind: "facilitator", payload: { text: "no code here" } } as NewEvent,
    0,
  );
  // a session-wide result computed from every track
  store.insertAudioDerivative({
    derivativeId: `${sessionId}-segments`,
    sessionId,
    seat: null,
    participantCode: null,
    kind: "speech_segments",
    sourceTracks: Object.values(trackIds),
    fileName: null,
    fileKey: null,
    data: { segments: [] },
    params: {},
    engineVersion: "test",
  });
  store.upsertAudioJob({
    jobId: `${sessionId}-job`,
    sessionId,
    kind: "attribution",
    status: "done",
    progress: 1,
    params: {},
    result: { talkTime: seats },
    error: null,
  });
  store.registerExport({
    id: `${sessionId}-export`,
    sessionId,
    kind: "standard",
    createdWall: wall(nowTs()),
    path: `/exports/${sessionId}/E-1`,
    codeHashes: Object.values(codes).map(sha256),
    files: [],
  });
  return { sessionId, trackIds };
}

describe("personal-data map", () => {
  let dir: string;
  let db: DB;
  let files: AudioFileStore;
  let store: Store;
  let map: PersonalDataMap;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "wkwa-pdm-"));
    db = openDatabase(path.join(dir, "wkwa.db"), PASSPHRASE);
    files = new AudioFileStore(path.join(dir, "audio"));
    store = new Store(db, files);
    map = new PersonalDataMap(store);
  });

  afterEach(() => {
    db.close();
    cleanup(dir);
  });

  it("the registry covers every table of the schema", () => {
    const registered = new Map(PERSONAL_DATA.map((t) => [t.table, t]));
    const registers = new Set<string>(DELETION_REGISTERS);
    for (const [table, columns] of schema(db)) {
      const names = new Set(columns.map((c) => c.name));
      const fks = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{ table: string }>;
      const entry = registered.get(table);
      expect(
        Boolean(entry) || registers.has(table) || NOT_PERSONAL.includes(table),
        `${table} is not classified`,
      ).toBe(true);
      if (names.has("participant_code"))
        expect(entry?.codeColumn, `${table} holds participant codes: give it a codeColumn`).toBe(
          "participant_code",
        );
      if (names.has("session_id") || fks.some((f) => f.table === "sessions"))
        expect(entry || registers.has(table), `${table} holds session ids`).toBeTruthy();
      if (names.has("file_key")) expect(entry?.audioFile, `${table} refers to audio files`).toBeTruthy();
      if (names.has("code_hashes_json"))
        expect(entry?.codeHashes || registers.has(table), `${table} holds code hashes`).toBeTruthy();
    }
    expect(CODE_TABLES.map((t) => t.table)).toEqual(
      PERSONAL_DATA.filter((t) => t.codeColumn).map((t) => t.table),
    );
  });

  it("after an erasure no table holds the code, and the other participants are untouched", async () => {
    const code = generateParticipantCode();
    const others = [2, 3, 4].map(() => generateParticipantCode());
    const a = await seedSession(store, files, { 1: code, 2: others[0]!, 3: others[1]! });
    const b = await seedSession(store, files, { 1: others[2]!, 2: code });
    const sessions = [a.sessionId, b.sessionId];

    // the fixture has the participant's rows in every table erasure empties
    for (const t of PERSONAL_DATA) {
      const where = participantWhere(t);
      if (!where) continue;
      for (const s of sessions) expect(count(db, t, where, s, code), `${t.table} of ${s}`).toBeGreaterThan(0);
    }
    expect(store.sessionCodes(a.sessionId).sort()).toEqual([code, others[0], others[1]].sort());
    const before = map.lookup(code);
    expect(before.occurrences.map((o) => [o.sessionId, o.seat])).toEqual([
      [a.sessionId, 1],
      [b.sessionId, 2],
    ]);
    expect(before.exports.map((e) => e.sessionId).sort()).toEqual(sessions);
    const otherRows = rowsContaining(db, others[0]!);
    const filesBefore = files.listFiles().length;

    const r = map.erase(code.toLowerCase(), "invariant");

    expect(r.erased).toBe(true);
    expect(r.rows).toMatchObject({ events: 2, telemetry: 2, audioTracks: 2, audioChunks: 4 });
    // each session: their cleaned track and the session-wide segments (computed from their track)
    expect(r.rows.audioDerivatives).toBe(4);
    expect(r.audioFiles).toEqual({ removed: 4, failed: [] });
    expect(files.listFiles()).toHaveLength(filesBefore - 4);
    // every registered table, and in fact every table of the schema
    for (const t of CODE_TABLES) expect(count(db, t, `${t.codeColumn} = ?`, code), t.table).toBe(0);
    for (const t of PERSONAL_DATA) {
      const where = participantWhere(t);
      if (where) for (const s of sessions) expect(count(db, t, where, s, code), t.table).toBe(0);
    }
    expect(rowsContaining(db, code)).toEqual({});
    expect(store.codeExists(code)).toBe(false);
    expect(store.participantCodes()).not.toContain(code);
    // the register and the export register keep only its hash
    expect(rowsContaining(db, sha256(code))).toEqual({ erasures: 1, exports: 2 });
    expect(map.erasures()).toMatchObject([
      { codeSha256: sha256(code), note: "invariant", rows: { ...r.rows, audioFiles: 4 } },
    ]);
    // the other participants keep everything but the shared result computed from the erased track
    expect(rowsContaining(db, others[0]!)).toEqual(otherRows);
    expect(store.listAudioJobs(a.sessionId)[0]!.result).toBeNull();
    // a withdrawal marker (without the code) in each session
    for (const s of sessions)
      expect(store.listEvents(s).at(-1)).toMatchObject({
        type: "ParticipantWithdrawn",
        participantCode: null,
      });

    const again = map.lookup(code);
    expect(again.occurrences).toEqual([]);
    expect(again.previouslyErased).toHaveLength(1);
    expect(map.erase(code).erased).toBe(false);
  });

  it("an erasure does not withdraw the participant who holds the seat now", async () => {
    const [a, b] = [generateParticipantCode(), generateParticipantCode()];
    const { sessionId } = await seedSession(store, files, { 2: a });
    // seat 2 rebound (replaced) to b in the lobby
    store.appendEvent(
      sessionId,
      {
        type: "SeatBound",
        actorKind: "facilitator",
        seat: 2,
        participantCode: b,
        payload: { seat: 2, terminal: 2, bindingId: "b-2-again" },
      } as NewEvent,
      0,
    );
    expect(map.erase(a).erased).toBe(true);
    expect(store.listEvents(sessionId).some((e) => e.type === "ParticipantWithdrawn")).toBe(false);
    const seat = reduceEvents(store.listEvents(sessionId)).seats[2]!;
    expect(seat).toMatchObject({ participantCode: b, withdrawn: false });
  });

  it("after deleting a session no table holds its id, and the other session is untouched", async () => {
    const a = await seedSession(store, files, { 1: generateParticipantCode(), 2: generateParticipantCode() });
    const b = await seedSession(store, files, { 1: generateParticipantCode() });
    for (const t of PERSONAL_DATA) expect(count(db, t, t.ofSession, a.sessionId), t.table).toBeGreaterThan(0);
    const keep = PERSONAL_DATA.map((t) => count(db, t, t.ofSession, b.sessionId));
    const codes = store.sessionCodes(a.sessionId).map(sha256).sort();

    const r = map.deleteSession(a.sessionId, { exportsDir: path.join(dir, "exports"), note: "invariant" });

    expect(r.rows).toEqual({
      events: 4,
      telemetry: 2,
      exports: 1,
      audioTracks: 2,
      audioChunks: 4,
      audioDerivatives: 3,
      audioJobs: 1,
    });
    expect(r.audio).toEqual({ dirRemoved: true, files: 4 });
    for (const t of PERSONAL_DATA) expect(count(db, t, t.ofSession, a.sessionId), t.table).toBe(0);
    // only the deletion register still names the session (to re-apply the deletion after a restore)
    expect(rowsContaining(db, a.sessionId)).toEqual({ session_deletions: 1 });
    expect(PERSONAL_DATA.map((t) => count(db, t, t.ofSession, b.sessionId))).toEqual(keep);
    expect(map.sessionDeletions()).toMatchObject([{ sessionId: a.sessionId, participants: 2, rows: r.rows }]);
    expect(
      JSON.parse(
        (db.prepare("SELECT code_hashes_json FROM session_deletions").pluck().get() as string) ?? "[]",
      ),
    ).toEqual(codes);
    expect(() => map.deleteSession(a.sessionId, { exportsDir: dir })).toThrow(/Unknown session/);
  });

  it("deleting all audio empties every audio table of the session", async () => {
    const a = await seedSession(store, files, { 1: generateParticipantCode(), 3: generateParticipantCode() });
    const r = map.deleteAudio(a.sessionId, { scope: "all", note: "invariant" });
    expect(r.counts).toMatchObject({
      tracks: 2,
      chunks: 4,
      derivatives: 3,
      jobs: 1,
      files: 4,
      seatMask: 0b1010,
    });
    expect(r.audioFiles).toEqual({ removed: 4, failed: [], dirRemoved: true });
    for (const t of PERSONAL_DATA) {
      const left = count(db, t, t.ofSession, a.sessionId);
      if (t.audio) expect(left, t.table).toBe(0);
      else expect(left, t.table).toBeGreaterThan(0);
    }
    expect(store.listAudioDeletions(a.sessionId)).toMatchObject([{ scope: "all", note: "invariant" }]);
  });
});
