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
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import {
  type AttributionJob,
  type AttributionJobView,
  type AttributionSummaryView,
  AUDIO_SAMPLE_RATE,
  type AudioDeleteResult,
  type AudioDeletionRecord,
  type AudioDeletionScope,
  type AudioDerivativeKind,
  type AudioExportEntry,
  type AudioExportFile,
  type AudioExportKind,
  type AudioExportRequestKind,
  type AudioExportResult,
  type AudioSessionView,
  applyEvent,
  audioExportFileName,
  initialState,
  int16FromLeBytes,
  randomCrockford,
  type SpeechSegmentRow,
  type SpeechSegmentsView,
  type StoredEvent,
  samplesToMs,
} from "@wkwa/shared";
import type { Logger } from "pino";
import { HttpError, orThrow } from "../api/http";
import { sha256 } from "../content";
import { type AudioDeletionResult, PersonalDataMap } from "../db/personalData";
import type { AudioChunkRow, AudioDeletionRow, AudioJobRow, NewAudioDerivative, Store } from "../db/store";
import { nowTs, wall } from "../runtime";
import { SessionGuard } from "../session/sessionGuard";
import {
  type AttributionOptions,
  type AttributionResult,
  alignTrack,
  type CalibrationTurn,
  type ChunkMeta,
  ENGINE_VERSION,
  fitClock,
  HOP_MS,
  type PhaseChange,
  type RenderTiming,
  renderAligned,
  renderedSampleCount,
  type Timeline,
  type TrackAlignment,
  type TrackSource,
  trackSampleEnd,
} from "./attribution";
import { type AudioReadIssue, writeAll } from "./fileStore";
import { type AudioJobRunner, runInWorker, type TaskRunner } from "./jobs";
import {
  type AttributionTaskInput,
  type AttributionTaskOutput,
  CLEAN_RECORD_SAMPLES,
  describeIssues,
  seqOrderedChunks,
} from "./jobWorker";
import {
  ATTRIBUTION_DERIVATIVE_KINDS,
  type CleanParams,
  derivativeSummary,
  seatSummaries,
  speechSegmentsOf,
  trackSummaries,
  trackViews,
} from "./records";
import { wavStream } from "./wav";

const round = (v: number, digits = 2) => Math.round(v * 10 ** digits) / 10 ** digits;

export const CLEAN_ATTENUATION_DB = -30;
export const CLEAN_FADE_MS = 10;

export interface AudioServiceDeps {
  /** The participant database (the only one with audio). */
  store: Store;
  /**
   * Whether the session may change now (running, attribution, export). Default: a guard over
   * `runner` with no hub attached. The server passes the guard it shares with the GDPR routes.
   */
  guard?: SessionGuard;
  /** Where exports of the participant database go (WKWA_EXPORTS_DIR). */
  exportsDir: string;
  runner: AudioJobRunner;
  /** How the attribution task runs (default: a worker thread). */
  runTask?: TaskRunner;
  /** Detect speech with the Silero model (default true); false = energy only (tests with synthetic audio). */
  speechModel?: boolean;
  log?: Logger;
}

/* ─────────── helpers on the event log ─────────── */

export interface SessionTimeline {
  /** Turns of the last completed calibration (none if it was skipped, cancelled or never run). */
  calibration: CalibrationTurn[];
  phaseChanges: PhaseChange[];
  /** Seats that permitted audio recording. */
  audioSeats: number[];
}

export function sessionTimeline(events: readonly StoredEvent[]): SessionTimeline {
  const state = initialState();
  const phaseChanges: PhaseChange[] = [];
  let calibration: CalibrationTurn[] = [];
  let prev = "";
  for (const e of events) {
    applyEvent(state, e);
    if (e.type === "CalibrationStarted") calibration = [];
    else if (e.type === "CalibrationCompleted")
      calibration = e.payload.turns.map((t) => ({ seat: t.seat, startTs: t.startTs, endTs: t.endTs }));
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
  return { calibration, phaseChanges, audioSeats };
}

/* ─────────── timing for rendering ─────────── */

interface StoredTiming {
  timeline: Timeline & { endTs?: number };
  alignment: TrackAlignment[];
}

/** Timing from the chunks' timestamps alone (no attribution yet): the same clock fit as the engine's. */
export function timestampTiming(
  tracks: ReadonlyArray<{ trackId: string; seat: number; sampleRate: number; chunks: readonly ChunkMeta[] }>,
): StoredTiming | null {
  const alignment: TrackAlignment[] = [];
  for (const t of tracks) {
    const f = fitClock(t);
    if (f) alignment.push(alignTrack(f, trackSampleEnd(t.chunks)));
  }
  if (alignment.length === 0) return null;
  const t0 = Math.min(...alignment.map((a) => a.startTs));
  const end = Math.max(...alignment.map((a) => a.endTs));
  const frames = Math.max(1, Math.ceil((end - t0) / HOP_MS));
  return { timeline: { t0, hopMs: HOP_MS, frames, endTs: t0 + frames * HOP_MS }, alignment };
}

/* ─────────── reading audio for export ─────────── */

/** Suffix of an audio export folder still being written. */
export const PARTIAL_SUFFIX = ".partial";

/** Remove export folders left half-written by a crash (`<exportsDir>/<session>/audio-*.partial`). */
export function sweepPartialExports(exportsDir: string, log?: Logger): void {
  if (!existsSync(exportsDir)) return;
  for (const session of readdirSync(exportsDir, { withFileTypes: true })) {
    if (!session.isDirectory()) continue;
    const dir = path.join(exportsDir, session.name);
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || !e.name.startsWith("audio-") || !e.name.endsWith(PARTIAL_SUFFIX)) continue;
      rmSync(path.join(dir, e.name), { recursive: true, force: true });
      log?.warn({ folder: path.join(session.name, e.name) }, "removed a half-written audio export");
    }
  }
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
      await writeAll(fh, chunk, bytes);
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

/* ─────────── summaries ─────────── */

/** The REST summary of an attribution result. */
export function attributionSummaryOf(
  r: AttributionResult,
  extraWarnings: string[] = [],
): AttributionSummaryView {
  const perSeat = r.quality.seats.map((q) => ({
    seat: q.seat,
    marginDb: r.quality.calibration?.find((c) => c.seat === q.seat)?.marginDb ?? null,
    driftPpm: q.driftPpm,
    coverage: Math.min(1, Math.max(0, q.coverage)),
  }));
  return {
    engineVersion: r.engineVersion,
    talkTimeMs: Object.fromEntries(r.seats.map((s) => [String(s), Math.round(r.talkTimeMs[s] ?? 0)])),
    segments: r.segments.length,
    overlapMs: Math.round(r.overlapMs),
    grade: r.quality.grade,
    quality: {
      calibrated: r.leakage.source === "calibration",
      speechDetector: r.quality.detector,
      perSeat,
      ambiguousShare: Math.min(1, Math.max(0, r.quality.ambiguousShare)),
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
  private readonly guard: SessionGuard;

  constructor(private readonly deps: AudioServiceDeps) {
    this.store = deps.store;
    this.runTask = deps.runTask ?? runInWorker;
    this.guard = deps.guard ?? new SessionGuard({ hub: null, jobs: deps.runner });
    sweepPartialExports(deps.exportsDir, deps.log);
  }

  private session(sessionId: string) {
    const row = this.store.getSession(sessionId);
    if (!row) throw new HttpError(404, "Unknown session");
    return row;
  }

  /* ── summary ── */

  async summary(sessionId: string): Promise<AudioSessionView> {
    this.session(sessionId);
    const views = trackViews(this.store, sessionId);
    const [tracks, derivatives] = await Promise.all([
      trackSummaries(this.store, views),
      Promise.all(
        this.store
          .listAudioDerivatives(sessionId, { kind: "clean" })
          .filter((d) => d.seat !== null)
          .map((d) => derivativeSummary(this.store, d)),
      ),
    ]);
    const jobs = this.store.listAudioJobs(sessionId).map(jobView);
    const latest = this.store.listAudioDerivatives(sessionId, { kind: "talk_time" }).at(-1);
    const latestData = latest
      ? (this.store.getAudioDerivative(latest.derivativeId)?.data as {
          summary?: AttributionSummaryView;
        } | null)
      : null;
    return {
      sessionId,
      tracks,
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
      running: this.guard.running(sessionId),
    };
  }

  private audioExports(sessionId: string): AudioExportEntry[] {
    return this.store.listExports({ sessionId, kind: "audio" }).map((r) => {
      const details = r.details as { audioKind?: AudioExportEntry["audioKind"]; seats?: unknown };
      return {
        exportId: r.id,
        createdWall: r.createdWall,
        audioKind: details.audioKind ?? null,
        seats: Array.isArray(details.seats) ? (details.seats as number[]) : [],
        files: r.files,
        path: r.path,
        onDisk: existsSync(r.path),
      };
    });
  }

  /* ── jobs ── */

  job(jobId: string): AttributionJobView {
    const j = this.store.getAudioJob(jobId);
    if (!j) throw new HttpError(404, "Unknown job");
    return jobView(j);
  }

  /** Queue a speaker attribution of the session (post-session only). */
  startAttribution(
    sessionId: string,
    opts: { options?: Partial<AttributionOptions> } = {},
  ): AttributionJobView {
    this.session(sessionId);
    orThrow(
      this.guard.check("start-attribution", sessionId, {
        precondition: () => this.unanalysable(sessionId),
      }),
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

  /** Why the session's audio cannot be analysed (409), or null. */
  private unanalysable(sessionId: string): string | null {
    if (!this.store.audioFiles) return "This database stores no audio.";
    const tracks = this.store.listAudioTracks(sessionId);
    if (tracks.length === 0) return "This session has no audio.";
    if (tracks.some((t) => t.status === "deleted" || !t.hasKey))
      return "The raw audio of this session was deleted, so it cannot be analysed again. The stored speech segments are kept.";
    if (!tracks.some((t) => t.chunks > 0)) return "This session's tracks hold no audio yet.";
    return null;
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
      audioRoot: this.store.requireAudioFiles().root,
      sessionId,
      seats,
      tracks,
      calibration: tl.calibration,
      phaseChanges: tl.phaseChanges,
      ...(options && Object.keys(options).length ? { options } : {}),
      clean: { attenuationDb: CLEAN_ATTENUATION_DB, fadeMs: CLEAN_FADE_MS },
      ...(this.deps.speechModel === false ? { speechModel: false } : {}),
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
    const rows: Array<NewAudioDerivative & { kind: AudioDerivativeKind }> = [];
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
        kind: "speech_segments",
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
    const session = (kind: AudioDerivativeKind, data: unknown) =>
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

  speechSegments(sessionId: string): SpeechSegmentsView {
    this.session(sessionId);
    const list = this.store.listAudioDerivatives(sessionId, { kind: "speech_segments" });
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

  /** The latest stored attribution timing, if this engine computed it from exactly these tracks. */
  private storedTiming(sessionId: string, trackIds: readonly string[]): StoredTiming | null {
    const q = this.store.listAudioDerivatives(sessionId, { kind: "quality_report" }).at(-1);
    // an earlier engine's alignment has another shape: fall back to the timestamps
    if (!q || q.engineVersion !== ENGINE_VERSION) return null;
    const same =
      q.sourceTracks.length === trackIds.length && q.sourceTracks.every((t) => trackIds.includes(t));
    if (!same) return null;
    const data = this.store.getAudioDerivative(q.derivativeId)?.data as { timing?: StoredTiming } | null;
    return data?.timing ?? null;
  }

  /** SHA-256 of every participant code of the session: any of their voices can be in any seat's audio. */
  private sessionCodeHashes(sessionId: string): string[] {
    return this.store
      .sessionCodes(sessionId)
      .map((c) => sha256(c))
      .sort();
  }

  async exportAudio(
    sessionId: string,
    opts: { kind: AudioExportRequestKind; seats?: number[]; note?: string; requestedBy: string },
  ): Promise<AudioExportResult> {
    this.session(sessionId);
    // while it is written, the session is busy: nothing may delete or replace what it reads
    return orThrow(await this.guard.exportAudio(sessionId, () => this.writeAudioExport(sessionId, opts)));
  }

  private async writeAudioExport(
    sessionId: string,
    opts: { kind: AudioExportRequestKind; seats?: number[]; note?: string; requestedBy: string },
  ): Promise<AudioExportResult> {
    const store = this.store;
    if (!store.audioFiles) throw new HttpError(409, "This database stores no audio.");
    const tracks = store.listAudioTracks(sessionId);
    if (tracks.length === 0) throw new HttpError(409, "This session has no audio.");
    const allSeats = [...new Set(tracks.map((t) => t.seat))].sort((a, b) => a - b);
    const seats = opts.seats?.length ? [...new Set(opts.seats)].sort((a, b) => a - b) : allSeats;
    for (const s of seats)
      if (!allSeats.includes(s)) throw new HttpError(400, `Seat ${s} has no audio in this session.`);
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
          throw new HttpError(409, `The raw audio of seat ${s} was deleted (or holds no audio).`);
    if (kinds.includes("clean"))
      for (const s of seats)
        if (!clean.has(s))
          throw new HttpError(
            409,
            `Seat ${s} has no cleaned track: run the speaker attribution first (raw audio is needed for it).`,
          );

    // Raw: every seat rendered on one timeline so the files line up sample for sample.
    let timing: StoredTiming | null = null;
    let timingSource: AudioExportResult["timing"] = "attribution";
    const chunksOf = new Map<string, AudioChunkRow[]>();
    if (kinds.includes("raw")) {
      for (const t of live) chunksOf.set(t.trackId, store.listAudioChunks(t.trackId));
      const withData = tracks.filter((t) => t.chunks > 0).map((t) => t.trackId);
      timing = this.storedTiming(sessionId, withData);
      if (!timing) {
        timingSource = "timestamps";
        timing = timestampTiming(
          live.map((t) => ({
            trackId: t.trackId,
            seat: t.seat,
            sampleRate: t.sampleRate,
            chunks: chunksOf.get(t.trackId)!,
          })),
        );
      }
      if (!timing) throw new HttpError(409, "The tracks have no timestamped chunks to place on a timeline.");
    }

    const now = nowTs();
    const exportId = exportIdOf(now);
    const dir = path.join(this.deps.exportsDir, sessionId, `audio-${exportId}`);
    // written under a `.partial` name and renamed once registered: a crash never leaves a complete-
    // looking, unregistered folder of voice files (leftovers are removed at start-up)
    const work = `${dir}${PARTIAL_SUFFIX}`;
    mkdirSync(work, { recursive: true, mode: 0o700 });
    const files: AudioExportFile[] = [];
    const warnings: string[] = [];
    try {
      for (const seat of seats) {
        if (kinds.includes("raw") && timing) {
          const issues: AudioReadIssue[] = [];
          const sources: TrackSource[] = live
            .filter((t) => t.seat === seat)
            .map((t) => {
              const chunks = chunksOf.get(t.trackId)!;
              const key = store.getAudioTrackKey(t.trackId)!;
              return {
                trackId: t.trackId,
                samples: trackSampleEnd(chunks),
                chunks: seqOrderedChunks(store.requireAudioFiles(), t.sessionId, t.fileName!, key, chunks, {
                  onIssue: (i) => issues.push(i),
                }),
              };
            });
          const total = renderedSampleCount(timing.timeline);
          const name = audioExportFileName(sessionId, seat, "raw");
          const w = await writeWavFile(
            path.join(work, name),
            renderAligned(seat, sources, timing as RenderTiming),
            total,
          );
          const durationMs = Math.round(samplesToMs(total));
          files.push({ name, seat, kind: "raw", samples: total, durationMs, ...w });
          warnings.push(...describeIssues(seat, issues));
        }
        if (kinds.includes("clean")) {
          const d = clean.get(seat)!;
          const key = store.getAudioDerivativeKey(d.derivativeId)!;
          const total = (d.params as Partial<CleanParams>).samples ?? 0;
          const name = audioExportFileName(sessionId, seat, "clean");
          let bad = 0;
          // record `seq` holds samples [seq · 5 s, …): a damaged record plays as silence in its place
          const blocks = async function* () {
            let next = 0;
            for await (const r of store.requireAudioFiles().readUniqueRecords(sessionId, d.fileName!, key, {
              onIssue: (i) => {
                if (i.kind !== "truncated") bad++;
              },
            })) {
              if (r.seq < next) continue;
              if (r.seq > next) yield new Int16Array((r.seq - next) * CLEAN_RECORD_SAMPLES);
              yield int16FromLeBytes(r.data);
              next = r.seq + 1;
            }
          };
          const w = await writeWavFile(path.join(work, name), blocks(), total);
          const durationMs = Math.round(samplesToMs(total));
          files.push({ name, seat, kind: "clean", samples: total, durationMs, ...w });
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
      writeFileSync(path.join(work, "manifest.json"), manifestText, { mode: 0o600 });
      store.registerExport({
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
      renameSync(work, dir);
    } catch (e) {
      // never leave unregistered voice files behind (the folder is ours: created above, inside the exports folder)
      rmSync(work, { recursive: true, force: true });
      throw e;
    }
    this.deps.log?.info({ exportId, files: files.length, seats }, "audio exported");
    return { exportId, sessionId, dir, files, timing: timingSource, warnings };
  }

  /* ── delete ── */

  deleteAudio(
    sessionId: string,
    opts: { confirm: string; scope: AudioDeletionScope; note?: string },
  ): AudioDeletionResult & Pick<AudioDeleteResult, "record" | "audioExportsOnDisk"> {
    this.session(sessionId);
    if (opts.confirm.trim() !== sessionId)
      throw new HttpError(400, "Confirmation does not match the session id");
    orThrow(this.guard.check("delete-audio", sessionId));
    const r = new PersonalDataMap(this.store).deleteAudio(sessionId, {
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
  }
}
