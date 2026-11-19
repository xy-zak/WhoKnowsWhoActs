import type { ActionKind } from "../labels";
import { actionsOf, activeSeats, type ReadonlyGameState } from "../state";

export type RuleResult = { ok: true } | { ok: false; reason: "quota_exhausted" | "rule"; detail: string };

/**
 * A round rule decides what counts as "a round".
 *
 * To add a new rule:
 *   1. implement this interface below,
 *   2. register it in ROUND_RULES,
 *   3. add its id to RoundSpecSchema.rule in config.ts.
 */
export interface RoundRule {
  id: string;
  description: string;
  /** May `seat` perform `kind` right now (quota-style limits)? */
  canAct(state: ReadonlyGameState, seat: number, kind: ActionKind): RuleResult;
  /** Is the current round finished (checked after every accepted action)? */
  isComplete(state: ReadonlyGameState): boolean;
}

export function quotaLimit(state: ReadonlyGameState, kind: ActionKind): number | null {
  return state.roundSpec?.quota[kind] ?? null;
}

export function quotaUsed(state: ReadonlyGameState, seat: number, kind: ActionKind): number {
  return actionsOf(state, seat, state.round, kind).length;
}

function checkQuota(state: ReadonlyGameState, seat: number, kind: ActionKind): RuleResult {
  const limit = quotaLimit(state, kind);
  if (limit === null) return { ok: true };
  const used = quotaUsed(state, seat, kind);
  if (used >= limit) {
    return {
      ok: false,
      reason: "quota_exhausted",
      detail: `No ${kind === "propose" ? "proposals" : "decisions"} left this round (${used}/${limit})`,
    };
  }
  return { ok: true };
}

/** Default: every active player must use all their quotas; then the round ends. */
const quotaRule: RoundRule = {
  id: "quota",
  description: "Round ends when every active seat has used all its quotas (unlimited quotas never complete).",
  canAct: checkQuota,
  isComplete(state) {
    const seats = activeSeats(state);
    if (seats.length === 0) return false;
    const kinds: ActionKind[] = ["propose", "decide"];
    const limited = kinds.filter((k) => quotaLimit(state, k) !== null);
    if (limited.length === 0) return false;
    return seats.every((s) => limited.every((k) => quotaUsed(state, s.seat, k) >= quotaLimit(state, k)!));
  },
};

/** Manual: quotas still cap actions, but only the facilitator or the time limit ends the round. */
const manualRule: RoundRule = {
  id: "manual",
  description: "Quotas cap actions, but only the facilitator (or the time limit) ends the round.",
  canAct: checkQuota,
  isComplete: () => false,
};

export const ROUND_RULES: Record<string, RoundRule> = {
  [quotaRule.id]: quotaRule,
  [manualRule.id]: manualRule,
};

export function ruleFor(state: ReadonlyGameState): RoundRule {
  const id = state.roundSpec?.rule ?? "quota";
  const rule = ROUND_RULES[id];
  if (!rule) throw new Error(`Unknown round rule '${id}'`);
  return rule;
}
