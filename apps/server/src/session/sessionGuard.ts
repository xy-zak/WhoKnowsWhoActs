/**
 * The session guard: the one rule for "may this operation change this session's stored data now?".
 *
 * A session's stored data may not change while
 *   - it is RUNNING: attached to the hub and not ended (see `sessionHasEnded`), or
 *   - it is BUSY: an attribution job of it is queued or running, or an audio export of it is
 *     being written (the export reads files that a deletion or a re-run would remove).
 *
 * Each operation checks these in a fixed order and answers with its own message (the table
 * `RULES`), so a refusal is a value the REST routes render as it is: `{ status, message }`.
 * The guard also runs what has to happen around the operation:
 *
 *   deleteSession      check → hub.release(id) → delete
 *   eraseParticipant   check (attached session, then each session the code occurs in) → erase
 *                      → hub.reloadActiveSession() when the code occurs in the attached session
 *   exportAudio        check → the session counts as busy while the export is written
 *   check              delete-audio, start-attribution: nothing around them
 *
 * The hub reports the attached session; the job runner reports queued or running jobs; the
 * guard itself keeps the exports in progress. It has no other state.
 */

/** Phases after which a session takes no more game actions (the session row's `status` is its phase). */
const ENDED_PHASES: ReadonlySet<string> = new Set(["game_complete", "closed", "aborted"]);

/** Whether a session in this phase has ended (also true for `game_complete`, which is not yet final). */
export function sessionHasEnded(phase: string): boolean {
  return ENDED_PHASES.has(phase);
}

/** What the guard needs from the hub (the Hub fits as it is). */
export interface AttachedSessionSource {
  readonly session: {
    readonly sessionId: string;
    readonly state: {
      readonly phase: string;
      readonly seats: Readonly<Record<number, { readonly participantCode: string | null }>>;
    };
  } | null;
  /** Detach the session if it is attached (connected players return to the waiting screen). */
  release(sessionId: string): void;
  /** Reload the attached session from its (changed) event log; detaches it if that fails (never throws). */
  reloadActiveSession(): void;
}

/** What the guard needs from the audio job runner (AudioJobRunner fits). */
export interface ActiveJobSource {
  /** The session's attribution job that is queued or running, if any. */
  activeJob(sessionId: string): { readonly jobId: string; readonly status: string } | undefined;
}

export type RefusalReason = "running" | "attribution" | "exporting" | "precondition";

export interface Refusal {
  readonly ok: false;
  readonly status: 409;
  readonly reason: RefusalReason;
  /** The session that is running or busy. */
  readonly sessionId: string;
  readonly message: string;
}

export type Verdict<T = undefined> = { readonly ok: true; readonly value: T } | Refusal;

/** Operations that `check` answers (the others have their own method, which runs what is around them). */
export type CheckedOperation = "delete-audio" | "start-attribution";
type Operation = CheckedOperation | "delete-session" | "export-audio";

/** One step of a rule: what it checks and the message when it refuses. */
type Step =
  | readonly ["running", string]
  | readonly ["precondition"]
  | readonly ["attribution", (job: { jobId: string; status: string }) => string]
  | readonly ["exporting", string];

const JOB = "An attribution of this session is queued or running";
const EXPORT = "An audio export of this session is being written";

/** Per operation: the checks, in the order they run, with the message each one refuses with. */
const RULES: Record<Operation, readonly Step[]> = {
  "delete-session": [
    ["running", "This session is still running. Close or abort it first, then delete it."],
    ["attribution", () => `${JOB}: delete the session when it is done.`],
    ["exporting", `${EXPORT}: delete the session when it is done.`],
  ],
  "delete-audio": [
    ["running", "This session is still running. Close or abort it first, then delete its audio."],
    ["attribution", () => `${JOB}: wait until it ends.`],
    ["exporting", `${EXPORT}: delete the audio when it is done.`],
    ["precondition"],
  ],
  "start-attribution": [
    [
      "running",
      "This session is still running. Speaker attribution works after the session: end, close or abort it first.",
    ],
    ["precondition"],
    ["exporting", `${EXPORT}: start the attribution when it is done.`],
    ["attribution", (job) => `An attribution of this session is already ${job.status} (${job.jobId}).`],
  ],
  "export-audio": [
    [
      "running",
      "This session is still running. Exporting audio works after the session: end, close or abort it first.",
    ],
    ["attribution", () => `${JOB}: export when it ends.`],
  ],
};

const ERASE_RUNNING =
  "This participant is in the running session. Withdraw them, end the session, then erase.";
/** Erasure checks every session the code occurs in: attribution, then export, per session. */
const ERASE_BUSY: readonly Step[] = [
  ["attribution", () => JOB],
  ["exporting", EXPORT],
];

export interface CheckOptions {
  /**
   * The operation's own reason to refuse with 409 (null = none). It runs at the rule's
   * "precondition" step: start-attribution right after the running check, delete-audio last.
   */
  precondition?: () => string | null;
}

export interface SessionGuardDeps {
  /** The hub; null when nothing can be attached (tests, tools). */
  hub: AttachedSessionSource | null;
  jobs: ActiveJobSource;
}

const OK: Verdict = { ok: true, value: undefined };

export class SessionGuard {
  /** Audio exports being written, per session (several may run at once). */
  private readonly exports = new Map<string, number>();

  constructor(private readonly deps: SessionGuardDeps) {}

  /** Whether the session is attached and has not ended. */
  running(sessionId: string): boolean {
    const s = this.deps.hub?.session;
    return Boolean(s && s.sessionId === sessionId && !sessionHasEnded(s.state.phase));
  }

  /** May this operation change the session now? */
  check(op: CheckedOperation, sessionId: string, opts: CheckOptions = {}): Verdict {
    return this.evaluate(RULES[op], sessionId, opts.precondition);
  }

  /** Delete a session: refused while it runs or is busy; otherwise the hub releases it first. */
  deleteSession<T>(sessionId: string, remove: () => T): Verdict<T> {
    const v = this.evaluate(RULES["delete-session"], sessionId);
    if (!v.ok) return v;
    this.deps.hub?.release(sessionId);
    return { ok: true, value: remove() };
  }

  /**
   * Erase a participant: refused while the code is in the running attached session, or while
   * any session it occurs in (`sessionsOf`, read only after that check) is busy. After the
   * erasure the attached session is reloaded if the code occurs in it (seated, or rebound
   * away since), running or not.
   */
  eraseParticipant<T>(code: string, sessionsOf: () => readonly string[], erase: () => T): Verdict<T> {
    const active = this.deps.hub?.session ?? null;
    const seated =
      active != null && Object.values(active.state.seats).some((s) => s.participantCode === code);
    if (seated && !sessionHasEnded(active.state.phase))
      return refusal("running", active.sessionId, ERASE_RUNNING);
    const sessions = sessionsOf();
    const attached = active != null && (seated || sessions.includes(active.sessionId));
    for (const sessionId of sessions) {
      const v = this.evaluate(ERASE_BUSY, sessionId);
      if (!v.ok) return { ...v, message: `${v.message} (session ${sessionId}): erase when it is done.` };
    }
    const value = erase();
    if (attached) this.deps.hub?.reloadActiveSession();
    return { ok: true, value };
  }

  /**
   * Write an audio export: refused while the session runs or has an attribution queued or
   * running; while `write` runs, the session is busy for every other operation.
   */
  async exportAudio<T>(sessionId: string, write: () => Promise<T>): Promise<Verdict<T>> {
    const v = this.evaluate(RULES["export-audio"], sessionId);
    if (!v.ok) return v;
    this.exports.set(sessionId, (this.exports.get(sessionId) ?? 0) + 1);
    try {
      return { ok: true, value: await write() };
    } finally {
      const n = (this.exports.get(sessionId) ?? 1) - 1;
      if (n > 0) this.exports.set(sessionId, n);
      else this.exports.delete(sessionId);
    }
  }

  private evaluate(rule: readonly Step[], sessionId: string, precondition?: () => string | null): Verdict {
    for (const step of rule) {
      switch (step[0]) {
        case "running":
          if (this.running(sessionId)) return refusal("running", sessionId, step[1]);
          break;
        case "precondition": {
          const message = precondition?.() ?? null;
          if (message !== null) return refusal("precondition", sessionId, message);
          break;
        }
        case "attribution": {
          const job = this.deps.jobs.activeJob(sessionId);
          if (job) return refusal("attribution", sessionId, step[1](job));
          break;
        }
        case "exporting":
          if (this.exports.get(sessionId)) return refusal("exporting", sessionId, step[1]);
          break;
      }
    }
    return OK;
  }
}

function refusal(reason: RefusalReason, sessionId: string, message: string): Refusal {
  return { ok: false, status: 409, reason, sessionId, message };
}
