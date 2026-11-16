import { describe, expect, it } from "vitest";
import {
  MAX_TAGS,
  normaliseTags,
  parseSessionConfig,
  playerView,
  reduceEvents,
  SessionConfigSchema,
} from "../src";
import { readySession, testScenario } from "./helpers";

describe("session tags", () => {
  it("splits, trims, collapses whitespace and de-duplicates case-insensitively", () => {
    expect(normaliseTags(" pilot ,  condition   A,,PILOT, b ")).toEqual(["pilot", "condition A", "b"]);
    expect(normaliseTags(["a,b", "c"])).toEqual(["a", "b", "c"]);
    expect(normaliseTags("")).toEqual([]);
  });

  it("caps the number and length of tags", () => {
    const many = Array.from({ length: 50 }, (_, i) => `t${i}`).join(",");
    expect(normaliseTags(many)).toHaveLength(MAX_TAGS);
    expect(normaliseTags("x".repeat(100))[0]).toHaveLength(40);
  });

  it("upgrades a legacy `condition` into tags", () => {
    const cfg = parseSessionConfig({ condition: "pilot, A" });
    expect(cfg.tags).toEqual(["pilot", "A"]);
    expect((cfg as Record<string, unknown>).condition).toBeUndefined();
    expect(parseSessionConfig({ condition: "" }).tags).toEqual([]);
    expect(parseSessionConfig({}).tags).toEqual([]);
  });

  it("rejects tags containing commas when parsed strictly", () => {
    expect(SessionConfigSchema.safeParse({ tags: ["a,b"] }).success).toBe(false);
  });
});

describe("player appearance", () => {
  it("defaults to Mocha with CRT on and is passed to every player", () => {
    const log = readySession({ appearance: { playerTheme: "latte", playerAnimations: false } });
    for (let seat = 1; seat <= 4; seat++) {
      expect(playerView(log.state, testScenario, seat, null, 0).appearance).toEqual({
        playerTheme: "latte",
        playerAnimations: false,
      });
    }
    expect(parseSessionConfig({}).appearance).toEqual({ playerTheme: "mocha", playerAnimations: true });
  });

  it("upgrades the legacy appearance.playerCrt flag", () => {
    expect(parseSessionConfig({ appearance: { playerTheme: "latte", playerCrt: false } }).appearance).toEqual(
      {
        playerTheme: "latte",
        playerAnimations: false,
      },
    );
  });

  it("replays old SessionCreated events that still use `condition`", () => {
    const log = readySession();
    const ev = log.events[0]!;
    (ev.payload as { config: Record<string, unknown> }).config = { condition: "legacy" };
    // reducer upgrades on replay
    expect(reduceEvents([ev]).config.tags).toEqual(["legacy"]);
  });
});
