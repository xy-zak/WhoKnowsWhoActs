import { isFinalPhase, type ReadonlyGameState } from "@wkwa/shared";

/**
 * The first tab has two faces. SETUP covers everything before participants
 * act (configure → create → bind → labels → key sheet); after "Start
 * onboarding" it flips to LIVE, and back to SETUP once the session is closed
 * or aborted (ready for the next one).
 */
export function stageOf(state: ReadonlyGameState | null | undefined): "setup" | "live" {
  return state && state.phase !== "lobby" && !isFinalPhase(state.phase) ? "live" : "setup";
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
