import { z } from "zod";
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
 *     description: "Proposes regions its own view marks as low risk; decides only on proposed regions.",
 *     params: z.object({
 *       threshold: z.number().min(0).max(1).default(0.3).describe("Highest risk it accepts"),
 *     }),
 *     act(view, ctx) {
 *       if (!canAct(view)) return null;
 *       // view.content[regionId] = this seat's own data; view.highlights = what is on the map;
 *       // view.me.k / view.me.p = own labels (if the session shows them to players).
 *       // Use ctx.random() for every random choice, ctx.memory to remember things between turns.
 *       return null; // or { kind: "propose", regionId: "R07" }
 *     },
 *   });
 *
 * then add it to BUILT_IN_POLICIES below, run `npm run docs:generate`
 * (ARCHITECTURE.md lists every policy and its parameters) and add a test in
 * packages/shared/test/simulation.test.ts. Bump `version` whenever a policy's
 * behaviour changes: every simulated seat logs the version it ran with.
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Baseline: random regions, random propose/decide, as long as quota is left. */
export const randomPolicy = definePolicy({
  id: "random",
  version: "1",
  name: "Random",
  description:
    "Baseline. On each turn it proposes or decides on a uniformly random region while it has quota left. It ignores what its map view shows.",
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
    const kinds = kindsWithQuota(view);
    if (kinds.length === 0 || view.map.regions.length === 0) return null;
    const kind =
      kinds.length === 1 ? kinds[0]! : ctx.random() < ctx.params.proposeBias ? "propose" : "decide";
    return { kind, regionId: pick(view.map.regions, ctx.random).id };
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
