import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mermaidJs = join(root, "node_modules/mermaid/dist/mermaid.min.js");

function markdownFiles(): string[] {
  const files = readdirSync(join(root, "docs"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => join("docs", f));
  if (existsSync(join(root, "README.md"))) files.push("README.md");
  return files;
}

function mermaidBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1]!);
}

for (const file of markdownFiles()) {
  test(`mermaid diagrams parse and render: ${file}`, async ({ page }) => {
    const blocks = mermaidBlocks(readFileSync(join(root, file), "utf8"));
    test.skip(blocks.length === 0, "no diagrams");
    await page.setContent("<!doctype html><html><body></body></html>");
    await page.addScriptTag({ path: mermaidJs });
    const errors = await page.evaluate(async (sources: string[]) => {
      // biome-ignore lint/suspicious/noExplicitAny: mermaid is a global from the UMD bundle
      const mermaid = (window as any).mermaid;
      mermaid.initialize({ startOnLoad: false });
      const out: string[] = [];
      for (let i = 0; i < sources.length; i++) {
        try {
          await mermaid.parse(sources[i]);
          await mermaid.render(`diagram-${i}`, sources[i]);
        } catch (e) {
          out.push(`block #${i + 1}: ${(e as Error).message ?? String(e)}`);
        }
      }
      return out;
    }, blocks);
    expect(errors, `${file}\n${errors.join("\n\n")}`).toEqual([]);
  });
}
