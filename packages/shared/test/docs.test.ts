/// <reference types="node" />
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALL_BLOCKS } from "../../../scripts/docBlocks";
import {
  AUDIO_START_REASONS,
  AUDIO_STOP_REASONS,
  applyGeneratedBlocks,
  EVENT_DEFS,
  EVENT_TYPES,
  EXPORT_FILES,
  INTERRUPTED_STOP_REASONS,
  MESSAGES,
  renderCodebook,
  TELEMETRY_DEFS,
  TELEMETRY_TYPES,
} from "../src";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const docsDir = `${root}docs/`;

function docFiles(): string[] {
  const files = readdirSync(docsDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => docsDir + f);
  if (existsSync(`${root}README.md`)) files.push(`${root}README.md`);
  return files;
}

const read = (name: string) => readFileSync(docsDir + name, "utf8");

describe("generated documentation", () => {
  it("is up to date with the schemas (run `npm run docs:generate` if this fails)", () => {
    const stale: string[] = [];
    for (const file of docFiles()) {
      const content = readFileSync(file, "utf8");
      const result = applyGeneratedBlocks(content, ALL_BLOCKS);
      expect(result.unknown, `unknown generated blocks in ${file}`).toEqual([]);
      if (result.content !== content) stale.push(file);
    }
    expect(stale).toEqual([]);
  });

  it("uses every generated block somewhere", () => {
    const all = docFiles()
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    for (const name of Object.keys(ALL_BLOCKS)) {
      expect(all, `block ${name} not used`).toContain(`<!-- BEGIN GENERATED: ${name} -->`);
    }
  });

  it("documents every event and telemetry type in DATA-TYPES.md", () => {
    const doc = read("DATA-TYPES.md");
    for (const t of [...EVENT_TYPES, ...TELEMETRY_TYPES]) {
      expect(doc, `missing section for ${t}`).toContain(`### \`${t}\``);
    }
  });

  it("documents every socket message in NETWORKING.md", () => {
    const doc = read("NETWORKING.md");
    const names = Object.values(MESSAGES).flatMap((dirs) => Object.values(dirs).flatMap(Object.keys));
    for (const name of names) expect(doc, `missing message ${name}`).toContain(`\`${name}\``);
  });

  it("documents every export file in DATA-TYPES.md", () => {
    const doc = read("DATA-TYPES.md");
    for (const f of EXPORT_FILES) expect(doc).toContain(`#### \`${f.file}\``);
  });
});

describe("record metadata", () => {
  it("every event example matches its payload schema", () => {
    for (const t of EVENT_TYPES) {
      const def = EVENT_DEFS[t];
      const r = def.payload.safeParse(def.example);
      expect(r.success, `${t}: ${r.success ? "" : r.error.message}`).toBe(true);
    }
  });

  it("every telemetry example matches its payload schema", () => {
    for (const t of TELEMETRY_TYPES) {
      const def = TELEMETRY_DEFS[t];
      const r = def.payload.safeParse(def.example);
      expect(r.success, `${t}: ${r.success ? "" : r.error.message}`).toBe(true);
    }
  });

  it("no payload schema has a field named like a participant code", () => {
    for (const t of [...EVENT_TYPES, ...TELEMETRY_TYPES]) {
      const def =
        (EVENT_DEFS as Record<string, { example: unknown }>)[t] ??
        (TELEMETRY_DEFS as Record<string, { example: unknown }>)[t]!;
      expect(JSON.stringify(def.example)).not.toMatch(/participantCode|participant_code|WK-[0-9A-Z]{4}/);
    }
  });
});

describe("codebook", () => {
  it("expands config-dependent columns and covers every file", () => {
    const md = renderCodebook({
      sessionId: "S-20261116-TEST",
      exportId: "E1",
      kind: "standard",
      createdWall: "2026-11-16T10:00:00.000Z",
      consentItems: ["participate", "future_research"],
      demographicQuestions: ["age_bracket"],
    });
    expect(md).toContain("`answer_participate`");
    expect(md).toContain("`answer_future_research`");
    expect(md).toContain("`q_age_bracket`");
    for (const f of EXPORT_FILES) expect(md).toContain(`\`${f.file}\``);
    for (const t of EVENT_TYPES) expect(md).toContain(`### \`${t}\``);
  });
});

describe("audio_tracks.csv codebook", () => {
  const column = (name: string) => {
    const file = EXPORT_FILES.find((f) => f.file === "audio_tracks.csv");
    const col = file?.columns.find((c) => c.name === name);
    if (!col) throw new Error(`audio_tracks.csv has no ${name} column`);
    return col.description;
  };

  it("names every start and stop reason, and the stop reasons that make a track interrupted", () => {
    for (const r of AUDIO_START_REASONS) expect(column("start_reason")).toContain(`'${r}' = `);
    for (const r of AUDIO_STOP_REASONS) expect(column("stop_reason")).toContain(`'${r}' = `);
    for (const r of INTERRUPTED_STOP_REASONS) expect(column("status")).toContain(r);
  });
});
