import { z } from "zod";

/** Knowledge-type labels. Each seat receives exactly one (unique by default). */
export const K_LABELS = ["Ka", "Kb", "Kc", "Kd"] as const;
/** Power-type labels. Each seat receives exactly one (unique by default). */
export const P_LABELS = ["Pa", "Pb", "Pc", "Pd"] as const;
/** Seats are numbered 1..MAX_SEATS. */
export const MAX_SEATS = 4;
export const SEATS = [1, 2, 3, 4] as const;

export type KLabel = (typeof K_LABELS)[number];
export type PLabel = (typeof P_LABELS)[number];
export type Seat = number;

export const KLabelSchema = z.enum(K_LABELS).describe("Knowledge-type label (Ka–Kd)");
export const PLabelSchema = z.enum(P_LABELS).describe("Power-type label (Pa–Pd)");
export const SeatSchema = z
  .number()
  .int()
  .min(1)
  .max(MAX_SEATS)
  .describe("Seat number (1–4) within the session");
export const ViewIdSchema = z
  .string()
  .min(1)
  .describe("Id of the map view (dataset) shown to a seat, e.g. 'Ka'");

/** Distinct, colour-blind-friendly seat colours (Okabe–Ito palette). */
export const SEAT_COLOURS: Record<number, string> = {
  1: "#E69F00",
  2: "#56B4E9",
  3: "#009E73",
  4: "#CC79A7",
};

/** Interaction kinds a player can perform on a region. */
export const ACTION_KINDS = ["propose", "decide"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];
export const ActionKindSchema = z.enum(ACTION_KINDS).describe("Map interaction: 'propose' or 'decide'");

/* ═══════════════════════════════════════════════════════════════════════════
 * K–P PAIRINGS
 *
 * A pairing says which power type goes with which knowledge type: P = pairing(K).
 * Only two kinds are allowed:
 *
 *  - ALIGNED:      Ka–Pa, Kb–Pb, Kc–Pc, Kd–Pd.
 *  - DISSOCIATED:  fully dissociative — no seat holds the same letter for K and P
 *                  (no fixed point) AND no two seats mirror each other
 *                  (no "player pair" Ka–Pd + Kd–Pa, i.e. no 2-cycle). In
 *                  permutation terms these are exactly the 4-cycles of {a,b,c,d}:
 *                  there are 3! = 6 of them, numbered D1–D6 (lexicographic order
 *                  of the P letters for Ka, Kb, Kc, Kd).
 *
 * The full table is in docs/DATA-TYPES.md § Label pairings (generated from
 * DISSOCIATED_PAIRINGS below).
 * ═══════════════════════════════════════════════════════════════════════════ */

export type PairingMode = "aligned" | "dissociated";

/** Pairing as stored with every LabelsAssigned event. id: null for aligned, 1–6 for dissociated. */
export const LabelPairingSchema = z
  .object({
    mode: z.enum(["aligned", "dissociated"]).describe("aligned (Ka–Pa …) or fully dissociated"),
    id: z
      .number()
      .int()
      .min(1)
      .max(6)
      .nullable()
      .describe("Number (1–6) of the fully dissociative pairing in the pairing table; null when aligned"),
  })
  .describe("K–P pairing used for this label assignment");
export type LabelPairing = z.infer<typeof LabelPairingSchema>;

/** perm[i] = index of the P label paired with K label i. */
type Perm = readonly number[];

function permutations(n: number): number[][] {
  if (n === 1) return [[0]];
  const out: number[][] = [];
  for (const p of permutations(n - 1)) {
    for (let i = 0; i <= p.length; i++) out.push([...p.slice(0, i), n - 1, ...p.slice(i)]);
  }
  return out;
}

/** True if the permutation is one single cycle through all elements (no fixed points, no pairs, no sub-loops). */
export function isFullCycle(perm: Perm): boolean {
  let i = 0;
  let steps = 0;
  do {
    i = perm[i]!;
    steps++;
  } while (i !== 0 && steps <= perm.length);
  return i === 0 && steps === perm.length;
}

export const ALIGNED_PAIRING: Perm = [0, 1, 2, 3];

/** The six fully dissociative pairings, D1–D6 (index 0 = D1). */
export const DISSOCIATED_PAIRINGS: readonly Perm[] = permutations(K_LABELS.length)
  .filter(isFullCycle)
  .sort((a, b) => a.join("").localeCompare(b.join("")));

export function pairingPerm(p: LabelPairing): Perm {
  if (p.mode === "aligned") return ALIGNED_PAIRING;
  const perm = p.id ? DISSOCIATED_PAIRINGS[p.id - 1] : undefined;
  if (!perm) throw new Error(`Unknown dissociated pairing ${p.id}`);
  return perm;
}

/** The P label paired with a K label under a pairing. */
export function pairedP(k: KLabel, p: LabelPairing): PLabel {
  return P_LABELS[pairingPerm(p)[K_LABELS.indexOf(k)]!]!;
}

/** Short name: "aligned" or "D1"…"D6". */
export function pairingName(p: LabelPairing | null | undefined): string {
  if (!p) return "—";
  return p.mode === "aligned" ? "aligned" : `D${p.id}`;
}

/** e.g. "Ka–Pd Kb–Pc Kc–Pa Kd–Pb" */
export function pairingText(p: LabelPairing): string {
  return K_LABELS.map((k) => `${k}–${pairedP(k, p)}`).join(" ");
}
