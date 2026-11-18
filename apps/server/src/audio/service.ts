/**
 * Post-session audio processing for the facilitator DATABASE tab.
 *
 *  - `summary`: tracks, derived files, jobs, the deletion register and audio exports of a session.
 *  - `startAttribution`: queue a speaker-attribution job (worker thread, see ./jobs.ts). It reads
 *    the raw tracks, compares the seats' loudness (never voice identity), and stores the results
 *    as derivatives: per seat `speech_segments` (JSON) and a `clean` track (a new encrypted
 *    `.wka` file with its own key), and per session `talk_time`, `quality_report` and
 *    `leakage_matrix` (JSON). A re-run replaces the previous run's derivatives.
 *  - `speechSegments`: who spoke when, as JSON (timing only, never audio).
 *  - `exportAudio`: the ONLY way audio leaves the encrypted store: per-seat WAVs written to the
 *    exports folder, with a manifest, recorded in the export register (who, when, what, SHA-256
 *    of every file). File names hold the session id and seat number, never a participant code.
 *  - `deleteAudio`: "delete raw audio" / "delete all audio" with a typed confirmation.
 *
 * Raw audio is never modified. Audio exists only in the participant database.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import {
  type AttributionJob,
  type AttributionSummary,
  AUDIO_SAMPLE_RATE,
  type AudioDeletionRecord,
  type AudioExportKind,
  type AudioSessionSummary,
  applyEvent,
  audioExportFileName,
  initialState,
  randomCrockford,
  type StoredEvent,
} from "@wkwa/shared";
import type { Logger } from "pino";
import { sha256 } from "../content";
import type { AudioDeletionRow, AudioJobRow, AudioTrackRow, NewAudioDerivative, Store } from "../db/store";
import {
  type ActiveSessionProbe,
  type AudioDeletionResult,
  deleteSessionAudio,
  isSessionRunning,
  SessionRunningError,
} from "../gdpr/deleteAudio";
import { registerExport } from "../gdpr/exporter";
import { nowTs, wall } from "../runtime";
import {
  type AttributionOptions,
  type AttributionResult,
  type CalibrationTurn,
  type ChunkMeta,
  ENGINE_VERSION,
  fitClocks,
  HOP_MS,
  type PhaseChange,
  type RenderTiming,
  renderAligned,
  renderedSampleCount,
  type Timeline,
  type TrackAlignment,
  type TrackSource,
} from "./attribution";
import type { AudioReadIssue } from "./fileStore";
import { type AudioJobRunner, runInWorker, type TaskRunner } from "./jobs";
import {
  type AttributionTaskInput,
  type AttributionTaskOutput,
  describeIssues,
  int16Of,
  seqOrderedChunks,
} from "./jobWorker";
import {
  ATTRIBUTION_DERIVATIVE_KINDS,
  type CleanParams,
  derivativeSummary,
  type SeatAudioSummary,
  type SpeechSegmentRow,
  seatSummaries,
  speechSegmentsOf,
  trackViews,
} from "./records";
import { wavStream } from "./wav";

/** A refused request; REST routes answer with `statusCode`. */
export class AudioRequestError extends Error {
  constructor(
    readonly statusCode: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

export const CLEAN_ATTENUATION_DB = -30;
export const CLEAN_FADE_MS = 10;
const SEGMENT_KIND = "speech_segments";

/** The attribution summary of a job, plus the overall quality grade of the run. */
export type AttributionSummaryView = AttributionSummary & { grade: "good" | "fair" | "poor" };
export type AttributionJobView = Omit<AttributionJob, "summary"> & {
  sessionId: string;
  summary?: AttributionSummaryView;
};

export interface AudioExportEntry {
  exportId: string;
  createdWall: string;
  audioKind: AudioExportKind | "both" | null;
  seats: number[];
  files: number;
  /** Where the WAVs were written; `onDisk` = the folder still exists. */
  path: string;
  onDisk: boolean;
}

/** Everything the DATABASE tab shows about a session's audio (the shared summary plus per-seat totals). */
export type AudioSessionView = AudioSessionSummary & {
  jobs: AttributionJobView[];
  seats: SeatAudioSummary[];
  /** Summary of the latest finished attribution, or null. */
  attribution: (AttributionSummaryView & { jobId: string | null; createdServerTs: number }) | null;
  audioExports: AudioExportEntry[];
  /** True while the session runs: attribution, export and deletion wait until it has ended. */
  running: boolean;
};

export interface AudioExportFile {
  name: string;
  seat: number;
  kind: AudioExportKind;
  samples: number;
  durationMs: number;
  bytes: number;
  sha256: string;
}

export interface AudioExportResult {
  exportId: string;
  sessionId: string;
  dir: string;
  files: AudioExportFile[];
  /** `attribution` = the alignment of the latest attribution; `timestamps` = the chunks' timestamps only. */
  timing: "attribution" | "timestamps";
  /** Read problems (damaged or missing records play as silence), also in the manifest. */
  warnings: string[];
}

export interface AudioServiceDeps {
  /** The participant database (the only one with audio). */
  store: Store;
  hub?: ActiveSessionProbe;
  /** Where exports of the participant database go (WKWA_EXPORTS_DIR). */
  exportsDir: string;
  runner: AudioJobRunner;
  /** How the attribution task runs (default: a worker thread). */
  runTask?: TaskRunner;
  log?: Logger;
}

/* ─────────── helpers on the event log ─────────── */

export interface SessionTimeline {
  /** Turns of the last completed calibration (none if it was skipped, cancelled or never run). */
  calibration: CalibrationTurn[];
  phaseChanges: PhaseChange[];
  recordingPauses: Array<{ fromTs: number; toTs: number | null }>;
  /** Seats that permitted audio recording. */
  audioSeats: number[];
}

export function sessionTimeline(events: readonly StoredEvent[]): SessionTimeline {
  const state = initialState();
  const phaseChanges: PhaseChange[] = [];
  const recordingPauses: SessionTimeline["recordingPauses"] = [];
  let calibration: CalibrationTurn[] = [];
  let prev = "";
  for (const e of events) {
    applyEvent(state, e);
    if (e.type === "CalibrationStarted") calibration = [];
    else if (e.type === "CalibrationCompleted")
      calibration = e.payload.turns.map((t) => ({ seat: t.seat, startTs: t.startTs, endTs: t.endTs }));
    else if (e.type === "RecordingPaused") recordingPauses.push({ fromTs: e.serverTs, toTs: null });
    else if (e.type === "RecordingResumed") {
      const open = recordingPauses[recordingPauses.length - 1];
      if (open && open.toTs === null) open.toTs = e.serverTs;
    }
    const key = `${state.round}|${state.phase}|${state.paused}|${state.audio.recordingPaused}`;
    if (key !== prev) {
      phaseChanges.push({
        ts: e.serverTs,
        round: state.round,
        phase: state.phase,
        paused: state.paused,
        recordingPaused: state.audio.recordingPaused,
      });
      prev = key;
    }
  }
  const audioSeats = Object.values(state.seats)
    .filter((s) => s.audioConsent)
    .map((s) => s.seat);
  return { calibration, phaseChanges, recordingPauses, audioSeats };
}

/* ─────────── timing for rendering ─────────── */

interface StoredTiming {
  timeline: Timeline & { endTs?: number };
  alignment: TrackAlignment[];
}

/** Timing from the chunks' timestamps alone (no attribution yet): a clock fit per track, no offset refinement. */
export function timestampTiming(
  tracks: ReadonlyArray<{ trackId: string; seat: number; sampleRate: number; chunks: readonly ChunkMeta[] }>,
): StoredTiming | null {
  const { fits } = fitClocks(tracks.filter((t) => t.chunks.length > 0));
  if (fits.length === 0) return null;
  const alignment: TrackAlignment[] = fits.map((f) => {
    const t = tracks.find((x) => x.trackId === f.trackId)!;
    const samples = t.chunks.reduce((n, c) => Math.max(n, c.startSample + c.sampleCount), 0);
    return {
      trackId: f.trackId,
      seat: f.seat,
      startTs: f.startTs,
      offsetMs: 0,
      driftPpm: f.driftPpm,
      clockDriftPpm: f.driftPpm,
      msPerSample: f.msPerSample,
      samples,
      alignedStartTs: f.startTs,
      alignedEndTs: f.startTs + samples * f.msPerSample,
      confidence: 0,
      anchor: false,
      clockGroup: f.group,
      clockResidualMs: f.residualRmsMs,
      clockOutliers: f.outliers,
      lagObservations: 0,
      lagResidualMs: null,
    };
  });
  const t0 = Math.min(...alignment.map((a) => a.alignedStartTs));
  const end = Math.max(...alignment.map((a) => a.alignedEndTs));
  const frames = Math.max(1, Math.ceil((end - t0) / HOP_MS));
  return { timeline: { t0, hopMs: HOP_MS, frames, endTs: t0 + frames * HOP_MS }, alignment };
}

/* ─────────── reading audio for export ─────────── */

/** A track's PCM as render chunks, streamed in startSample order; read problems go to `onIssue`. */
function trackPcmChunks(store: Store, row: AudioTrackRow, key: Buffer, onIssue: (i: AudioReadIssue) => void) {
  const chunks = store.listAudioChunks(row.trackId);
  return seqOrderedChunks(store.audioFiles!, row.sessionId, row.fileName!, key, chunks, { onIssue });
}

/** Write header + samples to a new file, hashing as it goes. */
async function writeWavFile(
  file: string,
  blocks: AsyncIterable<Int16Array>,
  totalSamples: number,
): Promise<{ bytes: number; sha256: string }> {
  const fh = await open(file, "wx", 0o600);
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunk of wavStream(blocks, { sampleRate: AUDIO_SAMPLE_RATE }, totalSamples)) {
      let done = 0;
      while (done < chunk.byteLength) {
        const { bytesWritten } = await fh.write(chunk, done, chunk.byteLength - done, bytes + done);
        done += bytesWritten;
      }
      hash.update(chunk);
      bytes += chunk.byteLength;
    }
    await fh.sync();
  } finally {
    await fh.close();
  }
  return { bytes, sha256: hash.digest("hex") };
}

function exportIdOf(now: number): string {
  const d = new Date(now).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `AU-${d}-${randomCrockford(4)}`;
}

const round = (v: number, digits: number) => {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
};

/* ─────────── summaries ─────────── */

/** The REST summary of an attribution result. */
export function attributionSummaryOf(
  r: AttributionResult,
  extraWarnings: string[] = [],
): AttributionSummaryView {
  const perSeat = r.seats.map((seat) => {
    const own = r.alignment.filter((a) => a.seat === seat).sort((a, b) => b.samples - a.samples)[0];
    const q = r.quality.seats.find((s) => s.seat === seat);
    const cal = r.quality.calibration?.find((c) => c.seat === seat);
    return {
      seat,
      marginDb: cal?.marginDb ?? null,
      driftPpm: own ? round(own.driftPpm, 2) : null,
      lagMs: own?.lagResidualMs ?? null,
      coverage: q ? Math.min(1, Math.max(0, round(1 - q.noDataShare, 4))) : 0,
    };
  });
  return {
    engineVersion: r.engineVersion,
    talkTimeMs: Object.fromEntries(r.seats.map((s) => [String(s), Math.round(r.talkTimeMs[s] ?? 0)])),
    segments: r.segments.length,
    overlapMs: Math.round(r.overlapMs),
    grade: r.quality.grade,
    quality: {
      calibrated: r.leakage.source === "calibration",
      perSeat,
      ambiguousShare: Math.min(1, Math.max(0, round(r.quality.ambiguousFrameShare, 4))),
      warnings: [...r.quality.warnings, ...extraWarnings],
    },
  };
}

function jobView(j: AudioJobRow): AttributionJobView {
  const result = j.result as { summary?: AttributionSummaryView } | null;
  return {
    jobId: j.jobId,
    sessionId: j.sessionId,
    kind: "attribution",
    status: j.status as AttributionJob["status"],
    progress: Math.min(1, Math.max(0, j.progress)),
    startedWall: j.startedWall,
    finishedWall: j.finishedWall,
    error: j.error,
    ...(j.status === "done" && result?.summary ? { summary: result.summary } : {}),
  };
}

function deletionView(d: AudioDeletionRow): AudioDeletionRecord {
  const mask = d.counts.seatMask ?? 0;
  const seats: number[] = [];
  for (let s = 1; s < 31; s++) if (mask & (1 << s)) seats.push(s);
  return {
    id: d.id,
    sessionId: d.sessionId,
    scope: d.scope,
    seats,
    tracks: d.counts.tracks ?? 0,
    derivatives: d.counts.derivatives ?? 0,
    bytes: d.counts.bytes ?? 0,
    executedWall: d.executedWall,
    note: d.note.slice(0, 500),
  };
}

/* ─────────── the service ─────────── */

export class AudioService {
  private readonly store: Store;
  private readonly runTask: TaskRunner;

  constructor(private readonly deps: AudioServiceDeps) {
    this.store = deps.store;
    this.runTask = deps.runTask ?? runInWorker;
  }

  private session(sessionId: string) {
    const row = this.store.getSession(sessionId);
    if (!row) throw new AudioRequestError(404, "Unknown session");
    return row;
  }

  private refuseWhileRunning(sessionId: string, what: string) {
    if (isSessionRunning(this.deps.hub, sessionId))
      throw new AudioRequestError(
        409,
        `This session is still running. ${what} works after the session: end, close or abort it first.`,
      );
  }

  /* ── summary ── */

  summary(sessionId: string): AudioSessionView {
    this.session(sessionId);
    const views = trackViews(this.store, sessionId);
    const derivatives = this.store
      .listAudioDerivatives(sessionId, { kind: "clean" })
      .filter((d) => d.seat !== null)
      .map((d) => derivativeSummary(this.store, d));
    const jobs = this.store.listAudioJobs(sessionId).map(jobView);
    const latest = this.store.listAudioDerivatives(sessionId, { kind: "talk_time" }).at(-1);
    const latestData = latest
      ? (this.store.getAudioDerivative(latest.derivativeId)?.data as {
          summary?: AttributionSummaryView;
        } | null)
      : null;
    return {
      sessionId,
      tracks: views.map((v) => v.summary),
      derivatives,
      jobs,
      deletions: this.store.listAudioDeletions(sessionId).map(deletionView),
      seats: seatSummaries(views),
      attribution:
        latest && latestData?.summary
          ? {
              ...latestData.summary,
              jobId: typeof latest.params.jobId === "string" ? latest.params.jobId : null,
              createdServerTs: latest.createdServerTs,
            }
          : null,
      audioExports: this.audioExports(sessionId),
      running: isSessionRunning(this.deps.hub, sessionId),
    };
  }

  private audioExports(sessionId: string): AudioExportEntry[] {
    const rows = this.store.db
      .prepare(
        `SELECT id, created_wall, path, details_json, files_json FROM exports
         WHERE session_id = ? AND kind = 'audio' ORDER BY created_wall DESC, id`,
      )
      .all(sessionId) as Array<{
      id: string;
      created_wall: string;
      path: string;
      details_json: string;
      files_json: string;
    }>;
    return rows.map((r) => {
      const details = JSON.parse(r.details_json) as {
        audioKind?: AudioExportEntry["audioKind"];
        seats?: unknown;
      };
      return {
        exportId: r.id,
        createdWall: r.created_wall,
        audioKind: details.audioKind ?? null,
        seats: Array.isArray(details.seats) ? (details.seats as number[]) : [],
        files: (JSON.parse(r.files_json) as unknown[]).length,
        path: r.path,
        onDisk: existsSync(r.path),
      };
    });
  }

  /* ── jobs ── */

  job(jobId: string): AttributionJobView {
    const j = this.store.getAudioJob(jobId);
    if (!j) throw new AudioRequestError(404, "Unknown job");
    return jobView(j);
  }

  /** Queue a speaker attribution of the session (post-session only). */
  startAttribution(
    sessionId: string,
    opts: { options?: Partial<AttributionOptions> } = {},
  ): AttributionJobView {
    this.session(sessionId);
    this.refuseWhileRunning(sessionId, "Speaker attribution");
    if (!this.store.audioFiles) throw new AudioRequestError(409, "This database stores no audio.");
    const tracks = this.store.listAudioTracks(sessionId);
    if (tracks.length === 0) throw new AudioRequestError(409, "This session has no audio.");
    if (tracks.some((t) => t.status === "deleted" || !t.hasKey))
      throw new AudioRequestError(
        409,
        "The raw audio of this session was deleted, so it cannot be analysed again. The stored speech segments are kept.",
      );
    if (!tracks.some((t) => t.chunks > 0))
      throw new AudioRequestError(409, "This session's tracks hold no audio yet.");
    this.refuseWhileExporting(sessionId, "start the attribution");
    const active = this.deps.runner.activeJob(sessionId);
    if (active)
      throw new AudioRequestError(
        409,
        `An attribution of this session is already ${active.status} (${active.jobId}).`,
      );
    const params = { engineVersion: ENGINE_VERSION, options: opts.options ?? {} };
    const row = this.deps.runner.enqueue(sessionId, "attribution", params, async (ctx) => {
      const input = this.taskInput(sessionId, opts.options);
      const output = await this.runTask(
        input,
        {
          onProgress: (f, stage) => ctx.progress(f, stage),
          onFile: (f) => ctx.addPendingFile(f),
        },
        ctx.signal,
      );
      return this.storeAttribution(sessionId, ctx.jobId, input, output);
    });
    return jobView(row);
  }

  /** Read the track index, keys and events (main thread) into plain data for the task. */
  private taskInput(sessionId: string, options?: Partial<AttributionOptions>): AttributionTaskInput {
    const tl = sessionTimeline(this.store.listEvents(sessionId));
    const tracks = this.store
      .listAudioTracks(sessionId)
      .filter((t) => t.chunks > 0)
      .map((t) => {
        const key = this.store.getAudioTrackKey(t.trackId);
        if (!key || !t.fileName || t.status === "deleted")
          throw new Error("The raw audio of this session was deleted while the job was queued.");
        return {
          trackId: t.trackId,
          seat: t.seat,
          sampleRate: t.sampleRate,
          fileName: t.fileName,
          key,
          chunks: this.store.listAudioChunks(t.trackId).map((c) => ({
            seq: c.seq,
            startSample: c.startSample,
            sampleCount: c.sampleCount,
            clientTs: c.clientTs,
            serverTs: c.serverTs,
          })),
        };
      });
    const seats = [...new Set([...tl.audioSeats, ...tracks.map((t) => t.seat)])].sort((a, b) => a - b);
    return {
      audioRoot: this.store.audioFiles!.root,
      sessionId,
      seats,
      tracks,
      calibration: tl.calibration,
      phaseChanges: tl.phaseChanges,
      ...(options && Object.keys(options).length ? { options } : {}),
      clean: { attenuationDb: CLEAN_ATTENUATION_DB, fadeMs: CLEAN_FADE_MS },
    };
  }

  /**
   * Store a finished run: delete the previous run's derivatives and insert the new ones in one
   * transaction, then unlink the old files. Refused if the source audio changed meanwhile.
   */
  private storeAttribution(
    sessionId: string,
    jobId: string,
    input: AttributionTaskInput,
    out: AttributionTaskOutput,
  ): { summary: AttributionSummaryView; derivatives: number; tracks: number } {
    const store = this.store;
    const r = out.result;
    const summary = attributionSummaryOf(r, out.readWarnings);
    const options = r.options as unknown as Record<string, unknown>;
    const base = { engineVersion: r.engineVersion, sessionId };
    const allTracks = input.tracks.map((t) => t.trackId);
    const tracksOf = (seat: number) => input.tracks.filter((t) => t.seat === seat);
    const codeOf = (seat: number): string | null => {
      const t = tracksOf(seat)[0];
      return t ? (store.getAudioTrack(t.trackId)?.participantCode ?? null) : null;
    };
    const rows: NewAudioDerivative[] = [];
    for (const seat of r.seats) {
      const own = tracksOf(seat);
      if (own.length === 0) continue;
      const segments: SpeechSegmentRow[] = out.segments
        .filter((s) => s.seat === seat)
        .map((s) => ({
          seat,
          startTs: round(s.startTs, 1),
          endTs: round(s.endTs, 1),
          durationMs: Math.round(s.durationMs),
          round: s.round,
          phase: s.phase,
          paused: s.paused,
          recordingPaused: s.recordingPaused,
          meanDb: round(s.meanDb, 1),
          confidence: round(s.confidence, 3),
          overlap: s.overlap,
          overlapMs: Math.round(s.overlapMs),
          overlapWith: s.overlapWith,
        }));
      rows.push({
        ...base,
        derivativeId: randomUUID(),
        seat,
        participantCode: codeOf(seat),
        kind: SEGMENT_KIND,
        sourceTracks: own.map((t) => t.trackId),
        fileName: null,
        fileKey: null,
        data: { segments, talkTimeMs: Math.round(r.talkTimeMs[seat] ?? 0) },
        params: { jobId, options },
      });
    }
    for (const c of out.cleanFiles) {
      const params: CleanParams = {
        jobId,
        samples: c.samples,
        sampleRate: AUDIO_SAMPLE_RATE,
        timelineT0: r.timeline.t0,
        attenuationDb: input.clean.attenuationDb,
        fadeMs: input.clean.fadeMs,
        records: c.records,
      };
      rows.push({
        ...base,
        derivativeId: randomUUID(),
        seat: c.seat,
        participantCode: codeOf(c.seat),
        kind: "clean",
        // the mask was computed from every seat's audio, and the file holds the other voices too
        // (attenuated, and at full level in overlaps): an erasure of any participant removes it
        sourceTracks: allTracks,
        fileName: c.fileName,
        fileKey: Buffer.from(c.key),
        data: null,
        params,
      });
    }
    const session = (kind: string, data: unknown) =>
      rows.push({
        ...base,
        derivativeId: randomUUID(),
        seat: null,
        participantCode: null,
        kind,
        sourceTracks: allTracks,
        fileName: null,
        fileKey: null,
        data,
        params: { jobId, options },
      });
    session("talk_time", {
      summary,
      talkTimeMs: summary.talkTimeMs,
      overlapMs: summary.overlapMs,
      perSeat: r.quality.seats.map((s) => ({
        seat: s.seat,
        talkTimeMs: s.talkTimeMs,
        overlapMs: s.overlapMs,
      })),
    });
    session("quality_report", {
      quality: r.quality,
      timing: { timeline: r.timeline, alignment: r.alignment },
      calibrationTurns: input.calibration.length,
      readWarnings: out.readWarnings,
      timingsMs: r.timingsMs,
    });
    session("leakage_matrix", r.leakage);

    const oldFiles: string[] = [];
    store.db.transaction(() => {
      for (const id of allTracks) {
        const t = store.getAudioTrack(id);
        if (!t || t.status === "deleted" || !t.hasKey)
          throw new Error(
            "The session's audio changed while the attribution ran (deleted or erased). Nothing was stored.",
          );
      }
      for (const kind of ATTRIBUTION_DERIVATIVE_KINDS)
        for (const d of store.listAudioDerivatives(sessionId, { kind })) {
          const removed = store.deleteAudioDerivative(d.derivativeId);
          if (removed?.fileName) oldFiles.push(removed.fileName);
        }
      for (const d of rows) store.insertAudioDerivative(d);
    })();
    for (const f of oldFiles) {
      try {
        store.audioFiles?.deleteFile(sessionId, f);
      } catch (e) {
        this.deps.log?.warn({ error: (e as Error).message }, "could not remove a replaced clean track");
      }
    }
    return { summary, derivatives: rows.length, tracks: input.tracks.length };
  }

  /* ── speech segments ── */

  speechSegments(sessionId: string): {
    sessionId: string;
    engineVersion: string | null;
    jobId: string | null;
    segments: SpeechSegmentRow[];
  } {
    this.session(sessionId);
    const list = this.store.listAudioDerivatives(sessionId, { kind: SEGMENT_KIND });
    const { segments } = speechSegmentsOf(this.store, sessionId);
    return {
      sessionId,
      engineVersion: list[0]?.engineVersion ?? null,
      jobId: typeof list[0]?.params.jobId === "string" ? list[0].params.jobId : null,
      // who spoke when only: the participant code stays out of REST responses
      segments: segments.map(({ participantCode: _c, engineVersion: _v, ...s }) => s),
    };
  }

  /* ── export audio ── */

  /** The latest stored attribution timing, if it was computed from exactly these tracks. */
  private storedTiming(sessionId: string, trackIds: readonly string[]): StoredTiming | null {
    const q = this.store.listAudioDerivatives(sessionId, { kind: "quality_report" }).at(-1);
    if (!q) return null;
    const same =
      q.sourceTracks.length === trackIds.length && q.sourceTracks.every((t) => trackIds.includes(t));
    if (!same) return null;
    const data = this.store.getAudioDerivative(q.derivativeId)?.data as { timing?: StoredTiming } | null;
    return data?.timing ?? null;
  }

  /** SHA-256 of every participant code of the session: any of their voices can be in any seat's audio. */
  private sessionCodeHashes(sessionId: string): string[] {
    const rows = this.store.db
      .prepare(
        `SELECT participant_code AS c FROM events WHERE session_id = @id AND participant_code IS NOT NULL
         UNION SELECT participant_code FROM telemetry WHERE session_id = @id
         UNION SELECT participant_code FROM audio_tracks WHERE session_id = @id
         UNION SELECT participant_code FROM audio_derivatives WHERE session_id = @id AND participant_code IS NOT NULL`,
      )
      .all({ id: sessionId }) as Array<{ c: string }>;
    return rows.map((r) => sha256(r.c)).sort();
  }

  /** Sessions with an audio export in progress (it reads files that a deletion or a re-run would remove). */
  private exporting = new Map<string, number>();

  private refuseWhileExporting(sessionId: string, what: string) {
    if (this.exporting.get(sessionId))
      throw new AudioRequestError(
        409,
        `An audio export of this session is being written: ${what} when it is done.`,
      );
  }

  async exportAudio(
    sessionId: string,
    opts: { kind: AudioExportKind | "both"; seats?: number[]; note?: string; requestedBy: string },
  ): Promise<AudioExportResult> {
    this.session(sessionId);
    this.refuseWhileRunning(sessionId, "Exporting audio");
    if (this.deps.runner.activeJob(sessionId))
      throw new AudioRequestError(
        409,
        "An attribution of this session is queued or running: export when it ends.",
      );
    this.exporting.set(sessionId, (this.exporting.get(sessionId) ?? 0) + 1);
    try {
      return await this.writeAudioExport(sessionId, opts);
    } finally {
      const n = (this.exporting.get(sessionId) ?? 1) - 1;
      if (n > 0) this.exporting.set(sessionId, n);
      else this.exporting.delete(sessionId);
    }
  }

  private async writeAudioExport(
    sessionId: string,
    opts: { kind: AudioExportKind | "both"; seats?: number[]; note?: string; requestedBy: string },
  ): Promise<AudioExportResult> {
    const store = this.store;
    if (!store.audioFiles) throw new AudioRequestError(409, "This database stores no audio.");
    const tracks = store.listAudioTracks(sessionId);
    if (tracks.length === 0) throw new AudioRequestError(409, "This session has no audio.");
    const allSeats = [...new Set(tracks.map((t) => t.seat))].sort((a, b) => a - b);
    const seats = opts.seats?.length ? [...new Set(opts.seats)].sort((a, b) => a - b) : allSeats;
    for (const s of seats)
      if (!allSeats.includes(s)) throw new AudioRequestError(400, `Seat ${s} has no audio in this session.`);
    const kinds: AudioExportKind[] = opts.kind === "both" ? ["raw", "clean"] : [opts.kind];

    const live = tracks.filter((t) => t.status !== "deleted" && t.hasKey && t.fileName && t.chunks > 0);
    const clean = new Map(
      store
        .listAudioDerivatives(sessionId, { kind: "clean" })
        .filter((d) => d.seat !== null && d.fileName && d.hasKey)
        .map((d) => [d.seat!, d]),
    );
    if (kinds.includes("raw"))
      for (const s of seats)
        if (!live.some((t) => t.seat === s))
          throw new AudioRequestError(409, `The raw audio of seat ${s} was deleted (or holds no audio).`);
    if (kinds.includes("clean"))
      for (const s of seats)
        if (!clean.has(s))
          throw new AudioRequestError(
            409,
            `Seat ${s} has no cleaned track: run the speaker attribution first (raw audio is needed for it).`,
          );

    // Raw: every seat rendered on one timeline so the files line up sample for sample.
    let timing: StoredTiming | null = null;
    let timingSource: AudioExportResult["timing"] = "attribution";
    if (kinds.includes("raw")) {
      const withData = tracks.filter((t) => t.chunks > 0).map((t) => t.trackId);
      timing = this.storedTiming(sessionId, withData);
      if (!timing) {
        timingSource = "timestamps";
        timing = timestampTiming(
          live.map((t) => ({
            trackId: t.trackId,
            seat: t.seat,
            sampleRate: t.sampleRate,
            chunks: store.listAudioChunks(t.trackId),
          })),
        );
      }
      if (!timing)
        throw new AudioRequestError(409, "The tracks have no timestamped chunks to place on a timeline.");
    }

    const now = nowTs();
    const exportId = exportIdOf(now);
    const dir = path.join(this.deps.exportsDir, sessionId, `audio-${exportId}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const files: AudioExportFile[] = [];
    const warnings: string[] = [];
    try {
      for (const seat of seats) {
        if (kinds.includes("raw") && timing) {
          const issues: AudioReadIssue[] = [];
          const sources: TrackSource[] = live
            .filter((t) => t.seat === seat)
            .map((t) => ({
              trackId: t.trackId,
              samples: store
                .listAudioChunks(t.trackId)
                .reduce((n, c) => Math.max(n, c.startSample + c.sampleCount), 0),
              chunks: trackPcmChunks(store, t, store.getAudioTrackKey(t.trackId)!, (i) => issues.push(i)),
            }));
          const total = renderedSampleCount(timing.timeline);
          const name = audioExportFileName(sessionId, seat, "raw");
          const w = await writeWavFile(
            path.join(dir, name),
            renderAligned(seat, sources, timing as RenderTiming),
            total,
          );
          files.push({ name, seat, kind: "raw", samples: total, durationMs: Math.round(total / 16), ...w });
          warnings.push(...describeIssues(seat, issues, { unindexed: 0 }));
        }
        if (kinds.includes("clean")) {
          const d = clean.get(seat)!;
          const key = store.getAudioDerivativeKey(d.derivativeId)!;
          const total = (d.params as Partial<CleanParams>).samples ?? 0;
          const name = audioExportFileName(sessionId, seat, "clean");
          let bad = 0;
          const blocks = async function* () {
            const seen = new Set<number>();
            for await (const r of store.audioFiles!.readRecords(sessionId, d.fileName!, key, {
              onIssue: (i) => {
                if (i.kind !== "truncated") bad++;
              },
            })) {
              if (seen.has(r.seq)) continue;
              seen.add(r.seq);
              yield int16Of(r.data);
            }
          };
          const w = await writeWavFile(path.join(dir, name), blocks(), total);
          files.push({ name, seat, kind: "clean", samples: total, durationMs: Math.round(total / 16), ...w });
          if (bad)
            warnings.push(
              `Seat ${seat}: the cleaned track has damaged records; the WAV is incomplete (re-run the attribution).`,
            );
        }
      }

      const cleanT0 = (clean.get(seats[0]!)?.params as Partial<CleanParams> | undefined)?.timelineT0 ?? null;
      const manifest = {
        exportId,
        kind: "audio",
        audioKind: opts.kind,
        sessionId,
        createdWall: wall(now),
        requestedBy: opts.requestedBy,
        note: opts.note ?? "",
        format: { container: "WAV", codec: "pcm_s16le", sampleRate: AUDIO_SAMPLE_RATE, channels: 1 },
        timeline: {
          t0: timing?.timeline.t0 ?? cleanT0,
          hopMs: HOP_MS,
          source: timingSource,
          engineVersion: clean.get(seats[0]!)?.engineVersion ?? null,
        },
        warnings,
        files,
      };
      const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
      writeFileSync(path.join(dir, "manifest.json"), manifestText, { mode: 0o600 });
      registerExport(store, {
        id: exportId,
        sessionId,
        kind: "audio",
        createdWall: wall(now),
        path: dir,
        codeHashes: this.sessionCodeHashes(sessionId),
        files: [...files, { name: "manifest.json", sha256: sha256(manifestText) }],
        details: {
          audioKind: opts.kind,
          seats,
          requestedBy: opts.requestedBy,
          note: opts.note ?? "",
          timing: timingSource,
        },
      });
    } catch (e) {
      // never leave unregistered voice files behind (the folder is ours: created above, inside the exports folder)
      rmSync(dir, { recursive: true, force: true });
      throw e;
    }
    this.deps.log?.info({ exportId, files: files.length, seats }, "audio exported");
    return { exportId, sessionId, dir, files, timing: timingSource, warnings };
  }

  /* ── delete ── */

  deleteAudio(
    sessionId: string,
    opts: { confirm: string; scope: "raw" | "all"; note?: string },
  ): AudioDeletionResult & { record: AudioDeletionRecord; audioExportsOnDisk: string[] } {
    this.session(sessionId);
    if (opts.confirm.trim() !== sessionId)
      throw new AudioRequestError(400, "Confirmation does not match the session id");
    const active = this.deps.runner.activeJob(sessionId);
    if (active)
      throw new AudioRequestError(
        409,
        "An attribution of this session is queued or running: wait until it ends.",
      );
    this.refuseWhileExporting(sessionId, "delete the audio");
    try {
      const r = deleteSessionAudio({ store: this.store, hub: this.deps.hub }, sessionId, {
        scope: opts.scope,
        ...(opts.note !== undefined ? { note: opts.note } : {}),
      });
      return {
        ...r,
        record: deletionView(r.entry),
        audioExportsOnDisk: this.audioExports(sessionId)
          .filter((e) => e.onDisk)
          .map((e) => e.path),
      };
    } catch (e) {
      if (e instanceof SessionRunningError) throw new AudioRequestError(409, e.message);
      throw e;
    }
  }
}
