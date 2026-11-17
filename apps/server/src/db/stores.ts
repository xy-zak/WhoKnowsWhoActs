import path from "node:path";
import type { PlayerMode } from "@wkwa/shared";
import type { Store } from "./store";

/** File names of the two databases in the data directory. */
export const DB_FILES: Record<PlayerMode, string> = {
  real: "wkwa.db",
  simulated: "wkwa-sim.db",
};

export function dbFile(dataDir: string, players: PlayerMode): string {
  return path.join(dataDir, DB_FILES[players]);
}

/** Where exports of each database go: simulations get their own folder. */
export function exportsDirFor(exportsDir: string, players: PlayerMode): string {
  return players === "simulated" ? path.join(exportsDir, "simulations") : exportsDir;
}

/**
 * The participant database (`real`) and the simulation database (`simulated`).
 * Same schema, same passphrase, separate files: simulated sessions never mix
 * with participants' data, and the GDPR tooling (look-up, erasure, key sheets,
 * takedown cards) only ever touches the participant database.
 */
export class SessionStores {
  constructor(
    readonly real: Store,
    readonly simulated: Store,
  ) {}

  of(players: PlayerMode): Store {
    return players === "simulated" ? this.simulated : this.real;
  }

  /** Which database holds this session? */
  find(sessionId: string): { players: PlayerMode; store: Store } | null {
    if (this.real.getSession(sessionId)) return { players: "real", store: this.real };
    if (this.simulated.getSession(sessionId)) return { players: "simulated", store: this.simulated };
    return null;
  }

  all(): Array<{ players: PlayerMode; store: Store }> {
    return [
      { players: "real", store: this.real },
      { players: "simulated", store: this.simulated },
    ];
  }
}
