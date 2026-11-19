import path from "node:path";
import type { PlayerMode, SessionSummary } from "@wkwa/shared";
import type { SessionRow, Store } from "./store";

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

  all(): Array<{ players: PlayerMode; store: Store }> {
    return [
      { players: "real", store: this.real },
      { players: "simulated", store: this.simulated },
    ];
  }

  /** Which database holds this session (and its row)? */
  find(sessionId: string): { players: PlayerMode; store: Store; row: SessionRow } | null {
    for (const { players, store } of this.all()) {
      const row = store.getSession(sessionId);
      if (row) return { players, store, row };
    }
    return null;
  }

  /** Rows from both databases, each tagged with the database it came from. */
  collect<T>(fn: (store: Store) => T[]): Array<T & { players: PlayerMode }> {
    return this.all().flatMap(({ players, store }) => fn(store).map((x) => ({ ...x, players })));
  }

  /** Sessions of both databases, newest first. */
  listSessions(): Array<SessionSummary & { players: PlayerMode }> {
    return this.collect((s) => s.listSessions()).sort((a, b) => b.createdWall.localeCompare(a.createdWall));
  }

  /** The most recently created session (of either database) that has not ended. */
  latestUnfinished(): { id: string; createdWall: string } | null {
    const rows = this.all()
      .map(({ store }) => store.latestUnfinishedSession())
      .filter((r) => r !== null);
    return rows.sort((a, b) => b.createdWall.localeCompare(a.createdWall))[0] ?? null;
  }
}
