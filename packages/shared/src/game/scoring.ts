import type { Scores } from "../board";
import type { ActionKind } from "../labels";
import type { ReadonlyGameState } from "../state";
import {
  DEFAULT_GAME_RULES,
  type GameRules,
  getGameRules,
  type RulesActor,
  replayScores,
  type ScoreChange,
  scoreChangesOf,
} from "./rules";

/* Glue between the game rules and the session state. Used by the server (to
 * compute the score changes it records in events) and by the clients (map
 * score, what a player acts on). */

/** The rule set of a session (the one recorded at creation, else the configured one). */
export function rulesFor(state: ReadonlyGameState): GameRules {
  const id = state.rules?.id ?? state.config.rules ?? DEFAULT_GAME_RULES;
  const rules = getGameRules(id);
  if (!rules) throw new Error(`Unknown game rules '${id}'`);
  return rules;
}

/** A seat as the rules see it (current labels). */
export function actorOf(state: ReadonlyGameState, seat: number): RulesActor {
  const s = state.seats[seat];
  return { seat, k: s?.k ?? null, p: s?.p ?? null };
}

/** Score changes an intent would cause if accepted now (empty for sessions without a board). */
export function scoreChangesForIntent(
  state: ReadonlyGameState,
  seat: number,
  intent: { kind: ActionKind; regionId: string },
): ScoreChange[] {
  if (!state.board) return [];
  return scoreChangesOf(rulesFor(state), state.board, state.scores, {
    kind: intent.kind,
    regionId: intent.regionId,
    actor: actorOf(state, seat),
    round: state.round,
  });
}

/**
 * Score changes caused by revoking the action with seq `targetSeq`: the
 * scores are replayed from the start without it, and compared with now.
 */
export function scoreChangesForRevoke(state: ReadonlyGameState, targetSeq: number): ScoreChange[] {
  if (!state.board) return [];
  const without = replayScores(
    rulesFor(state),
    state.board,
    state.initialScores,
    state.actions
      .filter((a) => !a.revoked && a.seq !== targetSeq)
      .map((a) => ({
        kind: a.kind,
        regionId: a.regionId,
        actor: { seat: a.seat, k: a.k, p: a.p },
        round: a.round,
      })),
  );
  const out: ScoreChange[] = [];
  for (const [regionId, to] of Object.entries(without)) {
    const from = state.scores[regionId];
    if (from !== undefined && from !== to) out.push({ regionId, from, to });
  }
  return out;
}

/** The score of the whole map right now (null for sessions without a board). */
export function mapScoreOf(state: ReadonlyGameState, scores: Readonly<Scores> = state.scores): number | null {
  if (!state.board) return null;
  return rulesFor(state).mapScore(scores, state.board);
}
