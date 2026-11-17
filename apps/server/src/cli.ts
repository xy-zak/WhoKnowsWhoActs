/**
 * Data-management command line.  npm run cli -- <command> [options]
 *
 *   sessions                         list sessions
 *   lookup   --code C                where does a participant code occur?
 *   export   --session S             standard (pseudonymised) export
 *   anonymise --session S            anonymised export (codes → random ids, mapping discarded)
 *   erase    --code C [--yes] [--note TEXT]   erase all data of a participant
 *   erasures                         show the erasure register
 *   delete-session --session S [--yes] [--delete-exports] [--note TEXT]
 *                                    delete an ENTIRE session (irreversible)
 *   deletions                        show the session-deletion register
 *   backup   --out FILE              encrypted backup copy of the database
 *   rekey                            change the passphrase (of BOTH databases: they share one)
 *   verify                           integrity check of the database
 *
 * --sim runs sessions / export / anonymise / delete-session / deletions /
 * backup / verify on the simulation database (data/wkwa-sim.db) instead of
 * the participant database (data/wkwa.db). Participant look-up and erasure
 * only exist for the participant database.
 *
 * Every command asks for the database passphrase (WKWA_DB_PASSPHRASE is
 * accepted for scripted development use only).
 */
import { existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { parseArgs } from "node:util";
import { EVENT_DEFS, type EventType, TELEMETRY_DEFS, type TelemetryType } from "@wkwa/shared";
import { ScenarioLibrary } from "./content";
import { backupDatabase, getMeta, openDatabase, rekeyDatabase } from "./db/database";
import { Store } from "./db/store";
import { dbFile as dbFileOf, exportsDirFor } from "./db/stores";
import { deleteSession, listSessionDeletions } from "./gdpr/deleteSession";
import { eraseParticipant, listErasures, lookupParticipant } from "./gdpr/erase";
import { exportSession } from "./gdpr/exporter";
import { obtainPassphrase, promptHidden } from "./passphrase";
import { runtimeFromEnv } from "./runtime";

const USAGE = `Usage: npm run cli -- <sessions|lookup|export|anonymise|erase|erasures|delete-session|deletions|backup|rekey|verify> [options]
  lookup --code C          export --session S       anonymise --session S
  erase --code C [--yes] [--note TEXT]               backup --out FILE
  delete-session --session S [--yes] [--delete-exports] [--note TEXT]
  --sim   use the simulation database (data/wkwa-sim.db) instead of the participant database`;

/** Commands that only make sense for participants (and so not with --sim). */
const PARTICIPANT_ONLY = new Set(["lookup", "erase", "erasures"]);

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  return a === "y" || a === "yes";
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      code: { type: "string" },
      session: { type: "string" },
      out: { type: "string" },
      note: { type: "string", default: "" },
      yes: { type: "boolean", default: false },
      "delete-exports": { type: "boolean", default: false },
      sim: { type: "boolean", default: false },
    },
  });
  if (!command || command === "help" || command === "--help") {
    console.log(USAGE);
    return;
  }
  const mode = values.sim ? "simulated" : "real";
  if (values.sim && PARTICIPANT_ONLY.has(command)) {
    throw new Error(
      `'${command}' is about participants and only works on the participant database (drop --sim).`,
    );
  }
  const runtime = runtimeFromEnv();
  const dbFile = dbFileOf(runtime.dataDir, mode);
  if (!existsSync(dbFile))
    throw new Error(
      `No database at ${dbFile} (set WKWA_DATA_DIR?${values.sim ? " The server creates the simulation database on its first start." : ""})`,
    );
  const passphrase = await obtainPassphrase(dbFile);
  const db = openDatabase(dbFile, passphrase);
  const exportsDir = exportsDirFor(runtime.exportsDir, mode);
  console.log(`Database: ${dbFile} (${values.sim ? "simulations" : "participants"})`);
  const store = new Store(db);
  const scenarios = new ScenarioLibrary(runtime.scenariosDir);
  const need = (v: string | undefined, flag: string) => {
    if (!v) throw new Error(`Missing --${flag}\n${USAGE}`);
    return v;
  };

  try {
    switch (command) {
      case "sessions": {
        const rows = store.listSessions();
        if (rows.length === 0) console.log("No sessions.");
        for (const s of rows) {
          console.log(
            `${s.id}  ${s.status.padEnd(14)} ${s.createdWall.slice(0, 16)}  scenario=${s.scenarioId} v${s.scenarioVersion}  events=${s.eventCount} telemetry=${s.telemetryCount}${s.tags.length ? `  tags=${s.tags.join(",")}` : ""}${s.fakeSeats.length ? `  FAKE PLAYERS in seat ${s.fakeSeats.join(",")}` : ""}`,
          );
        }
        break;
      }
      case "lookup": {
        const r = lookupParticipant(store, need(values.code, "code"));
        console.log(`Participant ${r.code}`);
        if (r.occurrences.length === 0) console.log("  no data found");
        for (const o of r.occurrences)
          console.log(`  ${o.sessionId}  seat ${o.seat ?? "?"}  events=${o.events} telemetry=${o.telemetry}`);
        for (const e of r.exports) console.log(`  contained in export ${e.id} (${e.kind}) → ${e.path}`);
        for (const p of r.previouslyErased) console.log(`  previously erased on ${p.executedWall}`);
        break;
      }
      case "export":
      case "anonymise": {
        const kind = command === "export" ? "standard" : "anonymised";
        const r = exportSession({ store, scenarios, exportsDir }, need(values.session, "session"), kind);
        console.log(`${kind} export ${r.exportId} written to ${r.dir}`);
        for (const f of r.files) console.log(`  ${f.name.padEnd(18)} ${String(f.rows).padStart(7)} rows`);
        if (kind === "standard" && !values.sim)
          console.log("Contains pseudonymised personal data: store on institutional storage only.");
        break;
      }
      case "erase": {
        const look = lookupParticipant(store, need(values.code, "code"));
        console.log(`Participant ${look.code}`);
        if (look.occurrences.length === 0) {
          console.log("No data found for this code — nothing to erase.");
          if (look.previouslyErased.length)
            console.log(
              `(It was erased before, on ${look.previouslyErased.map((p) => p.executedWall).join(", ")}.)`,
            );
          break;
        }
        for (const o of look.occurrences)
          console.log(`  ${o.sessionId}  seat ${o.seat ?? "?"}  events=${o.events} telemetry=${o.telemetry}`);
        console.log(
          "If the server is running with one of these sessions attached, use the dashboard instead.",
        );
        if (!values.yes && !(await confirm("Permanently erase all of this participant's data?"))) {
          console.log("Cancelled.");
          break;
        }
        const r = eraseParticipant(store, look.code, values.note);
        console.log(
          `Erased ${r.rows.events} events and ${r.rows.telemetry} telemetry rows. Register entry added.`,
        );
        if (r.exports.length) {
          console.log("These exports contained the participant — delete them on every copy and re-export:");
          for (const e of r.exports) console.log(`  ${e.id} (${e.kind}) → ${e.path}`);
        }
        console.log(
          "Remember: cross out the line on the key sheet; backups made before now still contain the data.",
        );
        break;
      }
      case "erasures": {
        const rows = listErasures(store);
        if (rows.length === 0) console.log("Erasure register is empty.");
        for (const e of rows) {
          console.log(
            `#${e.id} ${e.executedWall}  sha256=${e.codeSha256.slice(0, 16)}…  sessions=${e.sessions.map((s) => s.sessionId).join(",")}  rows=${e.rows.events}+${e.rows.telemetry}${e.note ? `  note=${e.note}` : ""}`,
          );
        }
        break;
      }
      case "delete-session": {
        const id = need(values.session, "session");
        const row = store.getSession(id);
        if (!row) throw new Error(`Unknown session ${id}`);
        const counts = store.listSessions().find((x) => x.id === id)!;
        console.log(
          `Session ${id} (${row.status}, created ${row.created_wall.slice(0, 16)}): ${counts.eventCount} events, ${counts.telemetryCount} telemetry rows.`,
        );
        console.log(
          "If the server is running with this session attached, use the manager (DATABASE) instead.",
        );
        if (!values.yes) {
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          const typed = (await rl.question(`Type the session id (${id}) to delete it permanently: `)).trim();
          rl.close();
          if (typed !== id) {
            console.log("Cancelled.");
            break;
          }
        }
        const r = deleteSession(store, id, {
          exportsDir,
          deleteExports: values["delete-exports"],
          note: values.note,
        });
        console.log(
          `Deleted ${r.rows.events} events, ${r.rows.telemetry} telemetry rows, ${r.rows.exports} export register rows. Register entry added.`,
        );
        if (r.exportPaths.length) {
          console.log(
            r.exportsDeleted
              ? "Export folders deleted:"
              : "Export folders still on disk (delete them on every copy):",
          );
          for (const p of r.exportPaths) console.log(`  ${p}`);
        }
        console.log("Backups made before now still contain the session.");
        break;
      }
      case "deletions": {
        const rows = listSessionDeletions(store);
        if (rows.length === 0) console.log("Session-deletion register is empty.");
        for (const d of rows)
          console.log(
            `#${d.id} ${d.deletedWall}  ${d.sessionId}  participants=${d.participants}  rows=${d.rows.events}+${d.rows.telemetry}${d.note ? `  note=${d.note}` : ""}`,
          );
        break;
      }
      case "backup": {
        const out = path.resolve(need(values.out, "out"));
        if (existsSync(out)) throw new Error(`${out} already exists`);
        await backupDatabase(db, out);
        console.log(`Encrypted backup written to ${out} (same passphrase).`);
        break;
      }
      case "rekey": {
        const a = await promptHidden("New passphrase: ");
        if (a.length < 10) throw new Error("Use at least 10 characters.");
        const b = await promptHidden("Repeat new passphrase: ");
        if (a !== b) throw new Error("Passphrases do not match.");
        rekeyDatabase(db, a);
        console.log(`Passphrase of ${path.basename(dbFile)} changed.`);
        // both databases share one passphrase (the server opens them with it), so rekey the other one too
        const other = dbFileOf(runtime.dataDir, values.sim ? "real" : "simulated");
        if (existsSync(other)) {
          try {
            const odb = openDatabase(other, passphrase);
            rekeyDatabase(odb, a);
            odb.close();
            console.log(`Passphrase of ${path.basename(other)} changed too (both databases share it).`);
          } catch (e) {
            console.log(
              `⚠  Could not rekey ${path.basename(other)} with the old passphrase (${(e as Error).message}). ` +
                `Rekey it separately so the server can open both.`,
            );
            process.exitCode = 1;
          }
        }
        console.log("Existing backups keep their old passphrase.");
        break;
      }
      case "verify": {
        let problems = 0;
        const report = (m: string) => {
          problems++;
          console.log(`  ✗ ${m}`);
        };
        console.log(
          `Schema version ${getMeta(db, "schema_version")}, created ${getMeta(db, "created_wall")}`,
        );
        const check = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
        if (check[0]?.integrity_check !== "ok") report(`SQLite integrity_check: ${JSON.stringify(check)}`);
        for (const s of store.listSessions()) {
          const events = store.listEvents(s.id);
          let last = 0;
          for (const e of events) {
            if (e.seq <= last) report(`${s.id}: seq not increasing at ${e.seq}`);
            last = e.seq;
            const def = EVENT_DEFS[e.type as EventType];
            if (!def) report(`${s.id} #${e.seq}: unknown event type ${e.type}`);
            else if (!def.payload.safeParse(e.payload).success)
              report(`${s.id} #${e.seq}: invalid ${e.type} payload`);
            if (JSON.stringify(e.payload).match(/WK-[0-9A-Z]{4}-[0-9A-Z]{4}-/))
              report(`${s.id} #${e.seq}: participant code inside payload`);
            if (values.sim && e.participantCode)
              report(`${s.id} #${e.seq}: participant code in the simulation database`);
          }
          for (const t of store.listTelemetry(s.id)) {
            const def = TELEMETRY_DEFS[t.type as TelemetryType];
            if (!def?.payload.safeParse(t.payload).success)
              report(`${s.id} telemetry #${t.id}: invalid ${t.type}`);
          }
          console.log(`  ${s.id}: ${events.length} events checked`);
        }
        console.log(problems === 0 ? "✓ Database OK" : `${problems} problem(s) found`);
        if (problems) process.exitCode = 1;
        break;
      }
      default:
        console.log(`Unknown command '${command}'.\n${USAGE}`);
        process.exitCode = 1;
    }
  } finally {
    db.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
