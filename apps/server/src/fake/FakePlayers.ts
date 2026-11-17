import { randomBytes } from "node:crypto";
import { FAKE_PLAYER_PACES, type FakePlayerPace } from "@wkwa/shared";
import type { Logger } from "pino";
import { Bot } from "../tools/botClient";

/**
 * Fake players: test clients the server creates itself, for trying a session
 * with real (not simulated) players when no group of people is present.
 *
 * A fake player is a real network client. It connects to this server's
 * `/player` namespace over the loopback interface exactly like a browser (hello,
 * client number, seat token, state pushes, intents with acks) and proposes and
 * decides at random. What makes it fake is decided here, on the server: its
 * terminal key is registered before it connects, so the hub knows that client
 * is not a person and marks its seat `fake` when it is bound. A browser can
 * never claim to be fake. Fake seats get no participant code and skip
 * onboarding, so no consent record or demographic answer is ever made up.
 */
export class FakePlayers {
  private readonly bots = new Map<string, Bot>();

  constructor(
    private readonly deps: {
      /** URL of this server, once it listens (e.g. http://127.0.0.1:3000). */
      selfUrl: () => Promise<string>;
      log: Logger;
    },
  ) {}

  /** Is this terminal key one of ours? */
  isFake(terminalKey: string | undefined): boolean {
    return terminalKey !== undefined && this.bots.has(terminalKey);
  }

  get count(): number {
    return this.bots.size;
  }

  /**
   * Start one fake player. Its key is registered before the socket connects,
   * so its `hello` is already recognised as fake. With a seat token it
   * re-claims that seat (after a restart).
   */
  async spawn(opts: {
    pace: FakePlayerPace;
    seat: number;
    seatToken?: string | null;
    clientSeqStart?: number;
  }): Promise<Bot> {
    const url = await this.deps.selfUrl();
    const terminalKey = randomBytes(16).toString("hex");
    const pace = FAKE_PLAYER_PACES[opts.pace];
    const bot = new Bot({
      url,
      name: `fake player seat ${opts.seat}`,
      terminalKey,
      seatToken: opts.seatToken ?? null,
      clientSeqStart: opts.clientSeqStart,
      minDelayMs: pace.minDelayMs,
      maxDelayMs: pace.maxDelayMs,
      telemetry: false,
      record: false,
      insecureTls: url.startsWith("https:"),
      log: (m) => this.deps.log.debug(m),
    });
    this.bots.set(terminalKey, bot);
    return bot;
  }

  stop(terminalKey: string) {
    const bot = this.bots.get(terminalKey);
    if (!bot) return;
    this.bots.delete(terminalKey);
    bot.stop();
  }

  stopAll() {
    for (const key of [...this.bots.keys()]) this.stop(key);
  }
}
