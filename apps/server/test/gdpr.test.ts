import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { EXPORT_FILES, expandColumns, normaliseParticipantCode } from "@wkwa/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backupDatabase, openDatabase, rekeyDatabase, WrongPassphraseError } from "../src/db/database";
import { Store } from "../src/db/store";
import { eraseParticipant, listErasures, lookupParticipant } from "../src/gdpr/erase";
import { exportSession, readManifest } from "../src/gdpr/exporter";
import { REPO_ROOT } from "../src/runtime";
import { cleanup, PASSPHRASE, setupSession, startTestServer, type TestServer } from "./harness";

/** Minimal RFC 4180 CSV parser for assertions. */
function parseCsv(text: string): Array<Record<string, string>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head!.map((h, i) => [h, r[i] ?? ""])));
}

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
    for (const b of r.bots) b.stop();
    r.fac.close();
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
    for (const def of EXPORT_FILES.filter((f) => f.format === "csv")) {
      const text = readFileSync(path.join(r.dir, def.file), "utf8");
      const header = text.split("\n")[0]!.split(",");
      const expected = expandColumns(def).map((c) => c.name);
      expect(header.slice(0, expected.length)).toEqual(expected);
      if (!def.dynamicColumns) expect(header).toEqual(expected);
    }
    const actions = parseCsv(readFileSync(path.join(r.dir, "actions.csv"), "utf8"));
    expect(actions).toHaveLength(32); // 2 rounds × 4 seats × (2 + 2)
    expect(actions.every((a) => /^K[a-d]$/.test(a.k_label!) && /^P[a-d]$/.test(a.p_label!))).toBe(true);
    expect(actions.filter((a) => a.reaction_ms !== "").length).toBeGreaterThan(20);
    expect(actions.filter((a) => a.ms_since_prev_own_action === "").length).toBe(8); // first action per seat per round

    const events = parseCsv(readFileSync(path.join(r.dir, "events.csv"), "utf8"));
    for (const e of events.filter((x) => x.type === "DemographicsSubmitted")) {
      expect(JSON.parse(e.payload_json!)).toEqual({ redacted: true });
    }
    const demo = parseCsv(readFileSync(path.join(r.dir, "demographics.csv"), "utf8"));
    expect(demo).toHaveLength(4);
    expect(Object.keys(demo[0]!)).toContain("q_age_bracket");
    const consent = parseCsv(readFileSync(path.join(r.dir, "consent.csv"), "utf8"));
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
    const players = parseCsv(readFileSync(path.join(r.dir, "players.csv"), "utf8"));
    const ids = players.map((p) => p.participant_code!);
    expect(ids.every((id) => /^A-[0-9A-Z]{6}$/.test(id))).toBe(true);
    // ids are consistent across files of the same export
    const actions = parseCsv(readFileSync(path.join(r.dir, "actions.csv"), "utf8"));
    expect(new Set(actions.map((a) => a.participant_code))).toEqual(new Set(ids));
    expect(readManifest(r.dir).codeHashes).toEqual([]);
  });

  it("produces a key sheet in the app font and one takedown-card PDF per seat", async () => {
    const sheet = await (await fetch(`${srv.url}/api/sessions/${sessionId}/print/keysheet`)).text();
    for (const c of codes) expect(sheet).toContain(c);
    expect(sheet).toContain("CONFIDENTIAL");
    expect(sheet).toContain('font-family: "JetBrains Mono"');
    expect(sheet).toContain("data:font/woff2;base64,"); // font embedded: works offline and from a blob: URL

    const list = (await (await fetch(`${srv.url}/api/sessions/${sessionId}/cards`)).json()) as {
      seats: number[];
    };
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
    expect((await fetch(`${srv.url}/api/sessions/${sessionId}/cards/9`)).status).toBe(404);
  });

  it("refuses REST erasure without the typed confirmation", async () => {
    const res = await fetch(`${srv.url}/api/participants/${codes[0]}/erase`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: codes[1] }),
    });
    expect(res.status).toBe(400);
  });

  it("erases a participant completely and records it in the register", async () => {
    const code = codes[0]!;
    const sloppy = code.toLowerCase().replace(/-/g, " ");
    const before = lookupParticipant(srv.ctx.store, sloppy);
    expect(before.occurrences[0]!.events).toBeGreaterThan(5);
    expect(before.occurrences[0]!.telemetry).toBeGreaterThan(0);
    expect(before.exports.length).toBe(2); // standard + anonymised from the tests above
    const lastSeqBefore = srv.ctx.store.listEvents(sessionId).at(-1)!.seq;

    const res = await fetch(`${srv.url}/api/participants/${code}/erase`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: sloppy, note: "test request" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { erased: boolean; exports: unknown[] };
    expect(body.erased).toBe(true);
    expect(body.exports).toHaveLength(2);

    const db = srv.ctx.db;
    expect(db.prepare("SELECT count(*) AS n FROM events WHERE participant_code = ?").get(code)).toEqual({
      n: 0,
    });
    expect(db.prepare("SELECT count(*) AS n FROM telemetry WHERE participant_code = ?").get(code)).toEqual({
      n: 0,
    });
    const events = srv.ctx.store.listEvents(sessionId);
    const marker = events.at(-1)!;
    expect(marker).toMatchObject({
      type: "ParticipantWithdrawn",
      participantCode: null,
      payload: { by: "erasure" },
    });
    expect(marker.seq).toBeGreaterThan(lastSeqBefore); // seq numbers are never reused
    expect(JSON.stringify(events)).not.toContain(code);
    expect(listErasures(srv.ctx.store)).toHaveLength(1);
    expect(listErasures(srv.ctx.store)[0]!.note).toBe("test request");
    expect(lookupParticipant(srv.ctx.store, code).occurrences).toHaveLength(0);
    expect(lookupParticipant(srv.ctx.store, code).previouslyErased).toHaveLength(1);

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
    const players = parseCsv(readFileSync(path.join(r.dir, "players.csv"), "utf8"));
    expect(players.find((p) => p.seat === String(seat))).toMatchObject({
      participant_code: "",
      withdrawn: "1",
    });

    // erasing again is a no-op
    expect(eraseParticipant(srv.ctx.store, code).erased).toBe(false);
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
    ];
    const out = execFileSync("git", ["check-ignore", ...paths], { cwd: REPO_ROOT })
      .toString()
      .trim()
      .split("\n");
    expect(out.sort()).toEqual([...paths].sort());
  });

  it("normalises codes the way participants type them", () => {
    expect(normaliseParticipantCode("not a code")).toBeNull();
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
      {
        minDelayMs: 5,
        maxDelayMs: 15,
      },
    );
    const id = r.sessionId;
    const post = (body: unknown) =>
      fetch(`${srv.url}/api/sessions/${id}/delete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
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
    const body = (await res.json()) as {
      rows: { events: number; telemetry: number };
      exportsDeleted: boolean;
    };
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
    const reg = (await (await fetch(`${srv.url}/api/session-deletions`)).json()) as Array<{
      sessionId: string;
      participants: number;
    }>;
    expect(reg).toMatchObject([{ sessionId: id, participants: 4 }]);
    for (const b of r.bots) b.stop();
    r.fac.close();
  });
});
