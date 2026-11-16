import type { z } from "zod";

/**
 * Documentation metadata attached to every logged record type.
 * This is the single source of truth for docs/DATA-TYPES.md and for the
 * per-export codebook.md — edit it here, then run `npm run docs:generate`.
 */
export type Actor = "player" | "facilitator" | "system";

/**
 * Personal-data class (GDPR):
 *  - `non-personal`: cannot relate to a participant (e.g. session config).
 *  - `pseudonymous`: linked to a participant code → personal data under GDPR
 *    until the key sheet is destroyed.
 *  - `pseudonymous-sensitive`: as above but deserves extra care
 *    (demographics, consent answers).
 */
export type DataClass = "non-personal" | "pseudonymous" | "pseudonymous-sensitive";

export interface RecordMeta<P extends z.ZodType = z.ZodType> {
  summary: string;
  trigger: string;
  actors: Actor[];
  changesState: boolean;
  visibleTo: string;
  dataClass: DataClass;
  frequency: string;
  payload: P;
  example: z.input<P>;
}

export function defineRecord<P extends z.ZodType>(meta: RecordMeta<P>): RecordMeta<P> {
  return meta;
}
