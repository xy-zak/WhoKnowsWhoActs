import { type SpeechCheckResult, SpeechDetector } from "../audio";
import { Store } from "../net/store";

/*
 * One mic check on the player's screen (MicCheckScreen renders its snapshot): the attempts the
 * participant starts, the speech heard in each, and when the result goes to the server as
 * `mic:check` (research data):
 *  - Start (or "Start again", "Try again") begins an attempt with a fresh speech detector, fed
 *    the recorder's 16 kHz blocks; the result shown is refreshed every 150 ms, a pass at once;
 *  - a pass shows its confirmation for 1.2 s, then it is sent once (passed: true); a pass the
 *    server did not take is sent again with "Continue";
 *  - 20 s of audio without a pass: the attempt gave up, logged once (passed: false), and the
 *    participant can start again; a later pass in the same attempt is still sent;
 *  - `attempts` counts the attempts on this screen, `durationMs` runs from when it opened.
 * No React and no timers of its own: the clock, the detector and the submit port are injected.
 */

/** An attempt that has heard this much audio without passing gives up (logged once; "Start again"). */
export const GIVE_UP_MS = 20_000;
/** The "passed" confirmation stays this long before the result is sent. */
export const PASSED_HOLD_MS = 1200;
/** The speech heard is shown at most this often (a pass at once). */
const SHOW_EVERY_MS = 150;

/** What one `mic:check` reports (the screen adds the capture settings and the time). */
export interface MicCheckOutcome {
  passed: boolean;
  /** attempts on this screen so far (at least 1) */
  attempts: number;
  /** since the screen opened (ms) */
  durationMs: number;
  result: SpeechCheckResult;
}

export interface MicCheckClock {
  /** ms, monotonic (performance.now()) */
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SpeechSource {
  push(samples: Float32Array): SpeechCheckResult;
}

export interface MicCheckAttemptOptions {
  /** speech needed to pass (ms) */
  minSpeechMs: number;
  /** Sends `mic:check`; resolves true when the server took it (false: refused or failed). */
  submit(outcome: MicCheckOutcome): Promise<boolean>;
  /** Default: performance.now() and the global timers. */
  clock?: MicCheckClock;
  /** Default: a SpeechDetector. */
  detector?(minSpeechMs: number): SpeechSource;
}

export interface MicCheckSnapshot {
  /** attempts started (0: Start not clicked yet) */
  attempts: number;
  /** the latest speech result of this attempt (null before its first) */
  result: SpeechCheckResult | null;
  /** this attempt passed: the confirmation shows, then the result is sent */
  passed: boolean;
  /** this attempt heard GIVE_UP_MS of audio without passing */
  gaveUp: boolean;
  /** a result is being sent */
  busy: boolean;
  /** a pass the server did not take: resend() ("Continue") sends it again */
  unsent: boolean;
}

const browserClock: MicCheckClock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class MicCheckAttempt {
  readonly store = new Store<MicCheckSnapshot>({
    attempts: 0,
    result: null,
    passed: false,
    gaveUp: false,
    busy: false,
    unsent: false,
  });
  private readonly clock: MicCheckClock;
  private readonly openedAt: number;
  private detector: SpeechSource | null = null;
  private shownAt = 0;
  private failLogged = false;
  private passTimer: unknown = null;
  private unsentResult: SpeechCheckResult | null = null;

  constructor(private readonly o: MicCheckAttemptOptions) {
    this.clock = o.clock ?? browserClock;
    this.openedAt = this.clock.now();
  }

  get snapshot(): MicCheckSnapshot {
    return this.store.get();
  }

  /** A new attempt (the Start click; call the recorder's startFromClick in the same click). */
  start() {
    this.detector =
      this.o.detector?.(this.o.minSpeechMs) ?? new SpeechDetector({ minSpeechMs: this.o.minSpeechMs });
    this.shownAt = 0;
    this.failLogged = false;
    this.unsentResult = null;
    this.store.set((s) => ({
      ...s,
      attempts: s.attempts + 1,
      result: null,
      passed: false,
      gaveUp: false,
      unsent: false,
    }));
  }

  /** One 16 kHz block from the recorder (its tap); ignored before the first attempt. */
  push(samples: Float32Array) {
    if (!this.detector) return;
    const r = this.detector.push(samples);
    const t = this.clock.now();
    if (!r.passed && t - this.shownAt <= SHOW_EVERY_MS) return;
    this.shownAt = t;
    this.show(r);
  }

  /** "Continue": sends the pass the server did not take again. */
  resend() {
    const r = this.unsentResult;
    if (!r) return;
    void this.send(r, true, this.snapshot.attempts).then((ok) => {
      if (!ok) return;
      this.unsentResult = null;
      this.store.set((s) => ({ ...s, unsent: false }));
    });
  }

  /** The screen unmounts: a pass still in its confirmation is not sent. */
  close() {
    if (this.passTimer !== null) this.clock.clearTimeout(this.passTimer);
    this.passTimer = null;
  }

  private show(r: SpeechCheckResult) {
    const s = this.snapshot;
    if (r.passed && !s.passed) {
      // the confirmation first, then the result (the server moves this seat on to the next step)
      this.store.set({ ...s, result: r, passed: true, gaveUp: false });
      const attempts = s.attempts;
      this.passTimer = this.clock.setTimeout(() => {
        this.passTimer = null;
        void this.send(r, true, attempts).then((ok) => {
          this.unsentResult = ok ? null : r;
          this.store.set((x) => ({ ...x, unsent: !ok }));
        });
      }, PASSED_HOLD_MS);
      return;
    }
    const gaveUp = !r.passed && r.analysedMs >= GIVE_UP_MS;
    this.store.set({ ...s, result: r, gaveUp });
    if (gaveUp && !this.failLogged) {
      // the failed attempt, once (the facilitator sees the levels)
      this.failLogged = true;
      void this.send(r, false, s.attempts);
    }
  }

  private async send(result: SpeechCheckResult, passed: boolean, attempts: number): Promise<boolean> {
    this.store.set((s) => ({ ...s, busy: true }));
    try {
      return await this.o.submit({
        passed,
        attempts: Math.max(1, attempts),
        durationMs: Math.round(this.clock.now() - this.openedAt),
        result,
      });
    } catch {
      return false;
    } finally {
      this.store.set((s) => ({ ...s, busy: false }));
    }
  }
}
