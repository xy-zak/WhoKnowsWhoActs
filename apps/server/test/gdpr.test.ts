import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { EXPORT_FILES, expandColumns } from "@wkwa/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backupDatabase, openDatabase, rekeyDatabase, WrongPassphraseError } from "../src/db/database";
import { PersonalDataMap } from "../src/db/personalData";
import { Store } from "../src/db/store";
import { exportSession, readManifest } from "../src/gdpr/exporter";
import { REPO_ROOT } from "../src/runtime";
import { cleanup, PASSPHRASE, readCsv, setupSession, startTestServer, type TestServer } from "./harness";

function readAll(dir: string): string {
  return readdirSync(dir)
    .map((f) => readFileSync(path.join(dir, f), "utf8"))
    .join("\n");
}

describe("GDPR tooling", () => {
  let srv: TestServer;
  let sessionId: string;
  let codes: string[];

  beforeAll(async () => {
    srv = await startTestServer();
    const r = await setupSession(
      srv.url,
      { roundCount: 2, defaultRound: { quota: { propose: 2, decide: 2 } } },
      4,
      { minDelayMs: 5, maxDelayMs: 15 },
    );
    sessionId = r.sessionId;
    await r.fac.cmd("round:start");
    await r.fac.waitForDashboard((d) => d.state?.phase === "round_complete", 20_000);
    await r.fac.cmd("round:start");
    await r.fac.waitForDashboard((d) => d.state?.phase === "game_complete", 20_000);
    for (const b of r.bots) await b.flushTelemetry();
    codes = Object.values(srv.ctx.hub.session!.state.seats).map((s) => s.participantCode!);
    r.stop();
  }, 60_000);

  afterAll(async () => {
    await srv?.close();
    cleanup(srv.dir);
  });

  it("encrypts the database at rest (no plaintext codes, wrong passphrase refused)", () => {
    srv.ctx.db.pragma("wal_checkpoint(TRUNCATE)");
    const file = path.join(srv.runtime.dataDir, "wkwa.db");
    const raw = readFileSync(file);
    expect(raw.subarray(0, 15).toString()).not.toBe("SQLite format 3");
    for (const c of codes) expect(raw.includes(Buffer.from(c))).toBe(false);
    expect(raw.includes(Buffer.from("ProposalMade"))).toBe(false);
    expect(() => openDatabase(file, "wrong passphrase!!")).toThrow(WrongPassphraseError);
  });

  it("writes a standard export that matches the documented columns exactly", () => {
    const r = exportSession(
      { store: srv.ctx.store, scenarios: srv.ctx.scenarios, exportsDir: srv.runtime.exportsDir },
      sessionId,
    );
    const files = readdirSync(r.dir).sort();
    expect(files).toEqual(EXPORT_FILES.map((f) => f.file).sort());
    // this session recorded no audio: the audio files are there, header only
    for (const f of ["audio_tracks.csv", "speech_segments.csv"])
      expect(readFileSync(path.join(r.dir, f), "utf8").trimEnd().split("\n")).toHaveLength(1);
    for (const def of EXPORT_FILES.filter((f) => f.format === "csv")) {
      const text = readFileSync(path.join(r.dir, def.file), "utf8");
      const header = text.split("\n")[0]!.split(",");
      const expected = expandColumns(def).map((c) => c.name);
      expect(header.slice(0, expected.length)).toEqual(expected);
      if (!def.dynamicColumns) expect(header).toEqual(expected);
    }
    const actions = readCsv(r.dir, "actions.csv");
    expect(actions).toHaveLength(32); // 2 rounds × 4 seats × (2 + 2)
    expect(actions.every((a) => /^K[a-d]$/.test(a.k_label!) && /^P[a-d]$/.test(a.p_label!))).toBe(true);
    expect(actions.filter((a) => a.reaction_ms !== "").length).toBeGreaterThan(20);
    expect(actions.filter((a) => a.ms_since_prev_own_action === "").length).toBe(8); // first action per seat per round

    const events = readCsv(r.dir, "events.csv");
    for (const e of events.filter((x) => x.type === "DemographicsSubmitted")) {
      expect(JSON.parse(e.payload_json!)).toEqual({ redacted: true });
    }
    const demo = readCsv(r.dir, "demographics.csv");
    expect(demo).toHaveLength(4);
    expect(Object.keys(demo[0]!)).toContain("q_age_bracket");
    const consent = readCsv(r.dir, "consent.csv");
    expect(consent.every((c) => c.consented === "1" && c.answer_data_collection === "1")).toBe(true);

    const manifest = readManifest(r.dir);
    expect(manifest.codeHashes).toHaveLength(4);
    for (const f of manifest.files) expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(path.join(r.dir, "codebook.md"), "utf8")).toContain("actions.csv");
  });

  it("writes an anonymised export without any participant code", () => {
    const r = exportSession(
      { store: srv.ctx.store, scenarios: srv.ctx.scenarios, exportsDir: srv.runtime.exportsDir },
      sessionId,
      "anonymised",
    );
    expect(path.basename(r.dir)).toMatch(/^anon-E-/);
    const all = readAll(r.dir);
    expect(all).not.toMatch(/WK-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]/);
    const players = readCsv(r.dir, "players.csv");
    const ids = players.map((p) => p.participant_code!);
    expect(ids.every((id) => /^A-[0-9A-Z]{6}$/.test(id))).toBe(true);
    // ids are consistent across files of the same export
    const actions = readCsv(r.dir, "actions.csv");
    expect(new Set(actions.map((a) => a.participant_code))).toEqual(new Set(ids));
    expect(readManifest(r.dir).codeHashes).toEqual([]);
  });

  it("produces a key sheet in the app font and one takedown-card PDF per seat", async () => {
    const sheet = (await srv.api("GET", `/api/sessions/${sessionId}/print/keysheet`)).text;
    for (const c of codes) expect(sheet).toContain(c);
    expect(sheet).toContain("CONFIDENTIAL");
    expect(sheet).toContain('font-family: "JetBrains Mono"');
    expect(sheet).toContain("data:font/woff2;base64,"); // font embedded: works offline and from a blob: URL

    const list = (await srv.api("GET", `/api/sessions/${sessionId}/cards`)).json;
    expect(list.seats).toEqual([1, 2, 3, 4]);
    for (const seat of list.seats) {
      const res = await fetch(`${srv.url}/api/sessions/${sessionId}/cards/${seat}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/pdf");
      expect(res.headers.get("content-disposition")).toContain(`seat${seat}.pdf`);
      const pdf = Buffer.from(await res.arrayBuffer());
      expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
      expect(pdf.includes(Buffer.from("JetBrainsMono"))).toBe(true); // the app font is embedded
    }
    expect((await srv.api("GET", `/api/sessions/${sessionId}/cards/9`)).status).toBe(404);
  });

  it("erases a participant over REST after the typed confirmation (as typed), and records it", async () => {
    const code = codes[0]!;
    const sloppy = code.toLowerCase().replace(/-/g, " ");
    const before = new PersonalDataMap(srv.ctx.store).lookup(sloppy);
    expect(before.occurrences[0]!.events).toBeGreaterThan(5);
    expect(before.occurrences[0]!.telemetry).toBeGreaterThan(0);
    expect(before.exports.length).toBe(2); // standard + anonymised from the tests above
    const lastSeqBefore = srv.ctx.store.listEvents(sessionId).at(-1)!.seq;

    const url = `/api/participants/${code}/erase`;
    expect((await srv.api("POST", url, { confirm: codes[1] })).status).toBe(400); // another code
    const res = await srv.api("POST", url, { confirm: sloppy, note: "test request" });
    expect(res.status).toBe(200);
    expect(res.json.erased).toBe(true);
    expect(res.json.exports).toHaveLength(2);

    const events = srv.ctx.store.listEvents(sessionId);
    const marker = events.at(-1)!;
    expect(marker).toMatchObject({
      type: "ParticipantWithdrawn",
      participantCode: null,
      payload: { by: "erasure" },
    });
    expect(marker.seq).toBeGreaterThan(lastSeqBefore); // seq numbers are never reused
    expect(JSON.stringify(events)).not.toContain(code);
    expect(new PersonalDataMap(srv.ctx.store).erasures()).toMatchObject([{ note: "test request" }]);

    // the reloaded session shows the seat as withdrawn, the other three untouched
    const st = srv.ctx.hub.session!.state;
    const seat = before.occurrences[0]!.seat!;
    expect(st.seats[seat]!.withdrawn).toBe(true);
    expect(st.seats[seat]!.participantCode).toBeNull();
    expect(Object.values(st.seats).filter((s) => s.participantCode).length).toBe(3);

    // a fresh export no longer contains the participant
    const r = exportSession(
      { store: srv.ctx.store, scenarios: srv.ctx.scenarios, exportsDir: srv.runtime.exportsDir },
      sessionId,
    );
    expect(readAll(r.dir)).not.toContain(code);
    const players = readCsv(r.dir, "players.csv");
    expect(players.find((p) => p.seat === String(seat))).toMatchObject({
      participant_code: "",
      withdrawn: "1",
    });
  });

  it("writes encrypted backups and supports changing the passphrase", async () => {
    const out = path.join(srv.dir, "backup", "wkwa-backup.db");
    await backupDatabase(srv.ctx.db, out);
    const raw = readFileSync(out);
    expect(raw.subarray(0, 15).toString()).not.toBe("SQLite format 3");
    for (const c of codes.slice(1)) expect(raw.includes(Buffer.from(c))).toBe(false);
    expect(() => openDatabase(out, "not the passphrase")).toThrow(WrongPassphraseError);
    const copy = openDatabase(out, PASSPHRASE);
    expect(new Store(copy).listSessions()).toHaveLength(1);
    rekeyDatabase(copy, "a brand new passphrase");
    copy.close();
    expect(() => openDatabase(out, PASSPHRASE)).toThrow(WrongPassphraseError);
    const reopened = openDatabase(out, "a brand new passphrase");
    expect(new Store(reopened).listEvents(sessionId).length).toBeGreaterThan(10);
    reopened.close();
  });
});

describe("public repository safety", () => {
  it("git-ignores every location research data can end up in", () => {
    if (!existsSync(path.join(REPO_ROOT, ".git"))) return;
    const paths = [
      "data/wkwa.db",
      "data/logs/server.log",
      "exports/S-20261116-AAAA/E-1/actions.csv",
      "backup.db",
      "wkwa.db-wal",
      "some/where/players.csv",
      ".env",
      // audio: encrypted recordings, backup copies of the audio folder, decrypted or exported sound
      "data/audio/S-20261116-AAAA/0123456789abcdef0123456789abcdef.wka",
      "backups/wkwa.db.audio/S-20261116-AAAA/0123456789abcdef0123456789abcdef.wka",
      "seat1.wav",
      "some/where/recording.webm",
      "clip.ogg",
      "clip.opus",
      "clip.flac",
    ];
    const out = execFileSync("git", ["check-ignore", ...paths], { cwd: REPO_ROOT })
      .toString()
      .trim()
      .split("\n");
    expect(out.sort()).toEqual([...paths].sort());
  });
});

describe("deleting a whole session", () => {
  let srv: TestServer;
  beforeAll(async () => {
    srv = await startTestServer();
  });
  afterAll(async () => {
    await srv.close();
    cleanup(srv.dir);
  });

  it("requires the typed session id, refuses a running session, then removes everything", async () => {
    const r = await setupSession(
      srv.url,
      { roundCount: 1, defaultRound: { quota: { propose: 1, decide: 1 } } },
      4,
      { minDelayMs: 5, maxDelayMs: 15 },
    );
    const id = r.sessionId;
    const post = (body: unknown) => srv.api("POST", `/api/sessions/${id}/delete`, body);
    expect((await post({ confirm: "S-WRONG" })).status).toBe(400);
    expect((await post({ confirm: id })).status).toBe(409); // still running
    await r.fac.cmd("round:start");
    await r.fac.waitForDashboard((d) => d.state?.phase === "game_complete", 20_000);
    for (const b of r.bots) await b.flushTelemetry();
    exportSession(
      { store: srv.ctx.store, scenarios: srv.ctx.scenarios, exportsDir: srv.runtime.exportsDir },
      id,
    );
    const exportDir = path.join(srv.runtime.exportsDir, id);
    expect(existsSync(exportDir)).toBe(true);

    const res = await post({ confirm: id, deleteExports: true });
    expect(res.status).toBe(200);
    const body = res.json;
    expect(body.rows.events).toBeGreaterThan(20);
    expect(body.rows.telemetry).toBeGreaterThan(0);
    expect(body.exportsDeleted).toBe(true);
    expect(existsSync(exportDir)).toBe(false);

    const db = srv.ctx.db;
    for (const t of ["events", "telemetry", "exports"]) {
      expect(db.prepare(`SELECT count(*) AS n FROM ${t} WHERE session_id = ?`).get(id)).toEqual({ n: 0 });
    }
    expect(srv.ctx.store.getSession(id)).toBeUndefined();
    expect(srv.ctx.hub.session).toBeNull(); // detached
    expect((await srv.api("GET", "/api/session-deletions")).json).toMatchObject([
      { sessionId: id, participants: 4 },
    ]);
    r.stop();
  });
});
