/**
 * Audio processing jobs (speaker attribution), started from the DATABASE tab.
 *
 *  - Jobs run one at a time on this server (CPU-heavy), in submission order;
 *    a session never has more than one queued or running job.
 *  - The work itself runs in a `worker_thread` (`runInWorker`), so the event
 *    loop that serves the game and the dashboard is never blocked by the
 *    analysis. `runInline` runs the same task in-process (tests only).
 *  - Every state change is written to `audio_jobs` (queued → running →
 *    done | failed, with progress 0–1). Error texts are scrubbed of anything
 *    that looks like a participant code.
 *  - Files a job creates are listed in the job's params (`pendingFiles`) while it
 *    runs. A failed job, and on start-up a job that was still running when the
 *    server stopped (`recoverStale`), has those files removed unless a stored
 *    derivative refers to them.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { Logger } from "pino";
import type { AudioJobRow, Store } from "../db/store";
import { nowTs, wall } from "../runtime";
import {
  type AttributionTaskInput,
  type AttributionTaskOutput,
  runAttributionTask,
  type TaskHooks,
  WORKER_TASK,
  type WorkerMessage,
} from "./jobWorker";

export type TaskRunner = (
  input: AttributionTaskInput,
  hooks: TaskHooks,
  signal?: AbortSignal,
) => Promise<AttributionTaskOutput>;

/* ─────────── task runners ─────────── */

const OWN_EXT = path.extname(fileURLToPath(import.meta.url));
/** The worker module next to this one, with this module's extension (.ts under tsx, .js if ever compiled). */
const WORKER_URL = new URL(`./jobWorker${OWN_EXT}`, import.meta.url);

/** execArgv for the worker: inherit ours, and make sure TypeScript loads when we run from .ts sources. */
function workerExecArgv(): string[] {
  const argv = [...process.execArgv];
  if (OWN_EXT === ".ts" && !argv.some((a) => a.includes("tsx"))) argv.push("--import", "tsx");
  return argv;
}

/** Run the attribution task in a fresh worker thread (terminated when it is done, fails, or `signal` aborts). */
export const runInWorker: TaskRunner = (input, hooks, signal) =>
  new Promise<AttributionTaskOutput>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Stopped before it started."));
      return;
    }
    const worker = new Worker(WORKER_URL, {
      workerData: { task: WORKER_TASK, input },
      execArgv: workerExecArgv(),
    });
    let settled = false;
    const onAbort = () => finish(() => reject(new Error("Stopped: the server is shutting down.")));
    function finish(fn: () => void) {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      // settle only once the thread is gone: a failed job's files are removed next, and the
      // worker must not still be appending to them
      void worker.terminate().then(fn, fn);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.on("message", (m: WorkerMessage) => {
      if (m.type === "progress") hooks.onProgress?.(m.fraction, m.stage);
      else if (m.type === "file") hooks.onFile?.(m.fileName);
      else if (m.type === "done") finish(() => resolve(m.output));
      else if (m.type === "error") finish(() => reject(new Error(m.message)));
    });
    worker.on("error", (e) => finish(() => reject(e)));
    worker.on("exit", (code) =>
      finish(() => reject(new Error(`The analysis worker stopped unexpectedly (exit code ${code}).`))),
    );
  });

/** The same task in-process (blocks the event loop while `analyse` runs): for tests only. */
export const runInline: TaskRunner = (input, hooks) => runAttributionTask(input, hooks);

/* ─────────── job runner ─────────── */

/** Something that looks like a participant code (WK-XXXX-XXXX-X) never reaches a job row. */
const CODE_LIKE = /\bWK-[0-9A-Z]{4}-?[0-9A-Z]{4}-?[0-9A-Z]\b/gi;

export function scrubError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const clean = msg.replace(CODE_LIKE, "[participant code]").replace(/\s+/g, " ").trim();
  return (clean || "Unknown error").slice(0, 500);
}

export class JobConflictError extends Error {
  readonly statusCode = 409;
  constructor(readonly job: AudioJobRow) {
    super("An audio job for this session is already queued or running.");
  }
}

export interface JobContext {
  jobId: string;
  sessionId: string;
  signal: AbortSignal;
  /** Report progress (0–1); written to the job row a few times per second at most. */
  progress(fraction: number, stage?: string): void;
  /** A file this job created; removed again if the job fails. */
  addPendingFile(fileName: string): void;
}

/** The job's work; resolves to the job's small `result` summary. */
export type JobWork = (ctx: JobContext) => Promise<unknown>;

interface Entry {
  row: AudioJobRow;
  work: JobWork;
  pending: string[];
}

const PROGRESS_WRITE_MS = 250;
const STALE_ERROR = "Interrupted: the server stopped before the job finished. Run it again.";

export class AudioJobRunner {
  private queue: Entry[] = [];
  private current: { entry: Entry; abort: AbortController; done: Promise<void> } | null = null;
  private closed = false;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly store: Store,
    private readonly log?: Logger,
  ) {}

  /** Mark jobs left `queued`/`running` by a previous run of the server as failed, and remove their files. */
  recoverStale(): string[] {
    const stale = this.store.listAudioJobs().filter((j) => j.status === "queued" || j.status === "running");
    for (const j of stale) {
      this.write({ ...j, status: "failed", error: STALE_ERROR }, true);
      this.removeUnreferenced(j.sessionId, pendingOf(j));
    }
    if (stale.length)
      this.log?.warn({ jobs: stale.length }, "audio jobs interrupted by a restart marked failed");
    return stale.map((j) => j.jobId);
  }

  /** The session's queued or running job, if any. */
  activeJob(sessionId: string): AudioJobRow | undefined {
    if (this.current?.entry.row.sessionId === sessionId) return this.current.entry.row;
    return this.queue.find((e) => e.row.sessionId === sessionId)?.row;
  }

  /** Queue a job. Throws JobConflictError if the session already has one queued or running. */
  enqueue(sessionId: string, kind: string, params: Record<string, unknown>, work: JobWork): AudioJobRow {
    if (this.closed) throw new Error("The server is shutting down.");
    const existing = this.activeJob(sessionId);
    if (existing) throw new JobConflictError(existing);
    const row: AudioJobRow = {
      jobId: randomUUID(),
      sessionId,
      kind,
      status: "queued",
      progress: 0,
      params,
      result: null,
      error: null,
      startedWall: wall(nowTs()),
      finishedWall: null,
    };
    this.store.upsertAudioJob(row);
    this.queue.push({ row, work, pending: [] });
    queueMicrotask(() => this.pump());
    return row;
  }

  /** Resolves when nothing is queued or running. */
  whenIdle(): Promise<void> {
    if (!this.current && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Stop: queued jobs fail, the running job is aborted (its worker terminated) and fails. */
  async close(): Promise<void> {
    this.closed = true;
    for (const e of this.queue.splice(0))
      this.write({ ...e.row, status: "failed", error: "Stopped: the server is shutting down." }, true);
    if (this.current) {
      this.current.abort.abort();
      await this.current.done;
    }
    for (const w of this.idleWaiters.splice(0)) w();
  }

  private pump() {
    if (this.current || this.closed) return;
    const entry = this.queue.shift();
    if (!entry) {
      for (const w of this.idleWaiters.splice(0)) w();
      return;
    }
    const abort = new AbortController();
    const done = this.run(entry, abort.signal).finally(() => {
      this.current = null;
      this.pump();
    });
    this.current = { entry, abort, done };
  }

  private async run(entry: Entry, signal: AbortSignal) {
    entry.row = this.write({ ...entry.row, status: "running" });
    let lastWrite = 0;
    let lastStage = "";
    const ctx: JobContext = {
      jobId: entry.row.jobId,
      sessionId: entry.row.sessionId,
      signal,
      progress: (fraction, stage = "") => {
        const p = Math.max(entry.row.progress, Math.min(0.99, Math.max(0, fraction)));
        const now = Date.now();
        if (stage === lastStage && now - lastWrite < PROGRESS_WRITE_MS) {
          entry.row.progress = p;
          return;
        }
        lastWrite = now;
        lastStage = stage;
        entry.row = this.write({ ...entry.row, progress: p });
      },
      addPendingFile: (fileName) => {
        entry.pending.push(fileName);
        entry.row = this.write({
          ...entry.row,
          params: { ...entry.row.params, pendingFiles: entry.pending },
        });
      },
    };
    try {
      const result = await entry.work(ctx);
      const { pendingFiles: _p, ...params } = entry.row.params;
      entry.row = this.write({ ...entry.row, status: "done", progress: 1, params, result }, true);
    } catch (e) {
      const error = scrubError(e);
      this.removeUnreferenced(entry.row.sessionId, entry.pending);
      const { pendingFiles: _p, ...params } = entry.row.params;
      entry.row = this.write({ ...entry.row, status: "failed", params, error }, true);
      this.log?.warn({ jobId: entry.row.jobId, kind: entry.row.kind, error }, "audio job failed");
    }
  }

  private write(row: AudioJobRow, finished = false): AudioJobRow {
    const next = { ...row, finishedWall: finished ? wall(nowTs()) : row.finishedWall };
    try {
      this.store.upsertAudioJob(next);
    } catch (e) {
      // e.g. the session (and its job rows) was deleted while the job ran: nothing left to record
      this.log?.warn({ jobId: row.jobId, error: scrubError(e) }, "audio job row not written");
    }
    return next;
  }

  /** Unlink files a job created that no derivative row refers to (best effort). */
  private removeUnreferenced(sessionId: string, files: readonly string[]) {
    const audio = this.store.audioFiles;
    if (!audio || files.length === 0) return;
    const referenced = new Set(
      this.store
        .audioFileRefs()
        .filter((r) => r.sessionId === sessionId)
        .map((r) => r.fileName),
    );
    for (const f of files) {
      if (referenced.has(f)) continue;
      try {
        audio.deleteFile(sessionId, f);
      } catch (e) {
        this.log?.warn({ error: scrubError(e) }, "could not remove a file of a failed audio job");
      }
    }
  }
}

function pendingOf(j: AudioJobRow): string[] {
  const p = (j.params as { pendingFiles?: unknown }).pendingFiles;
  return Array.isArray(p) ? p.filter((f): f is string => typeof f === "string") : [];
}
