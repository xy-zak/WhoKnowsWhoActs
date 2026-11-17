import { getPolicy, type SimulationConfig, seatPolicyId } from "@wkwa/shared";

/** Pace presets for the pause before each agent turn (setup step 03). */
export const PACES = [
  { id: "watch", label: "Watchable · 0.8–2.5 s", min: 800, max: 2500 },
  { id: "quick", label: "Quick · 0.2–0.5 s", min: 200, max: 500 },
  { id: "instant", label: "As fast as possible · 0 s", min: 0, max: 0 },
] as const;

export function paceId(sim: SimulationConfig): string {
  return PACES.find((p) => p.min === sim.minDelayMs && p.max === sim.maxDelayMs)?.id ?? "custom";
}

const secs = (ms: number) => `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : ms % 100 === 0 ? 1 : 2)}`;

/** "0.8–2.5 s" / "0 s (as fast as possible)". */
export function paceText(sim: SimulationConfig): string {
  if (sim.maxDelayMs === 0) return "0 s (as fast as possible)";
  if (sim.minDelayMs === sim.maxDelayMs) return `${secs(sim.minDelayMs)} s`;
  return `${secs(sim.minDelayMs)}–${secs(sim.maxDelayMs)} s`;
}

/** "random ×3, idle ×1" — which policies play the seats. */
export function policySummary(sim: SimulationConfig, seatCount: number): string {
  const counts = new Map<string, number>();
  for (let seat = 1; seat <= seatCount; seat++) {
    const id = seatPolicyId(sim, seat);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts].map(([id, n]) => `${id} ×${n}`).join(", ");
}

/** Display name of a policy id ("Random (random v1)"), tolerant of policies that no longer exist. */
export function policyLabel(id: string): string {
  const p = getPolicy(id);
  return p ? `${p.name} (${p.id} v${p.version})` : `${id} (unknown)`;
}
