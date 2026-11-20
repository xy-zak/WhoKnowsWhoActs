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
 *   delete-audio S --scope raw|all [--confirm S] [--note TEXT]
 *                                    delete a session's audio: raw = recordings (timing kept), all = everything
 *   audio-deletions                  show the audio-deletion register
 *   backup   --out FILE              encrypted backup copy of the database (+ FILE.audio/: the audio folder)
 *   rekey                            change the passphrase (of BOTH databases: they share one)
 *   verify                           integrity check of the database and of every audio file
 *
 * --sim runs sessions / export / anonymise / delete-session / deletions /
 * backup / verify on the simulation database (data/wkwa-sim.db) instead of
 * the participant database (data/wkwa.db). Participant look-up, erasure and
 * audio only exist for the participant database (simulations never record).
 *
 * Every command asks for the database passphrase (WKWA_DB_PASSPHRASE is
 * accepted for scripted development use only).
 */
import { existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { parseArgs } from "node:util";
import {
  type CodeOccurrence,
  EVENT_DEFS,
  type EventType,
  hasEnded,
  TELEMETRY_DEFS,
  type TelemetryType,
} from "@wkwa/shared";
import { AudioFileStore, audioDirOf } from "./audio/fileStore";
import { verifyAudio } from "./audio/verify";
import { ScenarioLibrary } from "./content";
import { backupDatabase, getMeta, openDatabase, rekeyDatabase } from "./db/database";
import { PersonalDataMap } from "./db/personalData";
import { Store } from "./db/store";
import { dbFile as dbFileOf, exportsDirFor } from "./db/stores";
import { exportSession } from "./gdpr/exporter";
import { MIN_PASSPHRASE_LENGTH, obtainPassphrase, promptHidden } from "./passphrase";
import { runtimeFromEnv } from "./runtime";

const USAGE = `Usage: npm run cli -- <sessions|lookup|export|anonymise|erase|erasures|delete-session|deletions|delete-audio|audio-deletions|backup|rekey|verify> [options]
  lookup --code C          export --session S       anonymise --session S
  erase --code C [--yes] [--note TEXT]               backup --out FILE
  delete-session --session S [--yes] [--delete-exports] [--note TEXT]
  delete-audio S --scope raw|all [--confirm S] [--note TEXT]
  --sim   use the simulation database (data/wkwa-sim.db) instead of the participant database`;

/** Commands that only make sense for participants (and so not with --sim). */
const PARTICIPANT_ONLY = new Set(["lookup", "erase", "erasures", "delete-audio", "audio-deletions"]);

const COMPACTION_FAILED =
  "the database could not be compacted (the rows are deleted, but their old pages may stay in the file until the next erasure or deletion compacts it): ";

/** 754000 → "12.6 min", 42000 → "42 s". */
function duration(ms: number): string {
  return ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : `${Math.round(ms / 1000)} s`;
}

async function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(question)).trim();
  rl.close();
  return a;
}

async function confirm(question: string): Promise<boolean> {
  const a = (await ask(`${question} [y/N] `)).toLowerCase();
  return a === "y" || a === "yes";
}

function printOccurrences(occurrences: CodeOccurrence[]) {
  for (const o of occurrences)
    console.log(
      `  ${o.sessionId}  seat ${o.seat ?? "?"}  events=${o.events} telemetry=${o.telemetry} audio=${o.audioTracks} tracks (${duration(o.audioMs)})`,
    );
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      code: { type: "string" },
      session: { type: "string" },
      out: { type: "string" },
      note: { type: "string", default: "" },
      yes: { type: "boolean", default: false },
      "delete-exports": { type: "boolean", default: false },
      sim: { type: "boolean", default: false },
      scope: { type: "string" },
      confirm: { type: "string" },
    },
  });
  if (!command || command === "help" || command === "--help") {
    console.log(USAGE);
    return;
  }
  // only delete-audio takes a positional argument (the session id); elsewhere a stray one is a typo
  if (positionals.length > (command === "delete-audio" ? 1 : 0))
    throw new Error(`Unexpected argument '${positionals.at(-1)}'\n${USAGE}`);
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
  // audio belongs to the participant database only (simulated sessions never record)
  const audioFiles = values.sim ? null : new AudioFileStore(audioDirOf(runtime.dataDir));
  const store = new Store(db, audioFiles);
  const personalData = new PersonalDataMap(store);
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
            `${s.id}  ${s.status.padEnd(14)} ${s.createdWall.slice(0, 16)}  scenario=${s.scenarioId} v${s.scenarioVersion}  events=${s.eventCount} telemetry=${s.telemetryCount}${s.audioTracks ? `  audio=${s.audioTracks} tracks (${duration(s.audioMs)})` : ""}${s.tags.length ? `  tags=${s.tags.join(",")}` : ""}${s.fakeSeats.length ? `  FAKE PLAYERS in seat ${s.fakeSeats.join(",")}` : ""}`,
          );
        }
        break;
      }
      case "lookup": {
        const r = personalData.lookup(need(values.code, "code"));
        console.log(`Participant ${r.code}`);
        if (r.occurrences.length === 0) console.log("  no data found");
        printOccurrences(r.occurrences);
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
        const look = personalData.lookup(need(values.code, "code"));
        console.log(`Participant ${look.code}`);
        if (look.occurrences.length === 0) {
          console.log("No data found for this code — nothing to erase.");
          if (look.previouslyErased.length)
            console.log(
              `(It was erased before, on ${look.previouslyErased.map((p) => p.executedWall).join(", ")}.)`,
            );
          break;
        }
        printOccurrences(look.occurrences);
        console.log(
          "If the server is running with one of these sessions attached, use the dashboard instead.",
        );
        if (
          !values.yes &&
          !(await confirm("Permanently erase all of this participant's data, audio included?"))
        ) {
          console.log("Cancelled.");
          break;
        }
        const r = personalData.erase(look.code, values.note);
        console.log(
          `Erased ${r.rows.events} events and ${r.rows.telemetry} telemetry rows. Register entry added.`,
        );
        console.log(
          `Audio: ${r.rows.audioTracks} tracks (${r.rows.audioChunks} chunks) and ${r.rows.audioDerivatives} derived results deleted with their keys; ${r.audioFiles.removed} encrypted files removed.`,
        );
        if (r.rows.audioDerivatives)
          console.log(
            "Results computed from their audio are gone too: re-run the speaker attribution if needed.",
          );
        for (const f of r.audioFiles.failed)
          console.log(
            `  ⚠  could not remove audio file ${f} (unreadable without its key): delete it by hand`,
          );
        if (r.audioFiles.compactionError)
          console.log(`  ⚠  ${COMPACTION_FAILED}${r.audioFiles.compactionError}`);
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
        const rows = personalData.erasures();
        if (rows.length === 0) console.log("Erasure register is empty.");
        for (const e of rows) {
          console.log(
            `#${e.id} ${e.executedWall}  sha256=${e.codeSha256.slice(0, 16)}…  sessions=${e.sessions.map((s) => s.sessionId).join(",")}  rows=${e.rows.events}+${e.rows.telemetry}  audio tracks=${e.rows.audioTracks} files=${e.rows.audioFiles}${e.note ? `  note=${e.note}` : ""}`,
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
          `Session ${id} (${row.status}, created ${row.created_wall.slice(0, 16)}): ${counts.eventCount} events, ${counts.telemetryCount} telemetry rows, ${counts.audioTracks} audio tracks (${duration(counts.audioMs)}).`,
        );
        console.log(
          "If the server is running with this session attached, use the manager (DATABASE) instead.",
        );
        if (!values.yes) {
          const typed = await ask(`Type the session id (${id}) to delete it permanently: `);
          if (typed !== id) {
            console.log("Cancelled.");
            break;
          }
        }
        const r = personalData.deleteSession(id, {
          exportsDir,
          deleteExports: values["delete-exports"],
          note: values.note,
        });
        console.log(
          `Deleted ${r.rows.events} events, ${r.rows.telemetry} telemetry rows, ${r.rows.exports} export register rows. Register entry added.`,
        );
        console.log(
          `Audio: ${r.rows.audioTracks} tracks, ${r.rows.audioChunks} chunks, ${r.rows.audioDerivatives} derived results and ${r.rows.audioJobs} jobs deleted; ` +
            (r.audio.dirRemoved
              ? `audio folder removed (${r.audio.files} files).`
              : "no audio folder on disk."),
        );
        if (r.audio.error)
          console.log(
            `  ⚠  could not remove the audio folder (${r.audio.error}); its files are unreadable without their keys.`,
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
        const rows = personalData.sessionDeletions();
        if (rows.length === 0) console.log("Session-deletion register is empty.");
        for (const d of rows)
          console.log(
            `#${d.id} ${d.deletedWall}  ${d.sessionId}  participants=${d.participants}  rows=${d.rows.events}+${d.rows.telemetry}  audio tracks=${d.rows.audioTracks}${d.note ? `  note=${d.note}` : ""}`,
          );
        break;
      }
      case "delete-audio": {
        const id = positionals[0] ?? need(values.session, "session");
        const scope = values.scope;
        if (scope !== "raw" && scope !== "all")
          throw new Error(`Missing or unknown --scope (raw or all)\n${USAGE}`);
        const row = store.getSession(id);
        if (!row) throw new Error(`Unknown session ${id}`);
        const tracks = store.listAudioTracks(id);
        const stored = tracks.filter((t) => t.status !== "deleted");
        const derived = store.listAudioDerivatives(id);
        console.log(
          `Session ${id} (${row.status}): ${stored.length} tracks with audio (${duration(stored.reduce((n, t) => n + t.durationMs, 0))}), ` +
            `${tracks.length - stored.length} with raw audio already deleted, ${derived.length} derived results.`,
        );
        console.log(
          scope === "raw"
            ? "Deletes the raw recordings and the cleaned/aligned tracks (files and keys). Track timing, chunk levels, speech segments and transcripts stay."
            : "Deletes ALL audio of this session: tracks, chunks, derived results, jobs and the audio folder.",
        );
        // A warning, not the server's refusal: the CLI sees only the database, not the hub's attached
        // session or its jobs and exports (SessionGuard refuses those in the server). The session
        // row's status is its phase, so "ended" is the same predicate the guard uses.
        if (!hasEnded(row.status) || stored.some((t) => t.status === "recording"))
          console.log(
            `⚠  The session is '${row.status}'${stored.some((t) => t.status === "recording") ? " and has tracks still marked recording" : ""}. ` +
              "If the server is running with this session attached, end the session (or stop the server) first.",
          );
        let typed = values.confirm;
        if (typed === undefined) {
          typed = await ask(`Type the session id (${id}) to delete its audio permanently: `);
        }
        if (typed.trim() !== id) {
          console.log("Confirmation does not match the session id. Cancelled.");
          process.exitCode = 1;
          break;
        }
        const r = personalData.deleteAudio(id, { scope, note: values.note });
        console.log(
          `Deleted (${scope}): ${r.counts.tracks} tracks (${duration(r.counts.audioMs)}), ${r.counts.chunks} chunk rows, ` +
            `${r.counts.derivatives} derived results, ${r.counts.jobs} jobs; ${r.audioFiles.removed} encrypted files removed` +
            `${r.audioFiles.dirRemoved ? ", audio folder removed" : ""}. Register entry #${r.entry.id} added.`,
        );
        for (const f of r.audioFiles.failed)
          console.log(`  ⚠  could not remove ${f} (unreadable without its key): delete it by hand`);
        if (r.audioFiles.compactionError)
          console.log(`  ⚠  ${COMPACTION_FAILED}${r.audioFiles.compactionError}`);
        console.log("Backups made before now still contain the audio.");
        break;
      }
      case "audio-deletions": {
        const rows = store.listAudioDeletions();
        if (rows.length === 0) console.log("Audio-deletion register is empty.");
        for (const d of rows)
          console.log(
            `#${d.id} ${d.executedWall}  ${d.sessionId}  scope=${d.scope}  tracks=${d.counts.tracks ?? 0} files=${d.counts.files ?? 0}${d.note ? `  note=${d.note}` : ""}`,
          );
        break;
      }
      case "backup": {
        const out = path.resolve(need(values.out, "out"));
        const audioOut = `${out}.audio`;
        if (existsSync(out)) throw new Error(`${out} already exists`);
        if (audioFiles && existsSync(audioOut)) throw new Error(`${audioOut} already exists`);
        await backupDatabase(db, out);
        console.log(`Encrypted backup written to ${out} (same passphrase).`);
        if (audioFiles) {
          // after the database copy: every file the copy has a key for is complete (newer chunks may be extra)
          const a = audioFiles.copyTo(audioOut);
          console.log(
            a.files
              ? `Audio folder copied to ${audioOut} (${a.files} encrypted files, ${(a.bytes / 1e6).toFixed(1)} MB; keys are in the database copy).`
              : "No audio files to copy.",
          );
        }
        break;
      }
      case "rekey": {
        const a = await promptHidden("New passphrase: ");
        if (a.length < MIN_PASSPHRASE_LENGTH)
          throw new Error(`Use at least ${MIN_PASSPHRASE_LENGTH} characters.`);
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
        // Audio files need nothing: each has its own random key, stored as a row of this
        // database, so the keys were re-encrypted with it. (Backups keep the old passphrase.)
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
        if (audioFiles) {
          const a = await verifyAudio(store, audioFiles);
          for (const p of a.problems) report(`audio: ${p}`);
          for (const w of a.warnings) console.log(`  ⚠ audio: ${w}`);
          console.log(
            `  audio: ${a.filesChecked} encrypted files, ${a.records} records authenticated, ${a.orphans.length} orphan files`,
          );
        } else {
          const n = store.audioRowCount();
          if (n > 0) report(`${n} audio rows in the simulation database (simulations never record audio)`);
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
