import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { allGroups, allShots, type ShotDef, sideOf } from "./catalogue";

/**
 * The version history of every screenshot (docs/img/screenshots.json) and the
 * gallery generated from it (docs/img/SCREENSHOTS.md).
 *
 * Versioning: v1 of a shot is docs/img/<side>/<name>.png, later versions are
 * <name>-v2.png, <name>-v3.png, … A published version is never overwritten
 * (except by `publish --replace`, which fixes a bad capture of the latest one),
 * so the gallery shows every screen's development over time.
 */

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const IMG_DIR = path.join(ROOT, "docs/img");
export const MANIFEST_FILE = path.join(IMG_DIR, "screenshots.json");
export const GALLERY_FILE = path.join(IMG_DIR, "SCREENSHOTS.md");
/** Captures land here first (git-ignored); `publish` copies the chosen ones into docs/img. */
export const STAGING_DIR = path.join(ROOT, ".screenshots");

export interface Version {
  v: number;
  /** Relative to docs/img, e.g. "server/live-panel-timeline-v2.png". */
  file: string;
  /** Capture date, YYYY-MM-DD (shown in the gallery). */
  date: string;
  /** Capture time (ISO, UTC): `plan` skips changes older than the latest version. */
  at: string;
  /** Commit the capture was taken on (short hash); "+" = with uncommitted changes. */
  commit: string;
  /** One line under the image: what the screen shows (v1) or what changed (v2+). */
  caption: string;
}

export interface Manifest {
  /** Last commit whose changes were reviewed for screenshots (`npm run screenshots -- mark`). */
  reviewedUpTo: string | null;
  /**
   * UI files that were not committed yet when the review was marked, with their
   * content hash (git blob). `plan` skips them while their content is unchanged,
   * also after they are committed.
   */
  reviewed?: Record<string, string>;
  shots: Record<string, Version[]>;
}

export const fileFor = (id: string, v: number) => (v <= 1 ? `${id}.png` : `${id}-v${v}.png`);

export function readManifest(): Manifest {
  return JSON.parse(readFileSync(MANIFEST_FILE, "utf8")) as Manifest;
}

/** Writes the manifest with the shots in catalogue order (unknown ids last, so `check` can report them). */
export function writeManifest(m: Manifest): void {
  const order = allShots.map((s) => s.id as string);
  const ids = [
    ...order.filter((id) => m.shots[id]),
    ...Object.keys(m.shots).filter((id) => !order.includes(id)),
  ];
  const shots: Record<string, Version[]> = {};
  for (const id of ids) shots[id] = m.shots[id]!;
  const head = { reviewedUpTo: m.reviewedUpTo, ...(m.reviewed ? { reviewed: m.reviewed } : {}) };
  writeFileSync(MANIFEST_FILE, `${JSON.stringify({ ...head, shots }, null, 2)}\n`);
}

export const latest = (m: Manifest, id: string): Version | undefined => m.shots[id]?.at(-1);

/* ─────────────────────────── gallery ─────────────────────────── */

const WIDTH = { full: 700, half: 340, small: 320 } as const;
const SIDE_LABEL = { server: "Facilitator", client: "Player" } as const;
/** Versions shown side by side in one table row, at most. */
const PER_ROW = 3;

const esc = (text: string) => text.replace(/\|/g, "\\|");
const img = (alt: string, file: string, width: number, inTable: boolean) =>
  `![${alt}${inTable ? "\\|" : "|"}${width}](./${file})`;

interface Item {
  shot: ShotDef;
  label: string;
  version: Version;
}

function pairTable(items: Item[]): string[] {
  const rows = ["| | |", "| --- | --- |"];
  for (let i = 0; i < items.length; i += 2) {
    const pair = items.slice(i, i + 2);
    const imgs = pair.map((it) => img(it.label, it.version.file, it.shot.width ?? WIDTH[it.shot.size], true));
    const caps = pair.map((it) => `**${esc(it.label)}:** ${esc(it.version.caption)}`);
    if (pair.length === 1) {
      imgs.push("");
      caps.push("");
    }
    rows.push(`| ${imgs.join(" | ")} |`, `| ${caps.join(" | ")} |`);
  }
  return rows;
}

function single(it: Item): string[] {
  return [
    img(it.label, it.version.file, it.shot.width ?? WIDTH.full, false),
    "",
    `**${it.label}:** ${it.version.caption}`,
  ];
}

const versionLabel = (v: Version) => `v${v.v} · ${v.date}`;

/** Every version of one shot, oldest first: stacked for full-width shots, side by side otherwise. */
function history(shot: ShotDef, label: string, versions: Version[]): string[] {
  const out = [`**${label}** · ${versions.length} versions, oldest first`, ""];
  if (shot.size === "full") {
    for (const v of versions) {
      out.push(img(`${label} v${v.v}`, v.file, shot.width ?? WIDTH.full, false), "");
      out.push(`**${versionLabel(v)}:** ${v.caption}`, "");
    }
    return out;
  }
  for (let i = 0; i < versions.length; i += PER_ROW) {
    const row = versions.slice(i, i + PER_ROW);
    const n = Math.min(versions.length, PER_ROW);
    const width = Math.min(shot.width ?? WIDTH[shot.size], Math.floor(690 / n));
    const pad = (cells: string[]) => [...cells, ...Array(n - cells.length).fill("")];
    out.push(
      `| ${pad(row.map(versionLabel)).join(" | ")} |`,
      `| ${Array(n).fill("---").join(" | ")} |`,
      `| ${pad(row.map((v) => img(`${label} v${v.v}`, v.file, width, true))).join(" | ")} |`,
      `| ${pad(row.map((v) => esc(v.caption))).join(" | ")} |`,
      "",
    );
  }
  return out;
}

/** Newest first: every version after the first, and new shots, by date. */
function changes(m: Manifest): string[] {
  const rows: Array<{ date: string; v: number; screen: string; caption: string }> = [];
  const firsts = new Map<string, string[]>();
  for (const shot of allShots) {
    for (const v of m.shots[shot.id] ?? []) {
      if (v.v > 1) rows.push({ date: v.date, v: v.v, screen: shot.title, caption: v.caption });
      else firsts.set(v.date, [...(firsts.get(v.date) ?? []), shot.title]);
    }
  }
  for (const [date, titles] of firsts) {
    if (titles.length > 5)
      rows.push({ date, v: 1, screen: `${titles.length} screens`, caption: "First version." });
    else for (const t of titles) rows.push({ date, v: 1, screen: t, caption: "New screen." });
  }
  rows.sort((a, b) => b.date.localeCompare(a.date) || b.v - a.v);
  return [
    "## Timeline of changes",
    "",
    "Newest first: every new version of a screen, and when new screens were added.",
    "",
    "| Date | Screen | Version | What changed |",
    "| --- | --- | --- | --- |",
    ...rows.map((r) => `| ${r.date} | ${esc(r.screen)} | v${r.v} | ${esc(r.caption)} |`),
  ];
}

export function renderGallery(m: Manifest): string {
  const dates = Object.values(m.shots)
    .flat()
    .map((v) => v.date)
    .sort();
  const out: string[] = [
    "---",
    "title: Screenshots",
    "aliases:",
    "  - Screenshot gallery",
    "  - UI screenshots",
    "tags:",
    "  - screenshots",
    "  - ui",
    `updated: ${dates.at(-1) ?? ""}`,
    "---",
    "",
    "<!-- Generated by `npm run screenshots -- gallery` from e2e/screenshots/catalogue.ts and docs/img/screenshots.json. Do not edit by hand. -->",
    "",
    "# Screenshots",
    "",
    "> [!NOTE]",
    "> Every screen of *Who Knows, Who Acts?*, grouped by what it is for, in the order a session runs. Whole screens are full screen (1920 × 1080); images named `live-panel-…` or `part-…` are crops of one part. Files are in `server/` (the facilitator console on the server computer) and `client/` (the player screens on the client PCs). Everything shown is fictional: a temporary database, the demo grids and scripted players.",
    "",
    "> [!TIP]",
    "> When a screen changes, it gets a new version (`name-v2.png`, `name-v3.png`, …) shown next to the older ones, so the gallery is a visual timeline; *Timeline of changes* at the end lists them by date. Take new screenshots with the `/screenshot-app` skill or `npm run screenshots -- plan`, then `capture` and `publish`.",
    "",
    "---",
    "",
  ];
  let n = 0;
  for (const group of allGroups) {
    const shots = allShots.filter((s) => s.group === group.id && (m.shots[s.id]?.length ?? 0) > 0);
    if (shots.length === 0) continue;
    const mixed = new Set(shots.map((s) => sideOf(s.id))).size > 1;
    out.push(`## ${++n}. ${group.title}`, "", group.intro, "");
    let queue: Item[] = [];
    const flush = () => {
      if (queue.length) out.push(...pairTable(queue), "");
      queue = [];
    };
    let subgroup: string | undefined;
    for (const shot of shots) {
      if (shot.subgroup !== subgroup) {
        flush();
        subgroup = shot.subgroup;
        if (subgroup) out.push(`### ${subgroup}`, "");
      }
      const versions = m.shots[shot.id]!;
      const label = mixed ? `${SIDE_LABEL[sideOf(shot.id)]} · ${shot.title}` : shot.title;
      if (versions.length > 1) {
        flush();
        out.push(...history(shot, label, versions));
      } else if (shot.size === "full") {
        flush();
        out.push(...single({ shot, label, version: versions[0]! }), "");
      } else queue.push({ shot, label, version: versions[0]! });
    }
    flush();
    out.push("---", "");
  }
  out.push(...changes(m));
  return `${out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;
}
