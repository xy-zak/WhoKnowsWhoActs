/**
 * Regenerates the auto-generated blocks in docs/*.md (and README.md) from the
 * schemas in packages/shared.
 *
 *   npm run docs:generate   → rewrite files in place
 *   npm run docs:check      → exit 1 if any file is out of date (used in tests/CI)
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { applyGeneratedBlocks } from "../packages/shared/src/docgen";
import { ALL_BLOCKS } from "./docBlocks";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function docFiles(): string[] {
  const docsDir = join(root, "docs");
  const files = readdirSync(docsDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => join(docsDir, f));
  const readme = join(root, "README.md");
  if (existsSync(readme)) files.push(readme);
  return files;
}

export function generateAll(check: boolean): { stale: string[]; unknown: string[]; written: string[] } {
  const stale: string[] = [];
  const unknown: string[] = [];
  const written: string[] = [];
  for (const file of docFiles()) {
    const before = readFileSync(file, "utf8");
    const result = applyGeneratedBlocks(before, ALL_BLOCKS);
    for (const u of result.unknown) unknown.push(`${relative(root, file)}: ${u}`);
    if (result.content !== before) {
      stale.push(relative(root, file));
      if (!check) {
        writeFileSync(file, result.content);
        written.push(relative(root, file));
      }
    }
  }
  return { stale, unknown, written };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const check = process.argv.includes("--check");
  const { stale, unknown, written } = generateAll(check);
  if (unknown.length) {
    console.error(`Unknown generated block(s):\n  ${unknown.join("\n  ")}`);
    process.exit(1);
  }
  if (check) {
    if (stale.length) {
      console.error(`Docs out of date — run \`npm run docs:generate\`:\n  ${stale.join("\n  ")}`);
      process.exit(1);
    }
    console.log("Docs are up to date.");
  } else {
    console.log(written.length ? `Updated:\n  ${written.join("\n  ")}` : "Docs already up to date.");
  }
}
