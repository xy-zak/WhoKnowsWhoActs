import { z } from "zod";
import {
  type Board,
  BoardSchema,
  cellName,
  cellsOf,
  ScoreMatricesSchema,
  type Scores,
  squareOf,
} from "./board";
import { type KLabel, KLabelSchema } from "./labels";

/* ═══════════════════════════════════════════════════════════════════════════
 * A scenario = one grid map (board size) + one view per knowledge type (its
 * name) + the starting score of every sub-square.
 *
 * Each player sees the scores of ONE knowledge type: the view their seat is
 * given (by default the view of their K label). See board.ts for the layout
 * and ids, docs/GAME-RULES.md for what actions do to the scores.
 * ═══════════════════════════════════════════════════════════════════════════ */

/** A view = one knowledge type: the scores of its sub-squares are what a seat with this view knows. */
export const ViewSchema = z.object({
  name: z.string().describe("Name of the knowledge type, shown to players, e.g. 'Hydrology'"),
  description: z.string().default("").describe("One line on what this knowledge type covers"),
});
export type View = z.infer<typeof ViewSchema>;

/** scenario.json on disk. `scores` points to a JSON file (or holds the matrices inline). */
export const ScenarioFileSchema = z.object({
  id: z.string().regex(/^[a-z0-9-_]+$/),
  title: z.string(),
  version: z.string(),
  description: z.string().default(""),
  board: BoardSchema,
  views: z
    .record(KLabelSchema, ViewSchema)
    .describe("One view per knowledge type (Ka–Kd); its scores are what a seat with that view sees"),
  scores: z
    .union([z.string(), ScoreMatricesSchema])
    .describe("Starting scores: path (relative to scenario.json) of a JSON file, or the matrices inline"),
});
export type ScenarioFile = z.infer<typeof ScenarioFileSchema>;

/** One sub-square of the map (the unit players act on). */
export const RegionSchema = z.object({
  id: z.string().describe("Sub-square id, e.g. 'C7-Kb'"),
  name: z.string().describe("Display name, e.g. 'C7 · Kb'"),
  square: z.string().describe("Square the sub-square belongs to, e.g. 'C7'"),
  k: KLabelSchema.describe("Knowledge type of the sub-square"),
});
export type Region = z.infer<typeof RegionSchema>;

/** A fully loaded scenario, as held by the server. */
export const ScenarioSchema = z.object({
  id: z.string(),
  title: z.string(),
  version: z.string(),
  description: z.string(),
  board: BoardSchema,
  views: z.record(z.string(), ViewSchema),
  regions: z.array(RegionSchema),
  initialScores: z.record(z.string(), z.number()).describe("Starting score per sub-square id"),
  hash: z.string().describe("SHA-256 of the loaded scenario (for reproducibility)"),
});
export type Scenario = z.infer<typeof ScenarioSchema>;

/** What a client needs to draw the map (identical for every player): board size and knowledge-type names. */
export type MapGeometry = Pick<Scenario, "board" | "views">;

/** The sub-squares of a board as scenario regions. */
export function regionsOf(board: Board): Region[] {
  return cellsOf(board).map((id) => ({
    id,
    name: cellName(id),
    square: squareOf(id),
    k: id.slice(-2) as KLabel,
  }));
}

/** Check a scenario's starting scores (every sub-square present, numbers only). */
export function checkInitialScores(board: Board, scores: Scores): string | null {
  for (const id of cellsOf(board)) {
    const v = scores[id];
    if (v === undefined) return `No starting score for ${id}`;
    if (!Number.isFinite(v)) return `Starting score of ${id} is not a number`;
  }
  return null;
}
