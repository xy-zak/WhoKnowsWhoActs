/**
 * Versioned documentation screenshots. The workflow is in
 * .claude/skills/screenshot-app/SKILL.md (the /screenshot-app skill).
 *
 *   npm run screenshots -- plan [--since <rev>]     what changed since the last review, and which shots it touches
 *   npm run screenshots -- capture <id…>            take shots into .screenshots/ and compare them with the published ones
 *                                                   (ids, group:<group>, or all)
 *   npm run screenshots -- publish <id> --caption "<one line>"
 *                                                   file the staged shot as its next version (v1: <name>.png, then <name>-v2.png …)
 *   npm run screenshots -- publish <id> --replace [--caption "…"]
 *                                                   overwrite the latest version (only to fix a bad capture)
 *   npm run screenshots -- gallery [--check]        regenerate docs/img/SCREENSHOTS.md
 *   npm run screenshots -- check                    catalogue, versions, files and gallery agree
 *   npm run screenshots -- mark [<rev>]             record that changes up to <rev> (default HEAD) are reviewed
 *   npm run screenshots -- list                     every shot with its versions
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  allGroups,
  allShots,
  GLOBAL_SOURCES,
  matchesAny,
  REPRESENTATIVE,
  type ShotDef,
  shotById,
  sourcesOf,
  UI_PATHS,
} from "../e2e/screenshots/catalogue";
import {
  fileFor,
  GALLERY_FILE,
  IMG_DIR,
  latest,
  MANIFEST_FILE,
  type Manifest,
  ROOT,
  readManifest,
  renderGallery,
  STAGING_DIR,
  writeManifest,
} from "../e2e/screenshots/manifest";

const [cmd = "help", ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};
const has = (name: string) => rest.includes(name);
/** Positional arguments (flags and their values removed). */
const positional = () => {
  const out: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--caption" || rest[i] === "--since") i++;
    else if (!rest[i]!.startsWith("--")) out.push(rest[i]!);
  }
  return out;
};

const git = (...args: string[]) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
const rel = (p: string) => path.relative(process.cwd(), p) || ".";
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
/** Content hash of a working-tree file (as git would store it); "" if it is gone. */
const blobHash = (f: string) => (existsSync(path.join(ROOT, f)) ? git("hash-object", "--", f) : "");
const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

/** "server/x", "group:setup", "all" → shot ids (validated). */
function resolveIds(args: string[]): string[] {
  const ids: string[] = [];
  for (const a of args) {
    if (a === "all") ids.push(...allShots.map((s) => s.id));
    else if (a.startsWith("group:")) {
      const g = a.slice(6);
      if (!allGroups.some((x) => x.id === g))
        fail(`unknown group "${g}" (groups: ${allGroups.map((x) => x.id).join(", ")})`);
      ids.push(...allShots.filter((s) => s.group === g).map((s) => s.id));
    } else {
      const id = a.replace(/\.png$/, "").replace(/^docs\/img\//, "");
      if (!shotById(id))
        fail(`unknown shot "${id}": see \`npm run screenshots -- list\`, or add it to the catalogue`);
      ids.push(id);
    }
  }
  return [...new Set(ids)];
}

/* ─────────────────────────── plan ─────────────────────────── */

function plan() {
  const m = readManifest();
  const since = flag("--since") ?? m.reviewedUpTo;
  if (!since) fail("no review marker: run `npm run screenshots -- mark <rev>` or pass --since <rev>");
  console.log(`Reviewed up to: ${since}  (HEAD ${git("rev-parse", "--short", "HEAD")})\n`);

  const log = git("log", "--format=%h %ad %s", "--date=short", `${since}..HEAD`);
  console.log(log ? `Commits since then:\n${indent(log)}\n` : "No commits since then.\n");

  const changed = new Set(
    [
      ...git("diff", "--name-only", since).split("\n"),
      ...git("ls-files", "--others", "--exclude-standard").split("\n"),
    ].filter(Boolean),
  );
  const reviewedSame = (f: string) => m.reviewed?.[f] !== undefined && m.reviewed[f] === blobHash(f);
  const ui = [...changed].filter((f) => matchesAny(f, UI_PATHS) && !reviewedSame(f)).sort();
  const dirty = ui.length > 0 && git("status", "--porcelain", "--", ...ui).trim() !== "";
  console.log(
    `Changed files that can show in the UI: ${ui.length}${dirty ? " (some not committed yet)" : ""}${
      ui.length ? `\n${indent(ui.join("\n"))}` : ""
    }\n`,
  );

  // When did each file last change: its mtime if uncommitted, else its last commit since the marker.
  const changedAt = (f: string): number => {
    const abs = path.join(ROOT, f);
    if (git("status", "--porcelain", "--", f) !== "")
      return existsSync(abs) ? statSync(abs).mtimeMs : Date.now();
    const iso = git("log", "-1", "--format=%cI", `${since}..HEAD`, "--", f);
    return iso ? Date.parse(iso) : Date.now();
  };
  // A shot captured after a change already shows it.
  const stale = (id: string, f: string) => {
    const v = latest(m, id);
    return !v?.at || Date.parse(v.at) < changedAt(f);
  };

  const hits = new Map<ShotDef, string[]>();
  const global: string[] = [];
  const unmapped: string[] = [];
  let upToDate = 0;
  for (const f of ui) {
    if (matchesAny(f, GLOBAL_SOURCES)) {
      global.push(f);
      continue;
    }
    const shots = allShots.filter((s) => matchesAny(f, sourcesOf(s)));
    if (shots.length === 0) unmapped.push(f);
    for (const s of shots) {
      if (stale(s.id, f)) hits.set(s, [...(hits.get(s) ?? []), f]);
      else upToDate++;
    }
  }
  if (upToDate)
    console.log(`(${upToDate} shot/file pair(s) skipped: the shot was captured after the change)\n`);

  if (hits.size) {
    console.log(`Shots these changes can touch: ${hits.size}`);
    for (const [s, files] of hits) {
      const v = latest(m, s.id);
      console.log(
        `  ${s.id.padEnd(42)} ${s.group.padEnd(11)} ${v ? `v${v.v} ${v.date}` : "not published"}  ← ${files
          .map((f) => path.basename(f))
          .join(", ")}`,
      );
    }
    console.log();
  }
  const representative = REPRESENTATIVE.filter((id) => global.some((f) => stale(id, f)));
  if (representative.length) {
    console.log(`Shared UI files changed (theme, components, icons): ${global.join(", ")}`);
    console.log(
      `  They show on every screen: capture the representative shots and look:\n  ${representative.join(" ")}\n`,
    );
  }
  if (unmapped.length) {
    console.log("Changed UI files that no shot covers (a new feature needs a new shot, or add the file to a");
    console.log("group's or shot's `sources` in e2e/screenshots/catalogue.ts):");
    console.log(`${indent(unmapped.join("\n"))}\n`);
  }
  const ids = [...new Set([...[...hits.keys()].map((s) => s.id), ...representative])];
  console.log(
    ids.length
      ? `Next: npm run screenshots -- capture ${ids.join(" ")}`
      : "Nothing to capture. Record the review with: npm run screenshots -- mark",
  );
}

const indent = (s: string) =>
  s
    .split("\n")
    .map((l) => `  ${l}`)
    .join("\n");

/* ─────────────────────────── capture ─────────────────────────── */

interface Report {
  shots: Record<
    string,
    {
      staged: string;
      latest: { v: number; file: string; date: string } | null;
      compare: {
        sameSize: boolean;
        size: [number, number];
        previousSize: [number, number];
        changedPercent: number;
        box: number[] | null;
        diff: string | null;
      } | null;
    }
  >;
}

function capture() {
  const ids = resolveIds(positional());
  if (ids.length === 0) fail("name the shots to capture: ids, group:<group>, or all");
  rmSync(STAGING_DIR, { recursive: true, force: true });
  mkdirSync(STAGING_DIR, { recursive: true });
  console.log(`Capturing ${ids.length} shot(s) into ${rel(STAGING_DIR)}/ …`);
  const run = spawnSync(
    "npx",
    ["playwright", "test", "--project=screenshots", "--workers=1", "--reporter=line"],
    {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...process.env, WKWA_SHOTS: ids.join(","), WKWA_SHOTS_OUT: STAGING_DIR },
    },
  );
  const reportFile = path.join(STAGING_DIR, "report.json");
  const report: Report = existsSync(reportFile)
    ? JSON.parse(readFileSync(reportFile, "utf8"))
    : { shots: {} };
  console.log(
    "\nShot                                       staged → compared with the latest published version",
  );
  for (const id of ids) {
    const r = report.shots[id];
    if (!r) {
      console.log(
        `  ✗ ${id}: not captured (no shot()/crop() call for it in its scenario, or the run failed)`,
      );
      continue;
    }
    const c = r.compare;
    const vs = !r.latest
      ? "new shot (no published version yet) → would be v1"
      : !c
        ? `v${r.latest.v} file missing`
        : !c.sameSize
          ? `size changed ${c.previousSize.join("×")} → ${c.size.join("×")} (vs v${r.latest.v})`
          : c.changedPercent === 0
            ? `identical to v${r.latest.v}`
            : `${c.changedPercent}% of pixels differ from v${r.latest.v}, in box ${c.box?.join(",")} · diff: ${c.diff}`;
    console.log(`  ${id.padEnd(42)} ${r.staged}  ·  ${vs}${r.latest ? `  (latest: ${r.latest.file})` : ""}`);
  }
  const missing = ids.filter((id) => !report.shots[id]);
  if (run.status !== 0) fail(`Playwright exited with ${run.status}`);
  if (missing.length) fail(`${missing.length} shot(s) not captured`);
  console.log(
    '\nLook at each staged image (and the diff). Publish real changes with:\n  npm run screenshots -- publish <id> --caption "<what changed, one line>"',
  );
}

/* ─────────────────────────── publish ─────────────────────────── */

function commitStamp(): string {
  const head = git("rev-parse", "--short", "HEAD");
  const dirty = git("status", "--porcelain", "--", "apps", "packages", "config", "scenarios") !== "";
  return dirty ? `${head}+` : head;
}

function publish() {
  const [arg] = positional();
  if (!arg) fail('usage: publish <id> --caption "<one line>" [--replace]');
  const [id] = resolveIds([arg]);
  const staged = path.join(STAGING_DIR, `${id}.png`);
  if (!existsSync(staged)) fail(`${id} is not staged: run \`npm run screenshots -- capture ${id}\` first`);
  const caption = flag("--caption")?.trim();
  if (caption !== undefined) {
    if (/\n/.test(caption)) fail("the caption must be one line");
    if (caption.length > 140)
      console.warn(`! the caption is ${caption.length} characters; keep it to one short line`);
  }
  const m = readManifest();
  const versions = m.shots[id!] ?? [];
  if (has("--replace")) {
    const last = versions.at(-1);
    if (!last) fail(`${id} has no published version to replace`);
    copyFileSync(staged, path.join(IMG_DIR, last.file));
    last.date = today();
    last.at = nowIso();
    last.commit = commitStamp();
    if (caption) last.caption = caption;
    console.log(`✓ replaced ${id} v${last.v} → docs/img/${last.file}`);
  } else {
    if (!caption) fail('a new version needs --caption "<one line>"');
    const v = versions.length + 1;
    const file = fileFor(id!, v);
    if (existsSync(path.join(IMG_DIR, file)))
      fail(`docs/img/${file} already exists and is not in the manifest`);
    mkdirSync(path.dirname(path.join(IMG_DIR, file)), { recursive: true });
    copyFileSync(staged, path.join(IMG_DIR, file));
    versions.push({ v, file, date: today(), at: nowIso(), commit: commitStamp(), caption });
    m.shots[id!] = versions;
    console.log(`✓ published ${id} v${v} → docs/img/${file}`);
  }
  writeManifest(m);
  writeFileSync(GALLERY_FILE, renderGallery(m));
  console.log(`✓ gallery updated: ${rel(GALLERY_FILE)}`);
}

/* ─────────────────────────── gallery, check, mark, list ─────────────────────────── */

function gallery() {
  const text = renderGallery(readManifest());
  if (has("--check")) {
    if (!existsSync(GALLERY_FILE) || readFileSync(GALLERY_FILE, "utf8") !== text)
      fail(`${rel(GALLERY_FILE)} is out of date: run \`npm run screenshots -- gallery\``);
    console.log("✓ gallery up to date");
  } else {
    writeFileSync(GALLERY_FILE, text);
    console.log(`✓ wrote ${rel(GALLERY_FILE)}`);
  }
}

function problems(m: Manifest): string[] {
  const out: string[] = [];
  const ids = new Set<string>();
  for (const s of allShots) {
    if (ids.has(s.id)) out.push(`duplicate shot id ${s.id}`);
    ids.add(s.id);
    if (!allGroups.some((g) => g.id === s.group)) out.push(`${s.id}: unknown group "${s.group}"`);
    const versions = m.shots[s.id] ?? [];
    if (versions.length === 0) out.push(`${s.id}: catalogued but never published`);
    versions.forEach((v, i) => {
      if (v.v !== i + 1) out.push(`${s.id}: version ${i + 1} is numbered v${v.v}`);
      if (v.file !== fileFor(s.id, v.v)) out.push(`${s.id} v${v.v}: file should be ${fileFor(s.id, v.v)}`);
      if (!existsSync(path.join(IMG_DIR, v.file))) out.push(`${s.id} v${v.v}: docs/img/${v.file} is missing`);
      if (!v.caption || /\n/.test(v.caption)) out.push(`${s.id} v${v.v}: needs a one-line caption`);
    });
  }
  for (const id of Object.keys(m.shots))
    if (!ids.has(id)) out.push(`${id}: in the manifest but not in the catalogue`);
  const known = new Set(Object.values(m.shots).flatMap((vs) => vs.map((v) => v.file)));
  for (const side of ["server", "client"]) {
    const dir = path.join(IMG_DIR, side);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir))
      if (f.endsWith(".png") && !known.has(`${side}/${f}`))
        out.push(`docs/img/${side}/${f}: not in the manifest`);
  }
  if (!existsSync(GALLERY_FILE) || readFileSync(GALLERY_FILE, "utf8") !== renderGallery(m))
    out.push(`${rel(GALLERY_FILE)} is out of date (npm run screenshots -- gallery)`);
  return out;
}

function check() {
  const p = problems(readManifest());
  if (p.length) fail(`${p.length} problem(s):\n${indent(p.join("\n"))}`);
  const m = readManifest();
  const versions = Object.values(m.shots).reduce((n, vs) => n + vs.length, 0);
  console.log(`✓ ${allShots.length} shots, ${versions} published versions, gallery up to date`);
}

function mark() {
  const rev = positional()[0] ?? "HEAD";
  const m = readManifest();
  m.reviewedUpTo = git("rev-parse", "--short", rev);
  // uncommitted UI work reviewed now: remember its content, so it is not reviewed again once committed
  const dirty = [
    ...git("diff", "--name-only", m.reviewedUpTo).split("\n"),
    ...git("ls-files", "--others", "--exclude-standard").split("\n"),
  ].filter((f) => f && matchesAny(f, UI_PATHS) && existsSync(path.join(ROOT, f)));
  m.reviewed = Object.fromEntries([...new Set(dirty)].sort().map((f) => [f, blobHash(f)]));
  if (Object.keys(m.reviewed).length === 0) delete m.reviewed;
  writeManifest(m);
  console.log(
    `✓ reviewed up to ${m.reviewedUpTo}${dirty.length ? ` plus ${dirty.length} uncommitted file(s)` : ""} (${rel(MANIFEST_FILE)})`,
  );
}

function list() {
  const m = readManifest();
  for (const g of allGroups) {
    console.log(`${g.id} · ${g.title}`);
    for (const s of allShots.filter((x) => x.group === g.id)) {
      const vs = m.shots[s.id] ?? [];
      const last = vs.at(-1);
      console.log(
        `  ${s.id.padEnd(42)} ${(s.scenario ?? "session").padEnd(10)} ${
          last ? `v${last.v} ${last.date}` : "not published"
        }  ${s.title}`,
      );
    }
  }
}

const USAGE = `Versioned documentation screenshots (workflow: .claude/skills/screenshot-app/SKILL.md)

  npm run screenshots -- plan [--since <rev>]
  npm run screenshots -- capture <id | group:<group> | all>…
  npm run screenshots -- publish <id> --caption "<one line>" [--replace]
  npm run screenshots -- gallery [--check]
  npm run screenshots -- check
  npm run screenshots -- mark [<rev>]
  npm run screenshots -- list`;

const COMMANDS: Record<string, () => void> = { plan, capture, publish, gallery, check, mark, list };
const run = COMMANDS[cmd];
if (!run) {
  console.log(USAGE);
  process.exit(cmd === "help" ? 0 : 1);
}
run();
