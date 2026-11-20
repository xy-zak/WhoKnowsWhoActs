/**
 * The speaker-attribution task, and the `worker_thread` entry point that runs it.
 *
 * The task needs no database: the main thread (audio/service.ts) reads the
 * session's track index, file keys and events, and hands this module plain
 * data. Here we
 *  1. decrypt each track record by record, in sample order, and reduce it to
 *     10 ms features: level and Silero speech probability (only about one 5 s
 *     chunk of PCM is in memory at a time),
 *  2. run `analyse` (speech detection plus a loudness gate between the seats'
 *     mics, never voice identity) and `annotate` (round / phase / pause of
 *     every segment),
 *  3. render one cleaned track per seat (`renderClean`: other seats' frames
 *     attenuated by 30 dB) into a NEW encrypted `.wka` file with a fresh key.
 * The raw files are only ever read. Every new file name is reported through
 * `onFile` before anything is written to it, so a failed or interrupted job's
 * files can be removed.
 *
 * Imported in-process this module only exports the task; started as a worker
 * with `workerData.task === WORKER_TASK` it runs it and reports over
 * `parentPort` (see `runInWorker` in ./jobs.ts).
 */
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { AUDIO_CHUNK_SAMPLES, int16FromLeBytes, int16ToLeBytes } from "@wkwa/shared";
import {
  type AnnotatedSegment,
  type AttributionOptions,
  type AttributionResult,
  analyse,
  annotate,
  type CalibrationTurn,
  type ChunkMeta,
  FeatureBuilder,
  loadSilero,
  type PcmChunk,
  type PhaseChange,
  renderClean,
  type TrackInput,
  type TrackSource,
  trackSampleEnd,
  type Vad,
} from "./attribution";
import { AudioFileStore, type AudioReadIssue } from "./fileStore";

export const WORKER_TASK = "wkwa-audio-attribution";

/** Samples per record of a cleaned track: 5 s, like the raw chunks. */
export const CLEAN_RECORD_SAMPLES = AUDIO_CHUNK_SAMPLES;

export interface AttributionTaskTrack {
  trackId: string;
  seat: number;
  sampleRate: number;
  fileName: string;
  /** The raw file's key (a Buffer in-process; a Uint8Array after crossing into a worker). */
  key: Uint8Array;
  /** The chunk index from the database, by seq. */
  chunks: ChunkMeta[];
}

export interface AttributionTaskInput {
  /** The audio folder (data/audio). */
  audioRoot: string;
  sessionId: string;
  seats: number[];
  tracks: AttributionTaskTrack[];
  calibration: CalibrationTurn[];
  phaseChanges: PhaseChange[];
  options?: Partial<AttributionOptions>;
  clean: { attenuationDb: number; fadeMs: number };
  /** Use the Silero speech model (default true); false = energy only (tests). */
  speechModel?: boolean;
}

export interface CleanFileOutput {
  seat: number;
  fileName: string;
  key: Uint8Array;
  samples: number;
  records: number;
  sourceTrackIds: string[];
}

export interface AttributionTaskOutput {
  result: AttributionResult;
  segments: AnnotatedSegment[];
  cleanFiles: CleanFileOutput[];
  /** Problems found while reading the raw files (plain English, no codes). */
  readWarnings: string[];
}

export interface TaskHooks {
  onProgress?: (fraction: number, stage: string) => void;
  /** A new encrypted file was created (before it is written to). */
  onFile?: (fileName: string) => void;
}

const asBuffer = (key: Uint8Array) => (Buffer.isBuffer(key) ? key : Buffer.from(key));

export function describeIssues(seat: number, issues: AudioReadIssue[]): string[] {
  const out: string[] = [];
  const count = (k: AudioReadIssue["kind"]) => issues.filter((i) => i.kind === k).length;
  if (count("missing")) out.push(`Seat ${seat}: a raw audio file is missing; its track was skipped.`);
  if (count("bad_header"))
    out.push(`Seat ${seat}: a raw audio file has a damaged header; its track was skipped.`);
  if (count("tag_mismatch"))
    out.push(`Seat ${seat}: ${count("tag_mismatch")} audio chunk(s) failed authentication and were skipped.`);
  if (count("bad_length"))
    out.push(`Seat ${seat}: a raw audio file is corrupt after some point; the rest was skipped.`);
  if (count("truncated")) out.push(`Seat ${seat}: a raw audio file ends with an incomplete chunk (ignored).`);
  return out;
}

/**
 * A track's chunks in startSample order, decrypted one record at a time.
 *
 * Records are normally in order in the file (chunks are appended as they arrive), so this streams.
 * A chunk the browser resent late sits further back in the file: records that arrive early are held
 * (at most `maxHeld`, about 2 minutes) until the missing one comes. A chunk that never comes (lost,
 * failed authentication) is given up on once the buffer is full, and plays as silence; the first
 * valid copy of a resent chunk wins.
 */
export async function* seqOrderedChunks(
  files: AudioFileStore,
  sessionId: string,
  fileName: string,
  key: Uint8Array,
  chunks: readonly ChunkMeta[],
  opts: { onIssue?: (issue: AudioReadIssue) => void; maxHeld?: number } = {},
): AsyncGenerator<PcmChunk> {
  const order = [...chunks].sort((a, b) => a.startSample - b.startSample || a.seq - b.seq);
  const posOf = new Map(order.map((c, i) => [c.seq, i]));
  const maxHeld = opts.maxHeld ?? 24;
  const held = new Map<number, Int16Array>();
  const failed = new Set<number>();
  let next = 0;
  const skipFailed = () => {
    while (next < order.length && failed.has(order[next]!.seq) && !held.has(next)) next++;
  };
  function* drain(): Generator<PcmChunk> {
    skipFailed();
    while (held.has(next)) {
      yield { startSample: order[next]!.startSample, samples: held.get(next)! };
      held.delete(next);
      next++;
      skipFailed();
    }
  }
  for await (const r of files.readUniqueRecords(sessionId, fileName, asBuffer(key), {
    onIssue: (issue) => {
      if (issue.kind === "tag_mismatch") failed.add(issue.seq);
      opts.onIssue?.(issue);
    },
  })) {
    const pos = posOf.get(r.seq);
    if (pos === undefined || pos < next) continue; // not indexed, or came after it was given up on
    held.set(pos, int16FromLeBytes(r.data));
    yield* drain();
    if (held.size > maxHeld) {
      next = Math.min(...held.keys());
      yield* drain();
    }
  }
  for (const pos of [...held.keys()].sort((a, b) => a - b))
    yield { startSample: order[pos]!.startSample, samples: held.get(pos)! };
}

export async function runAttributionTask(
  input: AttributionTaskInput,
  hooks: TaskHooks = {},
): Promise<AttributionTaskOutput> {
  const progress = (fraction: number, stage: string) => hooks.onProgress?.(Math.min(1, fraction), stage);
  const files = new AudioFileStore(input.audioRoot);
  const readWarnings: string[] = [];
  const trackInputs: TrackInput[] = [];
  let vad: Vad | null = null;
  if (input.speechModel !== false) {
    try {
      vad = await loadSilero();
    } catch (e) {
      readWarnings.push(`The speech model could not be loaded (${(e as Error).message}).`);
    }
  }

  // 1. Features, one track at a time, one record at a time, in sample order.
  for (const [i, t] of input.tracks.entries()) {
    const builder = new FeatureBuilder(vad);
    const issues: AudioReadIssue[] = [];
    for await (const c of seqOrderedChunks(files, input.sessionId, t.fileName, t.key, t.chunks, {
      onIssue: (x) => issues.push(x),
    })) {
      builder.push(c.samples, c.startSample);
      await builder.drain();
    }
    readWarnings.push(...describeIssues(t.seat, issues));
    trackInputs.push({
      trackId: t.trackId,
      seat: t.seat,
      sampleRate: t.sampleRate,
      chunks: t.chunks,
      features: builder.finish(),
    });
    progress((0.5 * (i + 1)) / input.tracks.length, "features");
  }

  // 2. Attribution (pure and synchronous).
  const result = analyse({
    tracks: trackInputs,
    seats: input.seats,
    calibration: input.calibration.length ? { turns: input.calibration } : null,
    ...(input.options ? { options: input.options } : {}),
  });
  const segments = annotate(result.segments, input.phaseChanges);
  progress(0.55, "annotate");

  // 3. Cleaned tracks, one new encrypted file per seat.
  const cleanFiles: CleanFileOutput[] = [];
  const seatsWithMask = result.masks.filter((m) =>
    result.alignment.some((a) => a.seat === m.seat && input.tracks.some((t) => t.trackId === a.trackId)),
  );
  for (const [i, mask] of seatsWithMask.entries()) {
    const tracks = input.tracks.filter((t) => t.seat === mask.seat);
    const sources: TrackSource[] = tracks.map((t) => ({
      trackId: t.trackId,
      samples: trackSampleEnd(t.chunks),
      chunks: seqOrderedChunks(files, input.sessionId, t.fileName, t.key, t.chunks),
    }));
    const { fileName, key } = await files.createFile(input.sessionId);
    hooks.onFile?.(fileName);
    let seq = 0;
    let samples = 0;
    for await (const block of renderClean(mask.seat, sources, result, mask, {
      attenuationDb: input.clean.attenuationDb,
      fadeMs: input.clean.fadeMs,
      blockSamples: CLEAN_RECORD_SAMPLES,
    })) {
      await files.appendRecord(input.sessionId, fileName, key, seq++, int16ToLeBytes(block));
      samples += block.length;
    }
    cleanFiles.push({
      seat: mask.seat,
      fileName,
      key,
      samples,
      records: seq,
      sourceTrackIds: tracks.map((t) => t.trackId),
    });
    progress(0.55 + (0.43 * (i + 1)) / seatsWithMask.length, "clean");
  }
  progress(0.98, "rendered");
  return { result, segments, cleanFiles, readWarnings };
}

/* ─────────── worker entry ─────────── */

export type WorkerMessage =
  | { type: "progress"; fraction: number; stage: string }
  | { type: "file"; fileName: string }
  | { type: "done"; output: AttributionTaskOutput }
  | { type: "error"; message: string };

if (!isMainThread && parentPort && (workerData as { task?: string } | null)?.task === WORKER_TASK) {
  const port = parentPort;
  const send = (m: WorkerMessage) => port.postMessage(m);
  runAttributionTask((workerData as { input: AttributionTaskInput }).input, {
    onProgress: (fraction, stage) => send({ type: "progress", fraction, stage }),
    onFile: (fileName) => send({ type: "file", fileName }),
  })
    .then((output) => send({ type: "done", output }))
    .catch((e: unknown) => send({ type: "error", message: e instanceof Error ? e.message : String(e) }));
}
