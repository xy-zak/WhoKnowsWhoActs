import type { PayloadOf } from "../events";
import type { ActionKind } from "../labels";
import type { GameState } from "../state";
import { ruleFor } from "./roundRules";

export interface Intent {
  kind: ActionKind;
  regionId: string;
}

export type RejectionReason = PayloadOf<"IntentRejected">["reason"];
export type ValidationResult = { ok: true } | { ok: false; reason: RejectionReason; detail: string };

/**
 * A validator inspects the state and an intent and either lets it through or
 * rejects it with a reason. Validators run in order; the first rejection wins.
 *
 * Game-design hooks live here. Examples you might add later:
 *  - "decide must target a region someone else proposed"
 *  - "power type Pa may decide twice as often"
 *  - "a region can only be decided once per round"
 * Write a function, add it to DEFAULT_VALIDATORS (or pass a custom list to
 * validateIntent), and add a unit test in packages/shared/test.
 */
export type Validator = (state: GameState, seat: number, intent: Intent) => ValidationResult;

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
    : { ok: false, reason: "unknown_region", detail: `Unknown region '${intent.regionId}'` };

/** Delegates to the round rule (quota checks). */
export const roundRuleAllows: Validator = (state, seat, intent) =>
  ruleFor(state).canAct(state, seat, intent.kind);

/**
 * Default rule set. Note: 'decide' is deliberately independent of 'propose' —
 * a player may decide on any region. Whether it had been proposed (and by
 * whom) is recorded in the DecisionMade event for analysis.
 */
export const DEFAULT_VALIDATORS: Validator[] = [
  roundIsActive,
  notPaused,
  seatIsActive,
  regionExists,
  roundRuleAllows,
];

export function validateIntent(
  state: GameState,
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
