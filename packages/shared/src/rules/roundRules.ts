import type { ActionKind } from "../labels";
import { actionsOf, activeSeats, type ReadonlyGameState } from "../state";
import type { ValidationResult } from "./validators";

/*
 * Round rules (RoundSpecSchema.rule in config.ts): what counts as "a round".
 *  - quota:  the round ends when every active seat has used all its quotas (unlimited quotas never complete).
 *  - manual: quotas cap actions, but only the facilitator (or the time limit) ends the round.
 * Both cap actions with the quotas (checkQuota).
 */

export function quotaLimit(state: ReadonlyGameState, kind: ActionKind): number | null {
  return state.roundSpec?.quota[kind] ?? null;
}

export function quotaUsed(state: ReadonlyGameState, seat: number, kind: ActionKind): number {
  return actionsOf(state, seat, state.round, kind).length;
}

/** May `seat` perform `kind` right now (quota limits)? */
export function checkQuota(state: ReadonlyGameState, seat: number, kind: ActionKind): ValidationResult {
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

/** Is the current round finished by its rule (checked after every accepted action)? Never for 'manual'. */
export function roundIsComplete(state: ReadonlyGameState): boolean {
  if ((state.roundSpec?.rule ?? "quota") !== "quota") return false;
  const seats = activeSeats(state);
  if (seats.length === 0) return false;
  const kinds: ActionKind[] = ["propose", "decide"];
  const limited = kinds.filter((k) => quotaLimit(state, k) !== null);
  if (limited.length === 0) return false;
  return seats.every((s) => limited.every((k) => quotaUsed(state, s.seat, k) >= quotaLimit(state, k)!));
}
