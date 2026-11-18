import { z } from "zod";
import { cellId, squaresOf } from "../board";
import { canAct, definePolicy, kindsWithQuota, type PlayerPolicy, pick, registerPolicy } from "./policy";

/* ═══════════════════════════════════════════════════════════════════════════
 * BUILT-IN AGENT POLICIES
 *
 * The rules for simulated players are not designed yet. These two policies
 * are baselines that make a simulated session run end to end. Add real ones
 * here when the design is ready:
 *
 *   export const cautiousPolicy = definePolicy({
 *     id: "cautious",
 *     version: "1",
 *     name: "Cautious",
 *     description: "Decides on squares where its own knowledge type scores low.",
 *     params: z.object({
 *       threshold: z.number().min(0).max(10).default(3).describe("Highest own score it acts on"),
 *     }),
 *     act(view, ctx) {
 *       if (!canAct(view)) return null;
 *       // view.scores = this seat's own knowledge type's scores ("C7-Ka" → 6); view.highlights = what is
 *       // on the map; view.mapScore = the whole map's score; view.me.actsOn.decide = the knowledge type
 *       // of the sub-squares its decisions land on (game rules); view.me.k / view.me.p = own labels.
 *       // Use ctx.random() for every random choice, ctx.memory to remember things between turns.
 *       return null; // or { kind: "decide", regionId: cellId("C7", view.me.actsOn.decide!) }
 *     },
 *   });
 *
 * then add it to BUILT_IN_POLICIES below, run `npm run docs:generate`
 * (ARCHITECTURE.md lists every policy and its parameters) and add a test in
 * packages/shared/test/simulation.test.ts. Bump `version` whenever a policy's
 * behaviour changes: every simulated seat logs the version it ran with.
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Baseline: random squares, random propose/decide, as long as quota is left. */
export const randomPolicy = definePolicy({
  id: "random",
  version: "2",
  name: "Random",
  description:
    "Baseline. On each turn it proposes or decides on a uniformly random square (the sub-square the game rules give it) while it has quota left. It ignores the scores it sees.",
  params: z.object({
    proposeBias: z
      .number()
      .min(0)
      .max(1)
      .default(0.5)
      .describe("Chance of proposing rather than deciding when both are still possible"),
  }),
  act(view, ctx) {
    if (!canAct(view)) return null;
    const kinds = kindsWithQuota(view).filter((k) => view.me.actsOn[k] !== null);
    const squares = squaresOf(view.map.board);
    if (kinds.length === 0 || squares.length === 0) return null;
    const kind =
      kinds.length === 1 ? kinds[0]! : ctx.random() < ctx.params.proposeBias ? "propose" : "decide";
    return { kind, regionId: cellId(pick(squares, ctx.random), view.me.actsOn[kind]!) };
  },
});

/** Never acts. */
export const idlePolicy = definePolicy({
  id: "idle",
  version: "1",
  name: "Idle",
  description:
    "Never acts. Use it for a seat that only watches, or to test time limits and rounds the facilitator ends.",
  params: z.object({}),
  act: () => null,
});

export const BUILT_IN_POLICIES: PlayerPolicy[] = [randomPolicy, idlePolicy] as unknown as PlayerPolicy[];

for (const p of BUILT_IN_POLICIES) registerPolicy(p);
