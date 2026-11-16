import { quotaUsed, roundSpecFor } from "@wkwa/shared";
import { describe, expect, it } from "vitest";
import { type EventLog, readySession } from "../../../packages/shared/test/helpers";
import { nextBeat, prevBeat } from "../src/facilitator/Replay";

function act(log: EventLog, seat: number) {
  log.push(
    "ProposalMade",
    {
      regionId: "A",
      quotaUsed: quotaUsed(log.state, seat, "propose") + 1,
      quotaLimit: 5,
      priorProposals: [],
      priorDecisions: [],
      msSinceRoundStart: 0,
    },
    { seat, actor: "player" },
  );
}

function game() {
  const log = readySession({ roundCount: 2 });
  for (let round = 1; round <= 2; round++) {
    log.push("RoundStarted", {
      round,
      spec: roundSpecFor(log.state.config, round),
      startedBy: "facilitator",
    });
    act(log, 1);
    log.push("SessionNote", { text: "between actions" });
    act(log, 2);
    log.push("RoundCompleted", {
      round,
      reason: "facilitator",
      durationMs: 1,
      pausedMs: 0,
      actionCounts: {},
    });
  }
  log.push("GameCompleted", { roundsPlayed: 2, reason: "all_rounds" });
  return log.events;
}

describe("replay pacing (one beat per action, pause at round end)", () => {
  it("steps action by action and stops after each round", () => {
    const events = game();
    const first = events.findIndex((e) => e.type === "ProposalMade");
    const beats: Array<{ type: string; roundEnd: boolean }> = [];
    let c = first;
    while (c < events.length) {
      const b = nextBeat(events, c);
      beats.push({ type: events[b.cursor - 1]!.type, roundEnd: b.roundEnd });
      c = b.cursor;
    }
    expect(beats).toEqual([
      { type: "ProposalMade", roundEnd: false },
      { type: "ProposalMade", roundEnd: false }, // the note in between is applied in the same beat
      { type: "RoundCompleted", roundEnd: true },
      { type: "ProposalMade", roundEnd: false }, // RoundStarted applied together with the first action
      { type: "ProposalMade", roundEnd: false },
      { type: "GameCompleted", roundEnd: true }, // trailing GameCompleted joins the last round end
    ]);
    // 4 actions → 4 one-second beats + 2 round-end stops
    expect(beats.filter((b) => !b.roundEnd)).toHaveLength(4);
  });

  it("steps back one action at a time", () => {
    const events = game();
    const afterSecond = nextBeat(
      events,
      nextBeat(
        events,
        events.findIndex((e) => e.type === "ProposalMade"),
      ).cursor,
    ).cursor;
    const back = prevBeat(events, afterSecond);
    expect(events[back - 1]!.type).toBe("ProposalMade");
    expect(back).toBeLessThan(afterSecond);
  });
});
