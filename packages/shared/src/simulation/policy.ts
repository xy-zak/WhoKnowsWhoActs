import type { z } from "zod";
import { PolicyIdSchema, type SimulationConfig } from "../config";
import { ACTION_KINDS, type ActionKind } from "../labels";
import { type PlayerView, quotaLeft } from "../projections";

/* ═══════════════════════════════════════════════════════════════════════════
 * SIMULATED PLAYERS — the contract between the harness and an agent policy.
 *
 * In a simulated session every seat is played by an *agent*. The server's
 * simulation runner gives the agent a turn now and then; on each turn the
 * agent's *policy* looks at exactly what a real player of that seat would see
 * (the same `PlayerView` projection, so the information asymmetry between
 * seats holds for agents too) and answers with one action or none.
 *
 * Whatever the agent returns goes through the same validators, quotas and
 * event log as a real player's click. A policy cannot change the game state
 * directly, so the rules for simulated and real players stay identical.
 *
 * Policies are pure TypeScript (no I/O, no clock, no Math.random) so they run
 * the same on the server and in tests, and a run is reproducible from its seed.
 * Write new ones in ./policies.ts and register them there.
 * ═══════════════════════════════════════════════════════════════════════════ */

/** One action an agent wants to take on its turn. */
export interface AgentAction {
  kind: ActionKind;
  regionId: string;
}

/** The server's answer to an agent's action (the same acknowledgement a player's browser gets). */
export type AgentFeedback =
  | { ok: true; action: AgentAction; seq: number }
  | { ok: false; action: AgentAction; reason: string; detail: string };

/** Everything a policy gets besides the view. */
export interface AgentContext<P = Record<string, unknown>> {
  /** The seat this agent plays. */
  readonly seat: number;
  /** Effective parameters: the policy's defaults completed with the session's `simulation.params`. */
  readonly params: P;
  /** Seeded random number in [0, 1). Use this, never Math.random(), so a run can be reproduced from its seed. */
  readonly random: () => number;
  /** Scratch memory kept between this agent's turns (in memory only; starts empty after a server restart). */
  readonly memory: Record<string, unknown>;
  /** Server time of this turn (epoch ms). */
  readonly now: number;
}

/**
 * An agent policy: how a simulated player decides. The game rules for
 * simulations are still open, so this is deliberately small: a policy only
 * has to implement `act`.
 */
export interface PlayerPolicy<P extends z.ZodObject = z.ZodObject> {
  /** Stable id used in the session config and the event log (lowercase, digits, dashes). */
  id: string;
  /** Bump whenever the behaviour changes; logged per seat in `AgentBound` for reproducibility. */
  version: string;
  /** Short name for the setup screen. */
  name: string;
  /** One or two sentences: what the policy does (shown in setup and ARCHITECTURE.md). */
  description: string;
  /** Parameters with defaults and a `.describe()` per field (documented automatically). */
  params: P;
  /**
   * Called on every turn the runner gives this agent. Return one action, or
   * null to pass (the agent is asked again after its next pause).
   */
  act(view: PlayerView, ctx: AgentContext<z.output<P>>): AgentAction | null;
  /** Optional: told whether the action of this turn was accepted or rejected (and why). */
  onFeedback?(feedback: AgentFeedback, ctx: AgentContext<z.output<P>>): void;
}

/** Identity helper that infers the parameter type for `act` from `params`. */
export function definePolicy<P extends z.ZodObject>(policy: PlayerPolicy<P>): PlayerPolicy<P> {
  return policy;
}

/* ─────────────────────────── Registry ─────────────────────────── */

const REGISTRY = new Map<string, PlayerPolicy>();

/** Make a policy available to sessions (and to the setup screen). */
export function registerPolicy<P extends z.ZodObject>(policy: PlayerPolicy<P>): void {
  if (!PolicyIdSchema.safeParse(policy.id).success) {
    throw new Error(`Invalid policy id '${policy.id}' (lowercase letters, digits and dashes)`);
  }
  if (REGISTRY.has(policy.id)) throw new Error(`Policy '${policy.id}' is already registered`);
  REGISTRY.set(policy.id, policy as unknown as PlayerPolicy);
}

export function getPolicy(id: string): PlayerPolicy | undefined {
  return REGISTRY.get(id);
}

/** All registered policies, in registration order. */
export function listPolicies(): PlayerPolicy[] {
  return [...REGISTRY.values()];
}

/* ─────────────────────────── Session config helpers ─────────────────────────── */

/** The policy id that plays `seat`, from a session's simulation settings. */
export function seatPolicyId(sim: SimulationConfig, seat: number): string {
  return sim.seatPolicies[String(seat)] ?? sim.policy;
}

/** Seed of one agent's random stream: the session seed plus the seat number. */
export function agentSeed(sessionSeed: string, seat: number): string {
  return `${sessionSeed}:${seat}`;
}

/** Complete and check a policy's parameters; throws a readable error if they are invalid. */
export function resolvePolicyParams(policy: PlayerPolicy, raw: unknown): Record<string, unknown> {
  const r = policy.params.safeParse(raw ?? {});
  if (!r.success) {
    const issue = r.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    throw new Error(`Parameters of policy '${policy.id}': ${where}${issue?.message ?? "invalid"}`);
  }
  return r.data as Record<string, unknown>;
}

/**
 * Check the simulation settings of a session with `seatCount` seats against
 * the registry. Returns a readable problem, or null when everything is fine.
 */
export function checkSimulationConfig(sim: SimulationConfig, seatCount: number): string | null {
  if (sim.minDelayMs > sim.maxDelayMs) return "The shortest pause is longer than the longest pause";
  for (const key of Object.keys(sim.seatPolicies)) {
    const n = Number(key);
    if (n < 1 || n > seatCount)
      return `Policy override for seat ${key}, but the session has ${seatCount} seats`;
  }
  const used = new Set<string>();
  for (let seat = 1; seat <= seatCount; seat++) used.add(seatPolicyId(sim, seat));
  for (const id of used) {
    const policy = getPolicy(id);
    if (!policy) return `Unknown policy '${id}' (registered: ${[...REGISTRY.keys()].join(", ")})`;
    try {
      resolvePolicyParams(policy, sim.params[id]);
    } catch (e) {
      return (e as Error).message;
    }
  }
  return null;
}

/* ─────────────────────────── Helpers for writing policies ─────────────────────────── */

/** True while this seat may act: a round is running, not paused, and the seat has not withdrawn. */
export function canAct(view: PlayerView): boolean {
  return view.phase === "round_active" && !view.paused && !view.me.withdrawn;
}

/** Actions of `kind` this seat may still take this round (Infinity when unlimited). */
export function actionsLeft(view: PlayerView, kind: ActionKind): number {
  return quotaLeft(view.me.quota[kind]);
}

/** Action kinds with quota left this round. */
export function kindsWithQuota(view: PlayerView): ActionKind[] {
  return ACTION_KINDS.filter((k) => actionsLeft(view, k) > 0);
}

/** A uniformly random element of a non-empty list. */
export function pick<T>(list: readonly T[], random: () => number): T {
  if (list.length === 0) throw new Error("pick() from an empty list");
  return list[Math.min(list.length - 1, Math.floor(random() * list.length))]!;
}
