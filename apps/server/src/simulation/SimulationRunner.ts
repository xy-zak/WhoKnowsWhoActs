import {
  type AgentAction,
  type AgentContext,
  type AgentFeedback,
  getPolicy,
  IntentMsg,
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
 * quotas, same events. The agents' policies, parameters and seeds come from
 * the seat state (`AgentBound`).
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
  ) {
    const st = session.state;
    // A session resumed after round 1 started gets fresh streams (seed@seq), not a replay of the old ones.
    const suffix = st.round > 0 ? `@${st.lastSeq}` : "";
    for (const s of seatList(st)) {
      if (!s.agent) continue;
      const { policy: id, policyVersion, params, seed } = s.agent;
      const policy = getPolicy(id);
      if (!policy) {
        log.error({ seat: s.seat, policy: id }, "agent policy no longer exists; seat stays idle");
        continue;
      }
      if (policy.version !== policyVersion) {
        log.warn(
          { seat: s.seat, policy: id, logged: policyVersion, current: policy.version },
          "agent policy changed since the session was created",
        );
      }
      this.agents.set(s.seat, {
        seat: s.seat,
        policy,
        params,
        random: seededRandom(`${seed}${suffix}`),
        timing: seededRandom(`${seed}${suffix}:timing`),
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
      const now = nowTs();
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

/** Agents' actions are checked like a browser's intent message (same kinds, same region id limits). */
const ActionShape = IntentMsg.pick({ kind: true, regionId: true });

function checkAction(action: AgentAction) {
  const r = ActionShape.safeParse(action);
  if (!r.success) throw new Error(`policy returned an invalid action: ${r.error.issues[0]?.message ?? ""}`);
}
