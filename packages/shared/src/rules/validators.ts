import { parseCellId } from "../board";
import type { PayloadOf } from "../events";
import { actorOf, rulesFor } from "../game/scoring";
import type { ActionKind } from "../labels";
import type { ReadonlyGameState } from "../state";
import { checkQuota } from "./roundRules";

export interface Intent {
  kind: ActionKind;
  /** Target sub-square, e.g. "C7-Kb". */
  regionId: string;
}

export type RejectionReason = PayloadOf<"IntentRejected">["reason"];
export type ValidationResult = { ok: true } | { ok: false; reason: RejectionReason; detail: string };

/**
 * A validator inspects the state and an intent and either lets it through or
 * rejects it with a reason. Validators run in order; the first rejection wins.
 *
 * Harness checks live here. Checks that are part of the GAME (which
 * sub-square a player may act on, "a sub-square can only be decided once per
 * round", …) belong to the game rules instead (game/rules.ts:
 * `targetOf` and `validators`); `gameRulesAllow` below runs them. That way a
 * rule change never touches this file. Add a unit test in packages/shared/test.
 */
export type Validator = (state: ReadonlyGameState, seat: number, intent: Intent) => ValidationResult;

const OK: ValidationResult = { ok: true };

export const roundIsActive: Validator = (state) =>
  state.phase === "round_active"
    ? OK
    : { ok: false, reason: "round_not_active", detail: "No round is active right now" };

export const notPaused: Validator = (state) =>
  state.paused ? { ok: false, reason: "paused", detail: "The game is paused" } : OK;

export const seatIsActive: Validator = (state, seat) => {
  const s = state.seats[seat];
  if (!s?.bound || s.withdrawn)
    return { ok: false, reason: "seat_inactive", detail: "This seat is not active" };
  return OK;
};

export const regionExists: Validator = (state, _seat, intent) =>
  state.regionIds.includes(intent.regionId)
    ? OK
    : { ok: false, reason: "unknown_region", detail: `Unknown sub-square '${intent.regionId}'` };

/** Quota checks (every round rule caps actions with the quotas). */
export const roundRuleAllows: Validator = (state, seat, intent) => checkQuota(state, seat, intent.kind);

/**
 * Delegates to the session's game rules: the target must be the sub-square
 * the rules give this seat (standard rules: the one of its power type), and
 * every validator of the rule set must pass. Sessions without a board (recorded
 * before the grid map) skip this.
 */
export const gameRulesAllow: Validator = (state, seat, intent) => {
  if (!state.board) return OK;
  const rules = rulesFor(state);
  const target = rules.targetOf(actorOf(state, seat), intent.kind);
  const cell = parseCellId(intent.regionId);
  if (target === null)
    return { ok: false, reason: "rule", detail: "You cannot act on the map yet (no power type assigned)" };
  if (!cell || cell.k !== target)
    return {
      ok: false,
      reason: "rule",
      detail: `You can only act on ${target} sub-squares (your power type)`,
    };
  for (const v of rules.validators ?? []) {
    const r = v(state, seat, intent);
    if (!r.ok) return r;
  }
  return OK;
};

/**
 * Default validators. Note: 'decide' is deliberately independent of 'propose' —
 * a player may decide on a sub-square nobody proposed. Whether it had been
 * proposed (and by whom) is recorded in the DecisionMade event for analysis.
 */
export const DEFAULT_VALIDATORS: Validator[] = [
  roundIsActive,
  notPaused,
  seatIsActive,
  regionExists,
  roundRuleAllows,
  gameRulesAllow,
];

export function validateIntent(
  state: ReadonlyGameState,
  seat: number,
  intent: Intent,
  validators: Validator[] = DEFAULT_VALIDATORS,
): ValidationResult {
  for (const v of validators) {
    const r = v(state, seat, intent);
    if (!r.ok) return r;
  }
  return OK;
}
