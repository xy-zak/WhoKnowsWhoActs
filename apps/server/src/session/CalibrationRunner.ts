/**
 * The facilitator-led calibration of one session (sessions that record audio): each recorded seat
 * in turn reads a sentence aloud while the others stay quiet, so the attribution can measure how
 * loud each voice is on every microphone (see audio/attribution, AUDIO.md § 9).
 *
 * It never starts by surprise: once every seat is through its onboarding (the mic check last), each
 * recorded seat says it is ready (CalibrationReady), and the run starts when the last one does.
 * The server times the turns, so they survive a slow browser and are logged:
 *
 *   CalibrationReady × seats → CalibrationStarted → CalibrationTurn × seats (turnMs each, gapMs
 *     between) → CalibrationCompleted → (once the turns' audio has arrived, at most
 *     CALIBRATION_CHECK_WAIT_MS) → CalibrationChecked
 *
 * A redo (CalibrationRequested: everyone says they are ready again), a skip, a recording pause or a
 * restart ends a running calibration; a timer of an earlier run then does nothing (each run has a
 * number, counted by the reducer: `state.audio.calibrationRuns`).
 * The audio of the turns is collected by LiveAudio (`beginCalibration`), which also stores it as usual.
 *
 * Owned by the SessionManager, like LiveAudio: every event goes through its `append`, inside a
 * command (`run`), and the manager checks the phase and that the session records audio first.
 */
import {
  calibrationNotReadySeats,
  calibrationSeats,
  calibrationWaitingSeats,
  type NewEvent,
  type OnboardingContent,
  type ReadonlyGameState,
  type StoredEvent,
} from "@wkwa/shared";
import type { Logger } from "pino";
import { calibrationCheckedPayload } from "../audio/calibration";
import type { LiveAudio } from "../audio/live";
import { CommandError } from "./errors";

/** How often the calibration check looks whether the last turn's audio has arrived (ms). */
const CALIBRATION_CHECK_POLL_MS = 500;
/**
 * Longest wait for the calibration audio after the last turn (ms): a 5 s chunk is uploaded once it
 * is complete, so the last turn's audio arrives up to about 5 s later. The check then runs with
 * what arrived; a seat without audio is reported as such.
 */
export const CALIBRATION_CHECK_WAIT_MS = 15_000;

type CalibrationContent = NonNullable<OnboardingContent["audio"]>["calibration"];

export interface CalibrationDeps {
  sessionId: string;
  clock: () => number;
  log: Logger;
  state: () => ReadonlyGameState;
  /** Append an event (only inside `run`). */
  append: (ev: NewEvent) => StoredEvent;
  /** Run a command: events appended inside are delivered as one batch. */
  run: <T>(fn: () => T) => T;
  isFinal: () => boolean;
  /** Collects the turns' audio for the quick check. */
  audio: LiveAudio;
  /** The calibration sentences and timing (config/audio.json), if the session has them. */
  content: () => CalibrationContent | undefined;
}

export class CalibrationRunner {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: CalibrationDeps) {}

  private get state() {
    return this.deps.state();
  }

  get running(): boolean {
    return this.state.audio.calibration.status === "running";
  }

  /**
   * Start the waiting calibration: by the server as soon as the room is ready (`system`), or by the
   * facilitator. Possible once every real seat is through its onboarding (past its mic check), every
   * recorded seat has said it is ready, and recording is not paused. Inside a command.
   */
  start(by: "system" | "facilitator") {
    const st = this.state;
    const c = st.audio.calibration;
    if (c.status === "running") throw new CommandError("The calibration is already running");
    if (c.status !== "pending")
      throw new CommandError(`The calibration was already ${c.status}: use 'redo' to run it again`);
    if (st.audio.recordingPaused) throw new CommandError("Recording is paused: resume recording first");
    const waiting = calibrationWaitingSeats(st).map((s) => s.seat);
    if (waiting.length)
      throw new CommandError(`Waiting for the onboarding (mic check) of seat ${waiting.join(", ")}`);
    const order = calibrationSeats(st);
    if (order.length === 0) throw new CommandError("No seat is recorded: skip the calibration instead");
    const notReady = calibrationNotReadySeats(st);
    if (notReady.length)
      throw new CommandError(`Waiting for seat ${notReady.join(", ")} to say they are ready`);
    const content = this.deps.content();
    if (!content) throw new CommandError("No calibration texts (config/audio.json)");
    this.clearTimer();
    // runs are numbered by the reducer (state.audio.calibrationRuns): this one is the next
    const run = st.audio.calibrationRuns + 1;
    // a redo reads other sentences than the run before, where there are enough
    const offset = ((run - 1) * order.length) % content.sentences.length;
    const sentenceIds = order.map((_, i) => content.sentences[(offset + i) % content.sentences.length]!.id);
    const { turnMs, gapMs } = content;
    this.deps.append({
      type: "CalibrationStarted",
      actorKind: by,
      payload: { order, sentenceIds, turnMs, gapMs },
    });
    this.deps.audio.beginCalibration(run, order, this.deps.clock());
    this.turn(run, 0);
  }

  /**
   * Facilitator: run the calibration again. Ends a running one; every recorded seat then says again
   * that it is ready, and the turns start once all have (CalibrationRequested). Inside a command.
   */
  redo() {
    if (this.state.audio.calibration.status === "pending")
      throw new CommandError("The calibration has not run yet: it starts once everyone is ready");
    this.dispose();
    this.deps.append({ type: "CalibrationRequested", actorKind: "facilitator", payload: {} });
  }

  /** Skip the calibration, or cancel a running one (round 1 may then start without it). Inside a command. */
  skip(reason: string) {
    const status = this.state.audio.calibration.status;
    if (status === "done" || status === "skipped")
      throw new CommandError(`The calibration was already ${status}`);
    this.dispose();
    this.deps.append({ type: "CalibrationSkipped", actorKind: "facilitator", payload: { reason } });
  }

  /**
   * End a running calibration on the server's own account (recording paused, server restarted):
   * logged as skipped and `cancelled`, so the facilitator can run it again. Inside a command.
   */
  cancel(reason: string) {
    if (!this.running || this.deps.isFinal()) return;
    this.dispose();
    this.deps.append({
      type: "CalibrationSkipped",
      actorKind: "system",
      payload: { reason, cancelled: true },
    });
  }

  /** Stop the timers and drop the collected audio (a redo, skip or cancel; detach, shutdown, end of the session). */
  dispose() {
    this.clearTimer();
    this.deps.audio.endCalibration();
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Is run `run` still the one in `status`? (Timers of an earlier run then do nothing.) */
  private current(run: number, status: "running" | "done" = "running"): boolean {
    const a = this.state.audio;
    return a.calibrationRuns === run && a.calibration.status === status && !this.deps.isFinal();
  }

  private after(ms: number, fn: () => void) {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        this.deps.run(fn);
      } catch (e) {
        this.deps.log.error({ err: e, sessionId: this.deps.sessionId }, "calibration timer failed");
      }
    }, ms);
  }

  /** Log turn `index` of run `run` and time the next step (inside a command). */
  private turn(run: number, index: number) {
    const c = this.state.audio.calibration;
    const seat = c.order[index]!;
    this.deps.append({
      type: "CalibrationTurn",
      actorKind: "system",
      seat,
      participantCode: this.state.seats[seat]?.participantCode ?? null,
      payload: { index, seat, sentenceId: c.sentenceIds[index]! },
    });
    const turnMs = c.turnMs ?? 0;
    const last = index >= c.order.length - 1;
    this.after(last ? turnMs : turnMs + (c.gapMs ?? 0), () => {
      if (!this.current(run)) return;
      if (last) this.complete(run);
      else this.turn(run, index + 1);
    });
  }

  /** The last turn is over: log CalibrationCompleted, then wait for the audio and check it (inside a command). */
  private complete(run: number) {
    const c = this.state.audio.calibration;
    const turnMs = c.turnMs ?? 0;
    const turns = c.turns.map((t) => ({
      seat: t.seat,
      sentenceId: t.sentenceId,
      startTs: t.startTs,
      endTs: t.endTs ?? t.startTs + turnMs,
    }));
    this.deps.append({ type: "CalibrationCompleted", actorKind: "system", payload: { turns } });
    const lastEnd = Math.max(...turns.map((t) => t.endTs));
    const deadline = this.deps.clock() + CALIBRATION_CHECK_WAIT_MS;
    const poll = () => {
      if (!this.current(run, "done")) return;
      const collector = this.deps.audio.calibration(run);
      if (!collector) return;
      if (!collector.complete(lastEnd) && this.deps.clock() < deadline) {
        this.after(CALIBRATION_CHECK_POLL_MS, poll);
        return;
      }
      try {
        const report = collector.check(turns);
        this.deps.append({
          type: "CalibrationChecked",
          actorKind: "system",
          payload: calibrationCheckedPayload(report, c.order),
        });
      } finally {
        this.deps.audio.endCalibration(run);
      }
    };
    this.after(CALIBRATION_CHECK_POLL_MS, poll);
  }
}
