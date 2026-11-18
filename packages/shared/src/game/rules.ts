import { averageScore, type Board, cellsOfSquare, parseCellId, type Scores } from "../board";
import { type ActionKind, K_LABELS, type KLabel, P_LABELS, type PLabel } from "../labels";
import type { Validator } from "../rules/validators";

/* ═══════════════════════════════════════════════════════════════════════════
 * GAME RULES — what players may act on and what their actions do to the map.
 *
 * Everything that is "the game" (as opposed to "the harness") lives here:
 *
 *   targetOf  which sub-square of a square a player's action lands on
 *   deltas    how an accepted proposal / decision changes the scores
 *   mapScore  the single score of the whole map
 *   validators (optional) extra restrictions on actions
 *
 * The rest of the app only calls these functions, so a rule set can change
 * without touching the server, the network, the UI or the data pipeline.
 *
 * How it fits together (docs/GAME-RULES.md has the full picture):
 *   - The server applies the rules when it ACCEPTS an action and records the
 *     resulting score changes in the event (`scoreChanges`). The reducer only
 *     replays those recorded changes, so the scores of a past session never
 *     change when the rules change later.
 *   - Every session records the id and version of the rule set it used
 *     (SessionCreated.rules). Bump `version` whenever a rule set's behaviour
 *     changes; add a new rule set (new id) for a different game variant.
 *
 * To change the current game: edit STANDARD below (numbers first), bump its
 * version, update docs/GAME-RULES.md and run the tests. To add a variant:
 * write another `defineGameRules({...})`, add it to GAME_RULES, and choose it
 * per session in setup step 01.
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Who acted: the seat and its labels at the time of the action. */
export interface RulesActor {
  seat: number;
  k: KLabel | null;
  p: PLabel | null;
}

/** An action as the rules see it. */
export interface ScoredAction {
  kind: ActionKind;
  /** Target sub-square ("C7-Kb"). */
  regionId: string;
  actor: RulesActor;
  round: number;
}

/** One sub-square's score before and after an action (recorded in the event). */
export interface ScoreChange {
  regionId: string;
  from: number;
  to: number;
}

export interface GameRules {
  /** Stable id, stored in the session config (lowercase, dashes). */
  id: string;
  /** Bump whenever the behaviour changes; every session records the version it ran with. */
  version: string;
  name: string;
  /** Plain-language summary, shown in setup and in docs/GAME-RULES.md. */
  summary: string;
  /** Lowest and highest score of a sub-square; scores are kept inside this range. */
  scoreRange: { min: number; max: number };
  /** Decimals shown for the map score. */
  mapScoreDecimals: number;
  /** The rule set's numbers, for the docs and the setup summary (not read by the harness). */
  params: Record<string, unknown>;
  /**
   * Knowledge type of the sub-square an actor's proposal/decision lands on,
   * whichever square they pick. null = this actor cannot act (e.g. no labels).
   * The player screen turns a click on a square into this sub-square; the
   * server rejects an intent for any other sub-square.
   */
  targetOf(actor: RulesActor, kind: ActionKind): KLabel | null;
  /**
   * Score change per sub-square caused by one accepted action, before the
   * range is applied (sub-squares not listed stay as they are). Must be pure:
   * no clocks, no randomness.
   */
  deltas(action: ScoredAction, board: Board, scores: Readonly<Scores>): Record<string, number>;
  /** One score for the whole map (null when there are no scores). */
  mapScore(scores: Readonly<Scores>, board: Board): number | null;
  /** Extra checks on intents, run after the harness's own validators (optional). */
  validators?: Validator[];
}

export function defineGameRules(rules: GameRules): GameRules {
  return rules;
}

/** The knowledge type that has the same letter as a power type: Pa → Ka, Pb → Kb, … */
export function knowledgeOfPower(p: PLabel): KLabel {
  return K_LABELS[P_LABELS.indexOf(p)]!;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * STANDARD — the current game. Change the numbers here.
 * ═══════════════════════════════════════════════════════════════════════════ */

export const STANDARD = {
  /** Every sub-square's score stays within 0–10. */
  scoreRange: { min: 0, max: 10 },
  /** A decision: +4 on the decided sub-square, −1 on each other sub-square of the same square. */
  decide: { target: 4, sameSquare: -1 },
  /** A proposal changes no scores (it only marks the sub-square for everyone). */
  propose: { target: 0, sameSquare: 0 },
} as const;

export const standardRules = defineGameRules({
  id: "standard",
  version: "1",
  name: "Standard",
  summary:
    "A player acts on the sub-square of their power type (Pa → Ka, Pb → Kb, …) in the square they pick. A decision adds 4 to that sub-square and takes 1 from each of the other three sub-squares of the square; a proposal changes no scores. Scores stay between 0 and 10. The map score is the average of all sub-square scores.",
  scoreRange: STANDARD.scoreRange,
  mapScoreDecimals: 2,
  params: {
    scoreRange: `${STANDARD.scoreRange.min}–${STANDARD.scoreRange.max}`,
    "decide: decided sub-square": STANDARD.decide.target,
    "decide: other sub-squares of the square": STANDARD.decide.sameSquare,
    "propose: proposed sub-square": STANDARD.propose.target,
    "propose: other sub-squares of the square": STANDARD.propose.sameSquare,
    target: "sub-square of the actor's power type",
    mapScore: "average of all sub-squares",
  },
  targetOf: (actor) => (actor.p ? knowledgeOfPower(actor.p) : null),
  deltas(action) {
    const cell = parseCellId(action.regionId);
    if (!cell) return {};
    const effect = STANDARD[action.kind];
    const out: Record<string, number> = {};
    for (const id of cellsOfSquare(cell.id)) {
      const d = id === action.regionId ? effect.target : effect.sameSquare;
      if (d !== 0) out[id] = d;
    }
    return out;
  },
  mapScore: (scores) => averageScore(scores),
});

/* ─────────────────────────── Registry ─────────────────────────── */

/** Every rule set a session can choose (setup step 01). The first is the default. */
export const GAME_RULES: GameRules[] = [standardRules];
export const DEFAULT_GAME_RULES = standardRules.id;

export function getGameRules(id: string | null | undefined): GameRules | undefined {
  return GAME_RULES.find((r) => r.id === (id ?? DEFAULT_GAME_RULES));
}

/* ─────────────────────────── Applying rules (generic, rule-independent) ─────────────────────────── */

function clamp(v: number, range: { min: number; max: number }): number {
  return Math.min(range.max, Math.max(range.min, v));
}

/** The score changes one action causes, with the range applied (only sub-squares whose score changes). */
export function scoreChangesOf(
  rules: GameRules,
  board: Board,
  scores: Readonly<Scores>,
  action: ScoredAction,
): ScoreChange[] {
  const out: ScoreChange[] = [];
  for (const [regionId, delta] of Object.entries(rules.deltas(action, board, scores))) {
    const from = scores[regionId];
    if (from === undefined) continue;
    const to = clamp(from + delta, rules.scoreRange);
    if (to !== from) out.push({ regionId, from, to });
  }
  return out;
}

export function applyScoreChanges(scores: Scores, changes: readonly ScoreChange[] | undefined): void {
  for (const c of changes ?? []) scores[c.regionId] = c.to;
}

/** Scores after a list of actions (in order), starting from `initial`. */
export function replayScores(
  rules: GameRules,
  board: Board,
  initial: Readonly<Scores>,
  actions: readonly ScoredAction[],
): Scores {
  const scores: Scores = { ...initial };
  for (const a of actions) applyScoreChanges(scores, scoreChangesOf(rules, board, scores, a));
  return scores;
}

/** Map score as text with the rule set's decimals, e.g. "5.13". */
export function formatMapScore(rules: GameRules | undefined, value: number | null): string {
  if (value === null) return "–";
  return value.toFixed(rules?.mapScoreDecimals ?? 2);
}

/** Human summary of score changes, grouped by square: "D3: Ka 4→3, Kd 6→10". */
export function formatScoreChanges(changes: readonly ScoreChange[] | undefined): string {
  const bySquare = new Map<string, string[]>();
  for (const c of changes ?? []) {
    const cell = parseCellId(c.regionId);
    const square = cell?.id ?? c.regionId;
    const list = bySquare.get(square) ?? [];
    list.push(`${cell?.k ?? c.regionId} ${c.from}→${c.to}`);
    bySquare.set(square, list);
  }
  return [...bySquare].map(([square, list]) => `${square}: ${list.join(", ")}`).join("; ");
}
