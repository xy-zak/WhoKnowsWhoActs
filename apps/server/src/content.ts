import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  ConsentFormSchema,
  DemographicsFormSchema,
  type OnboardingContent,
  PREFER_NOT_TO_SAY,
  pathAnchor,
  type Region,
  type Scenario,
  ScenarioFileSchema,
  StudyConfigSchema,
  type View,
  ViewSchema,
} from "@wkwa/shared";
import { z } from "zod";

export function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

/* ─────────────────────────── Scenarios ─────────────────────────── */

function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`));
  return m ? (m[2] ?? m[3]) : undefined;
}

/** Extract regions (<path id="…" d="…" data-name="…">) and the viewBox from an SVG outline. */
export function parseSvgOutline(svg: string): { viewBox: string; regions: Region[] } {
  const svgTag = svg.match(/<svg\b[^>]*>/)?.[0];
  if (!svgTag) throw new Error("No <svg> element found");
  const viewBox = attr(svgTag, "viewBox");
  if (!viewBox) throw new Error("The <svg> element needs a viewBox attribute");
  if (/\btransform\s*=/.test(svg)) {
    throw new Error(
      "SVG transforms are not supported; flatten transforms before exporting (Inkscape: Path → Object to Path, then remove transforms)",
    );
  }
  const regions: Region[] = [];
  const seen = new Set<string>();
  for (const m of svg.matchAll(/<path\b[^>]*>/g)) {
    const tag = m[0];
    const id = attr(tag, "id");
    const d = attr(tag, "d");
    if (!id || !d) continue;
    if (seen.has(id)) throw new Error(`Duplicate region id '${id}'`);
    seen.add(id);
    regions.push({ id, name: attr(tag, "data-name") ?? id, path: d, anchor: pathAnchor(d) });
  }
  if (regions.length === 0) throw new Error("No <path id=… d=…> regions found in the SVG");
  return { viewBox, regions };
}

export function loadScenario(dir: string): Scenario {
  const file = ScenarioFileSchema.parse(JSON.parse(readFileSync(path.join(dir, "scenario.json"), "utf8")));
  const outline = parseSvgOutline(readFileSync(path.join(dir, file.map), "utf8"));
  const views: Record<string, View> =
    typeof file.views === "string"
      ? z.record(z.string(), ViewSchema).parse(JSON.parse(readFileSync(path.join(dir, file.views), "utf8")))
      : file.views;
  const regionIds = new Set(outline.regions.map((r) => r.id));
  for (const [viewId, view] of Object.entries(views)) {
    for (const rid of Object.keys(view.regions)) {
      if (!regionIds.has(rid)) throw new Error(`View '${viewId}' has content for unknown region '${rid}'`);
    }
  }
  const body = {
    id: file.id,
    title: file.title,
    version: file.version,
    description: file.description,
    viewBox: outline.viewBox,
    regions: outline.regions,
    attributes: file.attributes,
    views,
  };
  return { ...body, hash: sha256(JSON.stringify(body)) };
}

export interface ScenarioInfo {
  id: string;
  title: string;
  version: string;
  description: string;
  regionCount: number;
  viewIds: string[];
  error?: string;
}

export class ScenarioLibrary {
  constructor(private readonly root: string) {}

  list(): ScenarioInfo[] {
    if (!existsSync(this.root)) return [];
    const out: ScenarioInfo[] = [];
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(this.root, entry.name);
      if (!existsSync(path.join(dir, "scenario.json"))) continue;
      try {
        const s = loadScenario(dir);
        out.push({
          id: s.id,
          title: s.title,
          version: s.version,
          description: s.description,
          regionCount: s.regions.length,
          viewIds: Object.keys(s.views),
        });
      } catch (e) {
        out.push({
          id: entry.name,
          title: entry.name,
          version: "?",
          description: "",
          regionCount: 0,
          viewIds: [],
          error: String((e as Error).message),
        });
      }
    }
    return out;
  }

  /** Load a scenario by id (directory name or scenario.json id). */
  load(id: string): Scenario {
    const direct = path.join(this.root, id);
    if (existsSync(path.join(direct, "scenario.json"))) return loadScenario(direct);
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(this.root, entry.name);
      try {
        const s = loadScenario(dir);
        if (s.id === id) return s;
      } catch {}
    }
    throw new Error(`Unknown scenario '${id}'`);
  }
}

/* ─────────────────────────── Onboarding content ─────────────────────────── */

/**
 * Load study info, consent form, demographics and briefing from config/.
 * Loaded fresh whenever a session is created or resumed, so edits apply
 * without restarting the server. The SHA-256 of each text is recorded with
 * the participant's answers.
 */
export function loadOnboardingContent(configDir: string): OnboardingContent {
  const read = (f: string) => readFileSync(path.join(configDir, f), "utf8");
  const study = StudyConfigSchema.parse(JSON.parse(read("study.json")));
  const consent = ConsentFormSchema.parse(JSON.parse(read("consent.json")));
  const demographics = DemographicsFormSchema.parse(JSON.parse(read("demographics.json")));
  for (const q of demographics.questions) {
    if (!q.options.some((o) => o.value === PREFER_NOT_TO_SAY)) {
      throw new Error(`Demographic question '${q.id}' must offer '${PREFER_NOT_TO_SAY}'`);
    }
  }
  const consentMd = read(consent.markdownFile);
  const briefingMd = read(study.briefingMarkdownFile);
  return {
    study,
    consent: {
      version: consent.version,
      markdown: consentMd,
      // hash covers everything the participant sees on the consent screen
      sha256: sha256(JSON.stringify({ md: consentMd, items: consent.items, study })),
      items: consent.items,
    },
    demographics,
    briefing: { markdown: briefingMd, sha256: sha256(briefingMd) },
  };
}
