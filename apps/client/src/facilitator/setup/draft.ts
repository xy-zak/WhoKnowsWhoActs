import {
  checkSimulationConfig,
  normaliseForPlayers,
  normaliseTags,
  parseSessionConfig,
  type SessionConfig,
} from "@wkwa/shared";

/** The session being configured (setup steps 1–6), kept in localStorage so nothing is lost on reload. */
export interface Draft {
  scenarioId: string;
  config: SessionConfig;
  tagsText: string;
  overridesText: string;
  /** Agent policy parameters as JSON text (`simulation.params`), edited in step 03 when players are simulated. */
  simParamsText: string;
  notes: string;
  /** Furthest step reached (0-based), for the stepper's ✓ marks. */
  reached: number;
}

const KEY = "wkwa.setup.draft";

export function emptyDraft(defaults?: SessionConfig): Draft {
  const config = defaults ?? parseSessionConfig({});
  return {
    scenarioId: "",
    config,
    tagsText: config.tags.join(", "),
    overridesText: JSON.stringify(config.roundOverrides, null, 2),
    simParamsText: JSON.stringify(config.simulation.params, null, 2),
    notes: "",
    reached: 0,
  };
}

export function loadDraft(): Draft | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as Draft;
    const config = parseSessionConfig(d.config);
    // drafts saved before simulated players existed have no simParamsText
    return {
      ...d,
      config,
      simParamsText: d.simParamsText ?? JSON.stringify(config.simulation.params, null, 2),
    };
  } catch {
    return null;
  }
}

export function saveDraft(d: Draft) {
  try {
    localStorage.setItem(KEY, JSON.stringify(d));
  } catch {}
}

export function clearDraft() {
  try {
    localStorage.removeItem(KEY);
  } catch {}
}

/** Build the final config from the draft (tags + overrides text). Returns an error message if invalid. */
export function finalConfig(d: Draft): { config: SessionConfig } | { error: string } {
  let roundOverrides: unknown;
  try {
    roundOverrides = JSON.parse(d.overridesText.trim() || "{}");
  } catch {
    return { error: "Per-round overrides are not valid JSON (step 02 · Rounds)" };
  }
  let params: unknown = d.config.simulation.params;
  if (d.config.players === "simulated") {
    try {
      params = JSON.parse(d.simParamsText.trim() || "{}");
    } catch {
      return { error: "Policy parameters are not valid JSON (step 03 · Players)" };
    }
  }
  try {
    const config = normaliseForPlayers(
      parseSessionConfig({
        ...d.config,
        tags: normaliseTags(d.tagsText),
        roundOverrides,
        simulation: {
          ...d.config.simulation,
          params,
          // overrides for seats that no longer exist (seat count lowered) are dropped
          seatPolicies: Object.fromEntries(
            Object.entries(d.config.simulation.seatPolicies).filter(([k]) => Number(k) <= d.config.seatCount),
          ),
        },
      }),
    );
    if (config.players === "simulated") {
      const problem = checkSimulationConfig(config.simulation, config.seatCount);
      if (problem) return { error: `${problem} (step 03 · Players)` };
    }
    return { config };
  } catch (e) {
    const issue = (e as { issues?: Array<{ path: unknown[]; message: string }> }).issues?.[0];
    return { error: issue ? `${issue.path.join(".")}: ${issue.message}` : String(e) };
  }
}

/** Per-key keysheet confirmation (setup step 9), per session. */
export function keySheetConfirmed(sessionId: string): boolean {
  try {
    return localStorage.getItem(`wkwa.keysheet.${sessionId}`) === "1";
  } catch {
    return false;
  }
}

export function setKeySheetConfirmed(sessionId: string, v: boolean) {
  try {
    if (v) localStorage.setItem(`wkwa.keysheet.${sessionId}`, "1");
    else localStorage.removeItem(`wkwa.keysheet.${sessionId}`);
  } catch {}
}
