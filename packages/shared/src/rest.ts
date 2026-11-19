import type { AudioFilesRemoved, ErasureRows, SessionDeletionRows } from "./audio";

/* Responses of the facilitator's database routes (types only: the server builds them, the client reads them). */

/** GET /api/sessions (each row also carries `players`: which database it is in) */
export interface SessionSummary {
  id: string;
  createdWall: string;
  updatedWall: string;
  scenarioId: string;
  scenarioVersion: string;
  status: string;
  tags: string[];
  notes: string;
  eventCount: number;
  telemetryCount: number;
  /** Seats bound to fake players (test clients the server created) at the end of the log; [] = none. */
  fakeSeats: number[];
  /** Audio tracks whose audio is still stored (tracks whose raw audio was deleted are not counted). */
  audioTracks: number;
  /** Recorded duration of those tracks, in ms (samples received / sample rate). */
  audioMs: number;
}

export type ExportKind = "standard" | "anonymised";

/** POST /api/sessions/:id/export and /anonymise */
export interface SessionExportResult {
  exportId: string;
  kind: ExportKind;
  sessionId: string;
  dir: string;
  files: Array<{ name: string; rows: number; sha256: string }>;
  participants: number;
}

/** Kinds in the export register: the two CSV exports and the separate "Export audio" action. */
export type RegisteredExportKind = ExportKind | "audio";

/** An export register entry (GET /api/exports adds `details`, `files` and `players`). */
export interface ExportRow {
  id: string;
  sessionId: string;
  kind: RegisteredExportKind;
  createdWall: string;
  path: string;
}

/** Where a participant code occurs in one session. */
export interface CodeOccurrence {
  sessionId: string;
  seat: number | null;
  events: number;
  telemetry: number;
  /** Track rows carrying the code (including the metadata kept after a raw-audio deletion). */
  audioTracks: number;
  /** Their recorded duration, in ms. */
  audioMs: number;
}

/** GET /api/participants/:code */
export interface LookupResult {
  code: string;
  occurrences: CodeOccurrence[];
  /** Exports whose register entry holds the code (by hash): delete them on every copy. */
  exports: ExportRow[];
  previouslyErased: Array<{ executedWall: string }>;
}

/** POST /api/participants/:code/erase */
export interface ErasureResult extends LookupResult {
  erased: boolean;
  rows: ErasureRows;
  /** Encrypted audio files unlinked after the commit. */
  audioFiles: AudioFilesRemoved;
}

/** GET /api/erasures (one entry) */
export interface ErasureEntry {
  id: number;
  codeSha256: string;
  requestedWall: string;
  executedWall: string;
  sessions: Array<{ sessionId: string; seat: number | null }>;
  /**
   * Rows deleted, and `audioFiles`: encrypted audio files whose keys were deleted (crypto-shredded),
   * which are then unlinked. Audio counts are 0 for entries made before audio existed.
   */
  rows: ErasureRows & { audioFiles: number };
  note: string;
}

/** GET /api/session-deletions (one entry; each also carries `players`) */
export interface SessionDeletionEntry {
  id: number;
  sessionId: string;
  deletedWall: string;
  createdWall: string;
  /** Row counts (audio counts are 0 for entries made before audio existed). */
  rows: SessionDeletionRows;
  participants: number;
  note: string;
}
