import type { AudioDeleteResult, AudioDeletionCounts, AudioDeletionScope } from "@wkwa/shared";
import { fileBytes, isAudioDerivativeKind } from "../audio/records";
import { compactAfterDelete } from "../db/database";
import type { AudioDeletionRow, AudioTrackRowStatus, Store } from "../db/store";
import { nowTs, wall } from "../runtime";
import { unlinkAudioFiles } from "./erase";

/** Refused because the session is attached and still running. REST routes answer 409. */
export class SessionRunningError extends Error {
  readonly statusCode = 409;
  constructor(message = "This session is still running. Close or abort it first, then delete its audio.") {
    super(message);
  }
}

/** What deleteSessionAudio needs to know about the server's attached session (the Hub fits). */
export interface ActiveSessionProbe {
  readonly session: {
    readonly sessionId: string;
    readonly isFinal: boolean;
    readonly state: { readonly phase: string };
  } | null;
}

/** Same rule as the delete-session and erase routes: attached, not final, not game_complete. */
export function isSessionRunning(hub: ActiveSessionProbe | undefined, sessionId: string): boolean {
  const s = hub?.session;
  return Boolean(s && s.sessionId === sessionId && !s.isFinal && s.state.phase !== "game_complete");
}

/** What deleteSessionAudio did (the REST result adds the register entry as `record`). */
export interface AudioDeletionResult extends Omit<AudioDeleteResult, "record" | "audioExportsOnDisk"> {
  /** The register entry (audio_deletions). */
  entry: AudioDeletionRow;
}

/**
 * Delete a session's audio and record it in the `audio_deletions` register.
 *
 *  - `raw`: delete the raw tracks' files and keys (crypto-shredding) but keep
 *    the track rows as `status = 'deleted'` with their timing metadata, and
 *    keep the chunk rows (times, levels): speaking-time analysis still works.
 *    Derivatives that hold sound (isAudioDerivativeKind: cleaned and aligned
 *    tracks) are deleted too; the others (speech segments, transcripts, …) stay.
 *  - `all`: delete every audio row of the session (tracks, chunks,
 *    derivatives, jobs) and its whole audio folder.
 *
 * Refused (SessionRunningError) while the session is attached and running.
 * The CLI passes no hub: it warns instead, like delete-session and erase.
 * Then checkpoint + VACUUM, and unlink the files after the commit.
 * Audio exists only in the participant database: pass the participant store.
 */
export function deleteSessionAudio(
  ctx: { store: Store; hub?: ActiveSessionProbe },
  sessionId: string,
  opts: { scope: AudioDeletionScope; note?: string },
): AudioDeletionResult {
  const { store } = ctx;
  const { scope } = opts;
  if (scope !== "raw" && scope !== "all") throw new Error(`Unknown scope '${String(scope)}' (raw or all)`);
  if (!store.getSession(sessionId)) throw new Error(`Unknown session ${sessionId}`);
  if (isSessionRunning(ctx.hub, sessionId)) throw new SessionRunningError();
  const db = store.db;
  const requestedWall = wall(nowTs());
  const counts: AudioDeletionCounts = {
    tracks: 0,
    audioMs: 0,
    chunks: 0,
    derivatives: 0,
    jobs: 0,
    files: 0,
    bytes: 0,
    seatMask: 0,
  };
  const files: Array<{ sessionId: string; fileName: string }> = [];
  let entry!: AudioDeletionRow;

  db.transaction(() => {
    const tracks = (
      db
        .prepare(
          "SELECT track_id, seat, file_name, samples, sample_rate, status FROM audio_tracks WHERE session_id = ?",
        )
        .all(sessionId) as Array<{
        track_id: string;
        seat: number;
        file_name: string | null;
        samples: number;
        sample_rate: number;
        status: AudioTrackRowStatus;
      }>
    ).filter((t) => scope === "all" || t.status !== "deleted");
    const derived = (
      db
        .prepare("SELECT derivative_id, seat, kind, file_name FROM audio_derivatives WHERE session_id = ?")
        .all(sessionId) as Array<{
        derivative_id: string;
        seat: number | null;
        kind: string;
        file_name: string | null;
      }>
    ).filter((d) => scope === "all" || isAudioDerivativeKind(d.kind));

    for (const t of tracks) {
      if (t.seat > 0 && t.seat < 31) counts.seatMask |= 1 << t.seat;
      counts.audioMs += t.sample_rate > 0 ? (t.samples * 1000) / t.sample_rate : 0;
      if (t.file_name && t.status !== "deleted") files.push({ sessionId, fileName: t.file_name });
    }
    for (const d of derived) {
      if (d.seat !== null && d.seat > 0 && d.seat < 31) counts.seatMask |= 1 << d.seat;
      if (d.file_name) files.push({ sessionId, fileName: d.file_name });
    }
    if (scope === "all") Object.assign(counts, store.deleteSessionAudioRows(sessionId));
    else {
      for (const t of tracks)
        counts.tracks += db
          .prepare("UPDATE audio_tracks SET status = 'deleted', file_key = NULL WHERE track_id = ?")
          .run(t.track_id).changes;
      for (const d of derived)
        counts.derivatives += db
          .prepare("DELETE FROM audio_derivatives WHERE derivative_id = ?")
          .run(d.derivative_id).changes;
    }
    counts.audioMs = Math.round(counts.audioMs);
    counts.files = files.length;
    counts.bytes = files.reduce((n, f) => n + fileBytes(store, f.sessionId, f.fileName), 0);
    entry = store.insertAudioDeletion({
      sessionId,
      scope,
      requestedWall,
      executedWall: wall(nowTs()),
      counts: { ...counts },
      note: opts.note ?? "",
    });
  })();
  compactAfterDelete(db);

  const removed = unlinkAudioFiles(store, files);
  let dirRemoved = false;
  if (scope === "all" && store.audioFiles) {
    try {
      dirRemoved = store.audioFiles.deleteSessionDir(sessionId).removed;
    } catch (e) {
      removed.failed.push(`${sessionId}/ (${(e as Error).message})`);
    }
  }
  return { sessionId, scope, counts, audioFiles: { ...removed, dirRemoved }, entry };
}
