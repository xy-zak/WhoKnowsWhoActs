import type { ReadonlyGameState } from "@wkwa/shared";

/**
 * The first tab has two faces. SETUP covers everything before participants
 * act (configure → create → bind → labels → key sheet); after "Start
 * onboarding" it flips to LIVE, and back to SETUP once the session is closed
 * or aborted (ready for the next one).
 */
export type Stage = "setup" | "live";

export function stageOf(state: ReadonlyGameState | null | undefined): Stage {
  if (!state) return "setup";
  return ["onboarding", "round_active", "round_complete", "game_complete"].includes(state.phase)
    ? "live"
    : "setup";
}

/** A session is attached and still in its lobby (setup steps 7–10). */
export function inLobby(state: ReadonlyGameState | null | undefined): boolean {
  return state?.phase === "lobby";
}

export const PHASE_LABEL: Record<ReadonlyGameState["phase"], string> = {
  lobby: "LOBBY",
  onboarding: "ONBOARDING",
  round_active: "ROUND",
  round_complete: "ROUND BREAK",
  game_complete: "WRAP-UP",
  closed: "CLOSED",
  aborted: "ABORTED",
};
