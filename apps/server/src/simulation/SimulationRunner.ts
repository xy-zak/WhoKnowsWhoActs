import {
  ACTION_KINDS,
  type ActionKind,
  type AgentAction,
  type AgentContext,
  type AgentFeedback,
  getPolicy,
  type PlayerPolicy,
  playerView,
  seatList,
  seededRandom,
} from "@wkwa/shared";
import type { Logger } from "pino";
import { nowTs } from "../runtime";
import type { SessionManager } from "../session/SessionManager";

/** After a pass (or an error) an agent is asked again after at least this long. */
export const PASS_RETRY_MS = 250;
/** An agent whose policy throws this many times in a row is stopped (and a SessionNote says so). */
export const MAX_CONSECUTIVE_ERRORS = 3;

interface Agent {
  seat: number;
  policy: PlayerPolicy;
  params: Record<string, unknown>;
  /** The policy's random stream (seeded). */
  random: () => number;
  /** Separate stream for the pauses between turns, so pacing never changes the policy's choices. */
  timing: () => number;
  memory: Record<string, unknown>;
  timer: NodeJS.Timeout | null;
  busy: boolean;
  errors: number;
  stopped: boolean;
}

/**
 * Plays the agents of ONE simulated session. Each agent gets a turn after a
 * pause drawn from [minDelayMs, maxDelayMs] while a round is running (and not
 * paused). On a turn the agent's policy sees exactly what a player of that
 * seat would see (`playerView`) and may return one action, which goes through
 * `SessionManager.intent` like a real player's click: same validators, same
 * quotas, same events.
 *
 * Reproducibility: the policy's random numbers come from the seed logged in
 * `AgentBound`. With both delays 0 the agents take turns in a fixed seat
 * order, so a run repeats exactly from its seed. With real-time pauses the
 * agents' choices are still seeded, but their interleaving depends on timers.
 */
export class SimulationRunner {
  private readonly agents = new Map<number, Agent>();
  private disposed = false;

  constructor(
    private readonly session: SessionManager,
    private readonly log: Logger,
    private readonly clock: () => number = nowTs,
  ) {
    const st = session.state;
    // A session resumed after round 1 started gets fresh streams (seed@seq), not a replay of the old ones.
    const suffix = st.round > 0 ? `@${st.lastSeq}` : "";
    const bound = session.store
      .listEvents(session.sessionId)
      .filter((e) => e.type === "AgentBound")
      .map(
        (e) =>
          e.payload as {
            seat: number;
            policy: string;
            policyVersion: string;
            params: Record<string, unknown>;
            seed: string;
          },
      );
    for (const b of bound) {
      const policy = getPolicy(b.policy);
      if (!policy) {
        log.error({ seat: b.seat, policy: b.policy }, "agent policy no longer exists; seat stays idle");
        continue;
      }
      if (policy.version !== b.policyVersion) {
        log.warn(
          { seat: b.seat, policy: b.policy, logged: b.policyVersion, current: policy.version },
          "agent policy changed since the session was created",
        );
      }
      this.agents.set(b.seat, {
        seat: b.seat,
        policy,
        params: b.params,
        random: seededRandom(`${b.seed}${suffix}`),
        timing: seededRandom(`${b.seed}${suffix}:timing`),
        memory: {},
        timer: null,
        busy: false,
        errors: 0,
        stopped: false,
      });
    }
  }

  /** Bring every agent's timer in line with the current state. Call after every batch of events. */
  sync() {
    if (this.disposed) return;
    // seat order, so with zero pauses the turns go 1, 2, 3, 4, 1, …
    for (const s of seatList(this.session.state)) {
      const a = this.agents.get(s.seat);
      if (!a || a.busy || a.stopped) continue;
      if (this.mayAct(a)) {
        if (!a.timer) this.schedule(a, this.pause(a));
      } else this.clear(a);
    }
  }

  dispose() {
    this.disposed = true;
    for (const a of this.agents.values()) this.clear(a);
  }

  /** For tests and the dashboard: which agents are currently stopped after errors. */
  stoppedSeats(): number[] {
    return [...this.agents.values()].filter((a) => a.stopped).map((a) => a.seat);
  }

  /* ─────────────────────────── internals ─────────────────────────── */

  private mayAct(a: Agent): boolean {
    const st = this.session.state;
    const s = st.seats[a.seat];
    return st.phase === "round_active" && !st.paused && Boolean(s?.bound && !s.withdrawn);
  }

  private pause(a: Agent): number {
    const { minDelayMs, maxDelayMs } = this.session.state.config.simulation;
    return minDelayMs + a.timing() * Math.max(0, maxDelayMs - minDelayMs);
  }

  private schedule(a: Agent, ms: number) {
    this.clear(a);
    a.timer = setTimeout(() => this.turn(a), ms);
  }

  private clear(a: Agent) {
    if (a.timer) clearTimeout(a.timer);
    a.timer = null;
  }

  private context(a: Agent, now: number): AgentContext {
    return { seat: a.seat, params: a.params, random: a.random, memory: a.memory, now };
  }

  private turn(a: Agent) {
    a.timer = null;
    if (this.disposed || a.stopped || !this.mayAct(a)) return;
    a.busy = true;
    let acted = false;
    let failed = false;
    try {
      const now = this.clock();
      const view = playerView(this.session.state, this.session.scenario, a.seat, null, now);
      const ctx = this.context(a, now);
      let action: AgentAction | null;
      try {
        action = a.policy.act(view, ctx);
        if (action !== null) checkAction(action);
        a.errors = 0;
      } catch (e) {
        failed = true;
        this.fail(a, e);
        return;
      }
      if (!action) return;
      acted = true;
      const ack = this.session.intent(a.seat, {
        clientSeq: this.session.nextClientSeq(a.seat),
        kind: action.kind,
        regionId: action.regionId,
        clientTs: now,
      });
      if (a.policy.onFeedback) {
        const fb: AgentFeedback = ack.ok
          ? { ok: true, action, seq: ack.seq }
          : { ok: false, action, reason: ack.reason, detail: ack.detail };
        try {
          a.policy.onFeedback(fb, ctx);
        } catch (e) {
          failed = true;
          this.fail(a, e);
        }
      }
    } catch (e) {
      this.log.error({ err: e, seat: a.seat }, "agent turn failed");
    } finally {
      a.busy = false;
      if (!this.disposed && !a.stopped && this.mayAct(a)) {
        this.schedule(a, acted && !failed ? this.pause(a) : Math.max(PASS_RETRY_MS, this.pause(a)));
      }
    }
  }

  private fail(a: Agent, e: unknown) {
    a.errors++;
    const msg = e instanceof Error ? e.message : String(e);
    this.log.error({ err: e, seat: a.seat, policy: a.policy.id, errors: a.errors }, "agent policy failed");
    if (a.errors >= MAX_CONSECUTIVE_ERRORS) {
      a.stopped = true;
      this.clear(a);
      this.session.systemNote(
        `Agent at seat ${a.seat} (policy ${a.policy.id} v${a.policy.version}) stopped after ${a.errors} errors in a row: ${msg}`,
      );
    }
  }
}

function checkAction(action: AgentAction) {
  if (!ACTION_KINDS.includes(action.kind as ActionKind)) {
    throw new Error(`policy returned an unknown action kind '${String(action.kind)}'`);
  }
  if (typeof action.regionId !== "string" || action.regionId.length === 0) {
    throw new Error("policy returned an action without a regionId");
  }
}
