/**
 * Live audio ingest of one session: `audio:start`, `audio:chunk` and `audio:stop` of the seats'
 * browsers, and the server-side closing of tracks (disconnect, withdrawal, mic check skipped,
 * recording paused, game complete, session closed or aborted, recovery after a restart).
 *
 * Owned by the SessionManager; every event goes through its `append`, inside a command (`run`).
 *
 * ## What is stored, and when
 *
 * A track (one continuous capture run of one seat) is opened only while the seat should record
 * (`shouldRecord`): a real participant who gave the audio consent item, every seat done with
 * consent, mic check reached and not skipped, recording not paused, game not complete, in the
 * participant database (simulated sessions, fake players and agents never record).
 *
 * A chunk is stored when:
 *  1. its track belongs to this session and seat and its raw audio was not deleted;
 *  2. it is not stored yet: a resend of a stored (trackId, seq) is acknowledged again, unchanged;
 *  3. the seat may be recorded at all: audio session, real participant with audio consent, not
 *     withdrawn, mic check not skipped, session not closed or aborted;
 *  4. its track is open, or was closed less than AUDIO_LATE_CHUNK_GRACE_MS (35 min) ago, counted
 *     from the close or from the previous late chunk of that track. This is the reconnect rule:
 *     the server closes a seat's track when its browser disconnects (and on a pause, at game end,
 *     after a restart); the browser keeps unacknowledged chunks in memory and resends them, oldest
 *     first, when it is back, and then starts a new track ("reconnect"). The same holds for a
 *     track the browser stopped itself, so a resend after a lost ack is never lost;
 *  5. it was not captured while recording was paused or after the game was complete: a chunk that
 *     STARTS in such a stretch is refused; one that starts before it and runs into it is cut at its
 *     start (only the samples before it are stored). This is the pause handshake: chunks in flight
 *     when the facilitator pauses are kept up to the pause, nothing after it.
 *
 * Acks (`AudioAck`): ok (also for a duplicate), or a refusal that is permanent (`retry: false`:
 * the browser drops the item) or transient (`retry: true`: storage error; it sends it again).
 *
 * The chunk is appended to the encrypted file first and then recorded in `audio_chunks` (which
 * also deduplicates). A crash in between leaves a record in the file without a row; the resend
 * appends it again and the reader keeps the first copy per seq, so nothing is lost or doubled.
 */
import {
  AUDIO_LATE_CHUNK_GRACE_MS,
  AUDIO_MAX_CHUNK_SAMPLES,
  AUDIO_SAMPLE_RATE,
  type AudioAck,
  type AudioChunk,
  type AudioStart,
  type AudioStop,
  type AudioStopReason,
  type NewEvent,
  NOT_RECORDING_REASON_DEFS,
  type ReadonlyGameState,
  recordingVerdict,
  type StoredEvent,
  samplesToMs,
} from "@wkwa/shared";
import type { Logger } from "pino";
import type { z } from "zod";
import type { AudioTrackRow, Store } from "../db/store";
import { CALIBRATION_MARGIN_MS, CalibrationCollector } from "./calibration";

/** A chunk may claim to be captured at most this far in the future (server clock; ms). */
const FUTURE_TOLERANCE_MS = 5000;
/** Longest track the server accepts (samples; 24 h). */
const MAX_TRACK_SAMPLES = 24 * 3600 * AUDIO_SAMPLE_RATE;

/** Validated messages (the hub parses them with the shared schemas first). */
export type AudioStartMsg = Pick<
  z.output<typeof AudioStart>,
  "trackId" | "reason" | "sampleRate" | "settings" | "clientTs" | "clockOffsetMs"
>;
export type AudioChunkMsg = z.output<typeof AudioChunk>;
export type AudioStopMsg = Pick<z.output<typeof AudioStop>, "trackId" | "reason" | "droppedChunks">;

/** Per-seat figures for the facilitator's LIVE mic column. */
export interface SeatAudioStats {
  tracks: number;
  recordedMs: number;
  lastChunkServerTs: number | null;
}

export interface LiveAudioDeps {
  sessionId: string;
  store: Store;
  clock: () => number;
  log: Logger;
  state: () => ReadonlyGameState;
  /** Append an event (only inside `run`). */
  append: (ev: NewEvent) => StoredEvent;
  /** Run a command: events appended inside are delivered as one batch. */
  run: <T>(fn: () => T) => T;
  isFinal: () => boolean;
}

type ChunkAck = AudioAck<{ trackId: string; seq: number }>;

const reject = (error: string): { ok: false; error: string; retry: false } => ({
  ok: false,
  error,
  retry: false,
});
const retry = (error: string): { ok: false; error: string; retry: true } => ({
  ok: false,
  error,
  retry: true,
});

function toBuffer(v: ArrayBuffer | ArrayBufferView): Buffer {
  if (v instanceof ArrayBuffer) return Buffer.from(v);
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

export class LiveAudio {
  /** Requests being processed, so a resend that arrives meanwhile waits for the same result. */
  private inflight = new Map<string, Promise<AudioAck<unknown>>>();
  /** Server time of the last late chunk accepted per closed track (the grace period runs from it). */
  private lastLate = new Map<string, number>();
  private stats = new Map<number, SeatAudioStats>();
  /** Row and file key of each open track, read once on its first chunk (dropped when it closes). */
  private openTracks = new Map<string, { row: AudioTrackRow; key: Buffer }>();
  private collector: CalibrationCollector | null = null;

  constructor(private readonly deps: LiveAudioDeps) {}

  private get state() {
    return this.deps.state();
  }

  /* ═════════════════════════ events and recovery ═════════════════════════ */

  /**
   * Close the tracks an event appended live ends (inside its command). The pauses and the end of
   * the game that limit which audio is stored are derived from the log by the reducer
   * (`state.audio.pauses`, `gameCompleteTs`); a session loaded from its log uses `recover()`.
   */
  observe(ev: StoredEvent) {
    switch (ev.type) {
      case "RecordingPaused":
        this.closeAll("paused");
        break;
      case "GameCompleted":
        this.closeAll("game_complete");
        break;
      case "ParticipantWithdrawn":
        this.closeSeat(ev.payload.seat, "withdrawn");
        break;
      case "MicCheckSkipped":
        this.closeSeat(ev.payload.seat, "skipped");
        break;
      case "PlayerDisconnected":
        this.closeSeat(ev.payload.seat, "disconnect");
        break;
      default:
        break;
    }
  }

  /**
   * The session is about to be closed or aborted (inside that command, before its final event is
   * appended): close every open track now, so each AudioTrackStopped is logged before
   * SessionClosed / SessionAborted. After the final event no event may be appended any more.
   */
  beforeFinal(reason: "closed" | "aborted") {
    this.closeAll(reason);
  }

  /**
   * After loading the session from its log (server restart, resume): close the tracks still open,
   * as `interrupted`. Browsers that reconnect resend their unacknowledged chunks; the grace period
   * accepts them. A closed or aborted session gets no new events: the rows are closed only.
   */
  recover() {
    const open = this.deps.store.listAudioTracks(this.deps.sessionId, { status: "recording" });
    for (const t of open) {
      if (this.deps.isFinal()) {
        this.openTracks.delete(t.trackId);
        this.deps.store.closeAudioTrack(t.trackId, {
          closedServerTs: this.deps.clock(),
          stopReason: "interrupted",
        });
      } else this.closeTrack(t, "interrupted", "system");
    }
    for (const t of this.deps.store.listAudioTracks(this.deps.sessionId)) {
      if (t.status === "deleted") continue;
      const s = this.seatStats(t.seat);
      s.tracks++;
      s.recordedMs += t.durationMs;
    }
  }

  /** Figures of one seat for LIVE. */
  seatStats(seat: number): SeatAudioStats {
    let s = this.stats.get(seat);
    if (!s) {
      s = { tracks: 0, recordedMs: 0, lastChunkServerTs: null };
      this.stats.set(seat, s);
    }
    return s;
  }

  /* ═════════════════════════ gates ═════════════════════════ */

  /**
   * Why this seat may not upload audio now (null = it may): its recording verdict (a chunk of a
   * track that already ran passes the reasons with `lateChunks`; its pauses are cut per chunk)
   * and what only the server knows. The hub also drops the LIVE meter readings (`audio:level`)
   * of a seat refused here. `start`: a new track, which needs the verdict to say record.
   */
  refusal(seat: number, start = false): string | null {
    if (!this.deps.store.audioFiles) return "This database does not record audio";
    if (this.deps.isFinal()) return "The session has ended";
    const s = this.state.seats[seat];
    if (!s) return "This seat is not recorded";
    const v = recordingVerdict(this.state, s);
    const def = v.record ? null : NOT_RECORDING_REASON_DEFS[v.reason];
    if (def && (start || !def.lateChunks)) return def.refusal;
    return s.participantCode ? null : "This seat has no participant code";
  }

  /**
   * How many samples of a chunk captured from `clientTs` may be stored: all, fewer (it runs into a
   * no-record stretch), or 0 (it starts in one).
   */
  private keepSamples(clientTs: number, sampleCount: number): number {
    const endTs = clientTs + samplesToMs(sampleCount);
    let keep = sampleCount;
    const { pauses, gameCompleteTs } = this.state.audio;
    const windows = [...pauses];
    if (gameCompleteTs !== null) windows.push({ fromTs: gameCompleteTs, toTs: null });
    for (const w of windows) {
      const to = w.toTs ?? Number.POSITIVE_INFINITY;
      if (to <= clientTs || w.fromTs >= endTs) continue;
      if (w.fromTs <= clientTs) return 0;
      keep = Math.min(keep, Math.floor(((w.fromTs - clientTs) * AUDIO_SAMPLE_RATE) / 1000));
    }
    return Math.max(0, keep);
  }

  /** Coalesce concurrent copies of one request (a resend while the first is still being written). */
  private once<T extends AudioAck<unknown>>(key: string, fn: () => Promise<T>): Promise<T> {
    const running = this.inflight.get(key);
    if (running) return running as Promise<T>;
    const p = fn().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  /* ═════════════════════════ audio:start ═════════════════════════ */

  start(seat: number, msg: AudioStartMsg): Promise<AudioAck> {
    return this.once(`start:${msg.trackId}`, () => this.doStart(seat, msg));
  }

  private async doStart(seat: number, msg: AudioStartMsg): Promise<AudioAck> {
    const { store, sessionId } = this.deps;
    const existing = store.getAudioTrack(msg.trackId);
    if (existing) {
      // the ack of an earlier copy got lost: the same start again is fine
      if (existing.sessionId === sessionId && existing.seat === seat && existing.status === "recording")
        return { ok: true, duplicate: true };
      return reject("This track id is already used");
    }
    const why = this.refusal(seat, true);
    if (why) return reject(why);
    const files = store.requireAudioFiles(); // refusal() refused already when there is none
    let file: { fileName: string; key: Buffer };
    try {
      file = await files.createFile(sessionId);
    } catch (e) {
      this.deps.log.error({ err: e, sessionId, seat }, "could not create an audio file");
      return retry("Could not store the audio");
    }
    // the state may have changed while the file was created
    const late =
      this.refusal(seat, true) ?? (store.getAudioTrack(msg.trackId) ? "Track id already used" : null);
    const code = this.state.seats[seat]?.participantCode ?? null;
    if (late || !code) {
      files.deleteFile(sessionId, file.fileName);
      return reject(late ?? "This seat has no participant code");
    }
    this.deps.run(() => {
      // one seat records one track at a time: a track still open (another window, a lost stop) ends here
      for (const t of store.listAudioTracks(sessionId, { seat, status: "recording" }))
        this.closeTrack(t, "interrupted", "system");
      store.insertAudioTrack({
        trackId: msg.trackId,
        sessionId,
        seat,
        participantCode: code,
        fileName: file.fileName,
        fileKey: file.key,
        sampleRate: msg.sampleRate,
        settings: msg.settings,
        reason: msg.reason,
        startedServerTs: this.deps.clock(),
        startedClientTs: msg.clientTs,
        clockOffsetMs: msg.clockOffsetMs,
      });
      this.deps.append({
        type: "AudioTrackStarted",
        actorKind: "player",
        seat,
        participantCode: code,
        clientTs: msg.clientTs,
        payload: {
          trackId: msg.trackId,
          sampleRate: AUDIO_SAMPLE_RATE,
          settings: msg.settings,
          reason: msg.reason,
        },
      });
    });
    this.seatStats(seat).tracks++;
    return { ok: true };
  }

  /* ═════════════════════════ audio:chunk ═════════════════════════ */

  chunk(seat: number, msg: AudioChunkMsg): Promise<ChunkAck> {
    return this.once(`chunk:${msg.trackId}:${msg.seq}`, () => this.doChunk(seat, msg));
  }

  private async doChunk(seat: number, msg: AudioChunkMsg): Promise<ChunkAck> {
    const { store, sessionId } = this.deps;
    const data = { trackId: msg.trackId, seq: msg.seq };
    const { track, key } = this.trackOf(msg.trackId);
    if (!track || track.sessionId !== sessionId || track.seat !== seat) return reject("Unknown track");
    if (track.status === "deleted") return reject("The audio of this track was deleted");
    if (store.hasAudioChunk(msg.trackId, msg.seq)) return { ok: true, data, duplicate: true };
    const why = this.refusal(seat);
    if (why) return reject(why);
    const now = this.deps.clock();
    if (track.status !== "recording") {
      const since = Math.max(track.closedServerTs ?? now, this.lastLate.get(track.trackId) ?? 0);
      if (now - since > AUDIO_LATE_CHUNK_GRACE_MS) return reject("The track was closed too long ago");
    }
    // sanity: each earlier chunk holds at most AUDIO_MAX_CHUNK_SAMPLES samples
    if (msg.startSample > msg.seq * AUDIO_MAX_CHUNK_SAMPLES) return reject("startSample does not fit seq");
    if (msg.startSample + msg.sampleCount > MAX_TRACK_SAMPLES) return reject("The track is too long");
    if (msg.clientTs > now + FUTURE_TOLERANCE_MS) return reject("clientTs lies in the future");
    const keep = this.keepSamples(msg.clientTs, msg.sampleCount);
    if (keep <= 0)
      return reject("Recording was paused or the game was complete when this audio was captured");
    const pcm = toBuffer(msg.pcm).subarray(0, keep * 2);
    if (!key || !track.fileName) return reject("The audio of this track was deleted");
    try {
      await store.requireAudioFiles().appendRecord(sessionId, track.fileName, key, msg.seq, pcm);
    } catch (e) {
      this.deps.log.error({ err: e, sessionId, seat, seq: msg.seq }, "could not store an audio chunk");
      return retry("Could not store the audio");
    }
    // the seat may have withdrawn (or the session ended) while the chunk was written: then it does not count
    const after = this.refusal(seat);
    if (after) return reject(after);
    const st = this.state;
    const serverTs = this.deps.clock();
    let inserted: boolean;
    try {
      inserted = store.insertAudioChunk({
        trackId: msg.trackId,
        seq: msg.seq,
        startSample: msg.startSample,
        sampleCount: keep,
        clientTs: msg.clientTs,
        clockOffsetMs: msg.clockOffsetMs,
        serverTs,
        round: st.round,
        phase: st.phase,
        rmsDb: msg.rmsDb,
        peakDb: msg.peakDb,
        clipped: Math.min(msg.clippedSamples, keep),
      });
    } catch (e) {
      // the track's raw audio was deleted meanwhile (erasure)
      this.openTracks.delete(msg.trackId);
      this.deps.log.warn({ err: e, sessionId, seat }, "audio chunk for a deleted track");
      return reject("The audio of this track was deleted");
    }
    if (inserted) {
      if (track.status !== "recording") this.lastLate.set(track.trackId, serverTs);
      const s = this.seatStats(seat);
      s.recordedMs += samplesToMs(keep);
      s.lastChunkServerTs = serverTs;
      this.collector?.add(
        seat,
        msg.trackId,
        { seq: msg.seq, startSample: msg.startSample, sampleCount: keep, clientTs: msg.clientTs, serverTs },
        pcm,
      );
    }
    return { ok: true, data, duplicate: !inserted };
  }

  /**
   * A track's row and file key: from the cache while it is open, else read (a closed track's late
   * chunks are rare). Only an open track is cached, so its status in the cache is always current.
   */
  private trackOf(trackId: string): { track: AudioTrackRow | undefined; key: Buffer | null } {
    const cached = this.openTracks.get(trackId);
    if (cached) return { track: cached.row, key: cached.key };
    const { store } = this.deps;
    const track = store.getAudioTrack(trackId);
    const key = track ? store.getAudioTrackKey(trackId) : null;
    if (track?.status === "recording" && key) this.openTracks.set(trackId, { row: track, key });
    return { track, key };
  }

  /* ═════════════════════════ audio:stop and server-side closes ═════════════════════════ */

  /** The browser stopped a track. Always accepted for the seat's own tracks (closing never records anything). */
  stop(seat: number, msg: AudioStopMsg): AudioAck {
    const { store, sessionId } = this.deps;
    const track = store.getAudioTrack(msg.trackId);
    if (!track || track.sessionId !== sessionId || track.seat !== seat) return reject("Unknown track");
    if (track.status === "recording") {
      if (this.deps.isFinal()) {
        this.openTracks.delete(track.trackId);
        store.closeAudioTrack(track.trackId, {
          closedServerTs: this.deps.clock(),
          stopReason: msg.reason,
          droppedChunks: msg.droppedChunks,
        });
      } else this.deps.run(() => this.closeTrack(track, msg.reason, "player", msg.droppedChunks));
    } else if (track.status === "closed" && msg.droppedChunks > track.droppedChunks) {
      // closed by the server before the browser said how many chunks it lost
      store.addDroppedAudioChunks(track.trackId, msg.droppedChunks - track.droppedChunks);
    }
    return { ok: true };
  }

  /** Close one open track and log AudioTrackStopped (inside a command). */
  private closeTrack(
    track: AudioTrackRow,
    reason: AudioStopReason,
    actor: "player" | "system",
    droppedChunks = 0,
  ) {
    const { store } = this.deps;
    this.openTracks.delete(track.trackId);
    const closed = store.closeAudioTrack(track.trackId, {
      closedServerTs: this.deps.clock(),
      stopReason: reason,
      droppedChunks,
    });
    if (!closed) return;
    const row = store.getAudioTrack(track.trackId) ?? track;
    this.deps.append({
      type: "AudioTrackStopped",
      actorKind: actor,
      seat: track.seat,
      participantCode: this.state.seats[track.seat]?.participantCode ?? track.participantCode,
      payload: {
        trackId: track.trackId,
        reason,
        samples: row.samples,
        chunks: row.chunks,
        droppedChunks: row.droppedChunks,
      },
    });
  }

  /** Close the open tracks of one seat (inside a command). */
  private closeSeat(seat: number, reason: AudioStopReason) {
    for (const t of this.deps.store.listAudioTracks(this.deps.sessionId, { seat, status: "recording" }))
      this.closeTrack(t, reason, "system");
  }

  /** Close every open track of the session (inside a command). */
  closeAll(reason: AudioStopReason) {
    for (const t of this.deps.store.listAudioTracks(this.deps.sessionId, { status: "recording" }))
      this.closeTrack(t, reason, "system");
  }

  /* ═════════════════════════ calibration ═════════════════════════ */

  /**
   * Start keeping the audio of a calibration run in memory, from just before its first turn until
   * its check ran (replaces an earlier run's).
   */
  beginCalibration(run: number, seats: readonly number[], firstTurnTs: number) {
    this.collector = new CalibrationCollector(run, seats, firstTurnTs - CALIBRATION_MARGIN_MS);
  }

  /** The collector of the given run (null if another run replaced it or it ended). */
  calibration(run: number): CalibrationCollector | null {
    return this.collector?.run === run ? this.collector : null;
  }

  /** Drop the collected calibration audio. */
  endCalibration(run?: number) {
    if (run === undefined || this.collector?.run === run) this.collector = null;
  }
}
