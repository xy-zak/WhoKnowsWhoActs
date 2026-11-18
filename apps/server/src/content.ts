import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  ConsentFormSchema,
  checkInitialScores,
  DemographicsFormSchema,
  K_LABELS,
  type OnboardingContent,
  PREFER_NOT_TO_SAY,
  regionsOf,
  type Scenario,
  ScenarioFileSchema,
  ScoreMatricesSchema,
  StudyConfigSchema,
  scoresFromMatrices,
} from "@wkwa/shared";

export function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

/* ─────────────────────────── Scenarios ─────────────────────────── */

/**
 * Load `scenario.json` (+ its scores file): a grid board, one view per
 * knowledge type and the starting score of every sub-square. Throws with a
 * readable message when anything is missing or the sizes do not match.
 */
export function loadScenario(dir: string): Scenario {
  const file = ScenarioFileSchema.parse(JSON.parse(readFileSync(path.join(dir, "scenario.json"), "utf8")));
  for (const k of K_LABELS) {
    if (!file.views[k])
      throw new Error(`The scenario needs a view for every knowledge type; '${k}' is missing`);
  }
  const matrices = ScoreMatricesSchema.parse(
    typeof file.scores === "string"
      ? JSON.parse(readFileSync(path.join(dir, file.scores), "utf8"))
      : file.scores,
  );
  const initialScores = scoresFromMatrices(file.board, matrices);
  const problem = checkInitialScores(file.board, initialScores);
  if (problem) throw new Error(problem);
  const body = {
    id: file.id,
    title: file.title,
    version: file.version,
    description: file.description,
    board: file.board,
    views: file.views as Scenario["views"],
    regions: regionsOf(file.board),
    initialScores,
  };
  return { ...body, hash: sha256(JSON.stringify(body)) };
}

export interface ScenarioInfo {
  id: string;
  title: string;
  version: string;
  description: string;
  /** Board size in squares. */
  board: { cols: number; rows: number } | null;
  /** Number of sub-squares (4 per square). */
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
          board: s.board,
          regionCount: s.regions.length,
          viewIds: Object.keys(s.views),
        });
      } catch (e) {
        out.push({
          id: entry.name,
          title: entry.name,
          version: "?",
          description: "",
          board: null,
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
