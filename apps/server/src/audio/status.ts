import type { AudioTrackStatus } from "@wkwa/shared";
import type { AudioTrackRow } from "../db/store";

/**
 * Stop reasons of a track that did not end cleanly: the server closed it because the browser went
 * away (disconnect) or because it was still open when the session was loaded again (interrupted,
 * e.g. after a restart). Shown as status `interrupted`.
 */
const INTERRUPTED_STOP_REASONS: ReadonlySet<string> = new Set(["disconnect", "interrupted"]);

/**
 * Status of a stored track as the shared contract names it (`AudioTrackSummary.status`), from the
 * database row (`audio_tracks.status` is recording | closed | deleted):
 * recording → open, deleted → deleted, closed → interrupted when it stopped because of a
 * disconnect or was found open on recovery, else closed.
 */
export function trackStatusOf(row: Pick<AudioTrackRow, "status" | "stopReason">): AudioTrackStatus {
  if (row.status === "recording") return "open";
  if (row.status === "deleted") return "deleted";
  return row.stopReason !== null && INTERRUPTED_STOP_REASONS.has(row.stopReason) ? "interrupted" : "closed";
}
