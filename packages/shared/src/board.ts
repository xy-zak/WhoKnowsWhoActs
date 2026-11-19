import { z } from "zod";
import { K_LABELS, type KLabel } from "./labels";

/* ═══════════════════════════════════════════════════════════════════════════
 * THE BOARD — the grid map every session is played on.
 *
 * The map is a grid of SQUARES (cols × rows; columns A, B, C, …, rows 1, 2,
 * 3, …). Every square holds one SUB-SQUARE per knowledge type, always in the
 * same place:
 *
 *        ┌────┬────┐
 *        │ Ka │ Kb │
 *        ├────┼────┤
 *        │ Kc │ Kd │
 *        └────┴────┘
 *
 * A sub-square is the unit players act on and the unit that has a score. Its
 * id is the "region id" used in every event, telemetry record and export:
 * `<square>-<K>`, e.g. "C7-Kb" (column C, row 7, knowledge type Kb).
 *
 * This file is geometry only. What actions do to scores lives in
 * `game/rules.ts` (see docs/GAME-RULES.md).
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Largest number of columns or rows (columns are lettered A–Z). */
export const MAX_BOARD_SIDE = 26;

export const BoardSchema = z
  .object({
    cols: z.number().int().min(1).max(MAX_BOARD_SIDE).describe("Number of columns (lettered A, B, C, …)"),
    rows: z.number().int().min(1).max(MAX_BOARD_SIDE).describe("Number of rows (numbered 1, 2, 3, …)"),
  })
  .describe("Size of the grid map, in squares");
export type Board = z.infer<typeof BoardSchema>;

/** Score per sub-square, keyed by region id ("C7-Kb"). */
export type Scores = Record<string, number>;

/** Where each knowledge type sits inside a square: [column, row] of the 2 × 2 layout. */
export const SUB_SQUARE_POSITION: Record<KLabel, readonly [number, number]> = {
  Ka: [0, 0],
  Kb: [1, 0],
  Kc: [0, 1],
  Kd: [1, 1],
};

export function columnLetter(col: number): string {
  return String.fromCharCode(65 + col);
}

/** Square id from 0-based column and row: (2, 6) → "C7". */
export function squareId(col: number, row: number): string {
  return `${columnLetter(col)}${row + 1}`;
}

/** Region id of a sub-square: ("C7", "Kb") → "C7-Kb". */
export function cellId(square: string, k: KLabel): string {
  return `${square}-${k}`;
}

export interface SquareRef {
  id: string;
  /** 0-based column (A = 0). */
  col: number;
  /** 0-based row (1 = 0). */
  row: number;
}

export interface CellRef extends SquareRef {
  /** The sub-square's region id, e.g. "C7-Kb". */
  cell: string;
  /** Knowledge type of the sub-square. */
  k: KLabel;
}

const SQUARE_RE = /^([A-Z])([1-9]\d?)$/;
const CELL_RE = /^([A-Z][1-9]\d?)-(K[a-d])$/;

export function parseSquareId(id: string): SquareRef | null {
  const m = SQUARE_RE.exec(id);
  if (!m) return null;
  return { id, col: m[1]!.charCodeAt(0) - 65, row: Number(m[2]) - 1 };
}

/** Parse a sub-square id ("C7-Kb"); null for anything else. */
export function parseCellId(id: string): CellRef | null {
  const m = CELL_RE.exec(id);
  if (!m) return null;
  const sq = parseSquareId(m[1]!);
  if (!sq || !(K_LABELS as readonly string[]).includes(m[2]!)) return null;
  return { ...sq, cell: id, k: m[2] as KLabel };
}

export function isCellOnBoard(board: Board, id: string): boolean {
  const c = parseCellId(id);
  return c !== null && c.col < board.cols && c.row < board.rows;
}

/** Every square id, row by row from the top-left: A1 B1 … J1 A2 … */
export function squaresOf(board: Board): string[] {
  const out: string[] = [];
  for (let row = 0; row < board.rows; row++)
    for (let col = 0; col < board.cols; col++) out.push(squareId(col, row));
  return out;
}

/** The four sub-square ids of one square, in K order. */
export function cellsOfSquare(square: string): string[] {
  return K_LABELS.map((k) => cellId(square, k));
}

/** Every sub-square id: square by square (row-major), K order inside each square. */
export function cellsOf(board: Board): string[] {
  return squaresOf(board).flatMap(cellsOfSquare);
}

/** Display name of a sub-square or square: "C7-Kb" → "C7 · Kb", "C7" → "C7". */
export function cellName(id: string): string {
  const c = parseCellId(id);
  return c ? `${c.id} · ${c.k}` : id;
}

/** Square id of a sub-square ("C7-Kb" → "C7"); the id itself when it is not a sub-square. */
export function squareOf(id: string): string {
  return parseCellId(id)?.id ?? id;
}

/** Arithmetic mean of the given scores (null when there are none). */
export function averageScore(
  scores: Readonly<Scores>,
  ids: readonly string[] = Object.keys(scores),
): number | null {
  let sum = 0;
  let n = 0;
  for (const id of ids) {
    const v = scores[id];
    if (v === undefined) continue;
    sum += v;
    n++;
  }
  return n === 0 ? null : sum / n;
}

/* ─────────────────────────── Starting scores ─────────────────────────── */

/**
 * Starting scores as authored in a scenario: one matrix per knowledge type,
 * `rows` arrays of `cols` numbers, top row first. E.g. `{"Ka": [[3, 5, …], …]}`.
 */
export const ScoreMatricesSchema = z
  .record(z.string(), z.array(z.array(z.number())))
  .describe("Starting score per knowledge type: rows (top first) of column values (A first)");
export type ScoreMatrices = z.infer<typeof ScoreMatricesSchema>;

/** Turn the per-knowledge-type matrices of a scenario into scores per sub-square (throws on a size mismatch). */
export function scoresFromMatrices(board: Board, matrices: ScoreMatrices): Scores {
  const out: Scores = {};
  for (const k of K_LABELS) {
    const m = matrices[k];
    if (!m) throw new Error(`Starting scores: no matrix for ${k}`);
    if (m.length !== board.rows)
      throw new Error(`Starting scores ${k}: ${m.length} rows, expected ${board.rows}`);
    m.forEach((rowValues, row) => {
      if (rowValues.length !== board.cols)
        throw new Error(
          `Starting scores ${k} row ${row + 1}: ${rowValues.length} values, expected ${board.cols}`,
        );
      rowValues.forEach((v, col) => {
        out[cellId(squareId(col, row), k)] = v;
      });
    });
  }
  for (const k of Object.keys(matrices)) {
    if (!(K_LABELS as readonly string[]).includes(k))
      throw new Error(`Starting scores: unknown knowledge type '${k}'`);
  }
  return out;
}
