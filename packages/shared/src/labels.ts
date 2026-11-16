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
