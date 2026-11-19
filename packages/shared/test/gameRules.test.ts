import { describe, expect, it } from "vitest";
import {
  averageScore,
  cellId,
  cellName,
  cellsOf,
  cellsOfSquare,
  formatScoreChanges,
  GAME_RULES,
  type GameRules,
  getGameRules,
  isCellOnBoard,
  knowledgeOfPower,
  mapScoreOf,
  parseCellId,
  playerView,
  reduceEvents,
  replayScores,
  STANDARD,
  scoreChangesForRevoke,
  scoreChangesOf,
  scoresFromMatrices,
  squareId,
  squaresOf,
  standardRules,
  validateIntent,
} from "../src";
import { act, readySession, startRound, TEST_BOARD, TEST_SCORES, testScenario } from "./helpers";

const actor = (seat: number, p: "Pa" | "Pb" | "Pc" | "Pd") => ({ seat, k: null, p });

describe("board geometry and ids", () => {
  it("names squares A1… and sub-squares <square>-<K>", () => {
    expect(squareId(2, 6)).toBe("C7");
    expect(cellId("C7", "Kb")).toBe("C7-Kb");
    expect(parseCellId("C7-Kb")).toEqual({ id: "C7", col: 2, row: 6, cell: "C7-Kb", k: "Kb" });
    expect(parseCellId("C7")).toBeNull();
    expect(parseCellId("C7-Kx")).toBeNull();
    expect(cellName("J10-Kd")).toBe("J10 · Kd");
    expect(cellsOfSquare("B2")).toEqual(["B2-Ka", "B2-Kb", "B2-Kc", "B2-Kd"]);
  });

  it("lists squares row by row and four sub-squares per square", () => {
    expect(squaresOf({ cols: 3, rows: 2 })).toEqual(["A1", "B1", "C1", "A2", "B2", "C2"]);
    expect(cellsOf({ cols: 10, rows: 10 })).toHaveLength(400);
    expect(cellsOf({ cols: 5, rows: 5 })).toHaveLength(100);
    expect(isCellOnBoard({ cols: 5, rows: 5 }, "E5-Ka")).toBe(true);
    expect(isCellOnBoard({ cols: 5, rows: 5 }, "F1-Ka")).toBe(false);
  });

  it("reads starting scores from one matrix per knowledge type and checks the size", () => {
    const m = { Ka: [[1, 2]], Kb: [[3, 4]], Kc: [[5, 6]], Kd: [[7, 8]] };
    const s = scoresFromMatrices({ cols: 2, rows: 1 }, m);
    expect(s).toMatchObject({ "A1-Ka": 1, "B1-Ka": 2, "A1-Kd": 7, "B1-Kd": 8 });
    expect(() => scoresFromMatrices({ cols: 3, rows: 1 }, m)).toThrow(/expected 3/);
    expect(() => scoresFromMatrices({ cols: 2, rows: 1 }, { ...m, Kd: undefined as never })).toThrow(/Kd/);
  });
});

describe("standard rules", () => {
  it("is the default rule set and is registered", () => {
    expect(getGameRules(undefined)).toBe(standardRules);
    expect(GAME_RULES.map((r) => r.id)).toContain("standard");
    expect(readySession().state.rules).toEqual({ id: "standard", version: standardRules.version });
  });

  it("targets the sub-square of the actor's power type", () => {
    expect(knowledgeOfPower("Pc")).toBe("Kc");
    expect(standardRules.targetOf(actor(1, "Pb"), "decide")).toBe("Kb");
    expect(standardRules.targetOf({ seat: 1, k: "Ka", p: null }, "propose")).toBeNull();
  });

  it("a decision adds 4 to the sub-square and takes 1 from the rest of the square, within 0–10", () => {
    const changes = scoreChangesOf(standardRules, TEST_BOARD, TEST_SCORES, {
      kind: "decide",
      regionId: "A1-Ka",
      actor: actor(1, "Pa"),
      round: 1,
    });
    // A1: Ka 5 → 9; Kb 9 → 8; Kc 0 stays 0 (floor), so it is not listed; Kd 1 → 0
    expect(changes).toEqual([
      { regionId: "A1-Ka", from: 5, to: 9 },
      { regionId: "A1-Kb", from: 9, to: 8 },
      { regionId: "A1-Kd", from: 1, to: 0 },
    ]);
    const capped = scoreChangesOf(standardRules, TEST_BOARD, TEST_SCORES, {
      kind: "decide",
      regionId: "A1-Kb",
      actor: actor(2, "Pb"),
      round: 1,
    });
    expect(capped.find((c) => c.regionId === "A1-Kb")).toEqual({ regionId: "A1-Kb", from: 9, to: 10 }); // ceiling
    expect(STANDARD.decide).toEqual({ target: 4, sameSquare: -1 });
  });

  it("a proposal changes no scores", () => {
    expect(
      scoreChangesOf(standardRules, TEST_BOARD, TEST_SCORES, {
        kind: "propose",
        regionId: "B2-Kc",
        actor: actor(3, "Pc"),
        round: 1,
      }),
    ).toEqual([]);
  });

  it("summarises score changes square by square", () => {
    expect(
      formatScoreChanges([
        { regionId: "D3-Ka", from: 4, to: 3 },
        { regionId: "D3-Kd", from: 6, to: 10 },
        { regionId: "E1-Kb", from: 2, to: 1 },
      ]),
    ).toBe("D3: Ka 4→3, Kd 6→10; E1: Kb 2→1");
    expect(formatScoreChanges(undefined)).toBe("");
  });

  it("the map score is the average of every sub-square", () => {
    expect(standardRules.mapScore(TEST_SCORES, TEST_BOARD)).toBeCloseTo(75 / 16);
    expect(averageScore({})).toBeNull();
  });
});

describe("scores in a session", () => {
  it("rejects a sub-square the rules do not give the seat", () => {
    const log = readySession();
    startRound(log);
    // seat 1 holds Pa: only Ka sub-squares
    expect(validateIntent(log.state, 1, { kind: "decide", regionId: "A1-Kb" })).toMatchObject({
      ok: false,
      reason: "rule",
    });
    expect(validateIntent(log.state, 1, { kind: "decide", regionId: "A1-Ka" }).ok).toBe(true);
  });

  it("follows the power type, not the knowledge type, in a dissociated pairing", () => {
    const log = readySession();
    log.push("LabelsAssigned", {
      assignments: [
        { seat: 1, k: "Ka", p: "Pc", view: "Ka" },
        { seat: 2, k: "Kb", p: "Pd", view: "Kb" },
        { seat: 3, k: "Kc", p: "Pb", view: "Kc" },
        { seat: 4, k: "Kd", p: "Pa", view: "Kd" },
      ],
      method: "manual",
      seed: null,
      pairing: { mode: "dissociated", id: 4 },
    });
    startRound(log);
    act(log, 1, "decide", "B2");
    expect(log.state.actions.at(-1)!.regionId).toBe("B2-Kc");
    const v = playerView(log.state, testScenario, 1, null, 0);
    expect(v.me.knows).toBe("Ka");
    expect(v.me.actsOn).toEqual({ propose: "Kc", decide: "Kc" });
    // seat 1 does not know the Kc score it just changed
    expect(v.scores["B2-Kc"]).toBeUndefined();
    expect(v.scores["B2-Ka"]).toBe(4);
  });

  it("the reducer replays the score changes recorded in the events", () => {
    const log = readySession();
    startRound(log);
    act(log, 1, "decide", "A1");
    expect(log.state.scores).toMatchObject({ "A1-Ka": 9, "A1-Kb": 8, "A1-Kc": 0, "A1-Kd": 0 });
    expect(reduceEvents(log.events).scores).toEqual(log.state.scores);
    expect(mapScoreOf(log.state)).toBeCloseTo((75 + 4 - 1 - 1) / 16);
  });

  it("a recorded score change wins over the current rules (history never changes)", () => {
    const log = readySession();
    startRound(log);
    log.push(
      "DecisionMade",
      {
        regionId: "B1-Ka",
        quotaUsed: 1,
        quotaLimit: 5,
        priorProposals: [],
        priorDecisions: [],
        msSinceRoundStart: 0,
        scoreChanges: [{ regionId: "B1-Ka", from: 5, to: 7 }], // as recorded by an older rule version
      },
      { seat: 1, actor: "player" },
    );
    expect(log.state.scores["B1-Ka"]).toBe(7);
    expect(log.state.scores["B1-Kb"]).toBe(5);
  });

  it("revoking a decision replays the scores without it", () => {
    const log = readySession();
    startRound(log);
    act(log, 2, "decide", "A1"); // A1-Kb 9 → 10 (capped), Ka 5 → 4, Kd 1 → 0
    const first = log.state.actions.at(-1)!;
    act(log, 2, "decide", "A1"); // Kb stays 10, Ka 4 → 3, Kd stays 0
    expect(log.state.scores).toMatchObject({ "A1-Ka": 3, "A1-Kb": 10, "A1-Kc": 0, "A1-Kd": 0 });
    const changes = scoreChangesForRevoke(log.state, first.seq);
    // without the first decision: Kb 9 + 4 → 10 (no change), Ka 5 − 1 = 4
    expect(changes).toEqual([{ regionId: "A1-Ka", from: 3, to: 4 }]);
    log.push(
      "ActionRevoked",
      {
        targetSeq: first.seq,
        targetType: "DecisionMade",
        targetSeat: 2,
        regionId: first.regionId,
        reason: "misclick",
        scoreChanges: changes,
      },
      { actor: "facilitator" },
    );
    expect(log.state.scores["A1-Ka"]).toBe(4);
  });

  it("a new rule set plugs in without touching the harness", () => {
    const doubleOrNothing: GameRules = {
      ...standardRules,
      id: "test-any",
      version: "1",
      targetOf: () => "Kd",
      deltas: (a) => ({ [a.regionId]: a.kind === "decide" ? 10 : 0 }),
      mapScore: (scores) => averageScore(scores),
    };
    const scores = replayScores(doubleOrNothing, TEST_BOARD, TEST_SCORES, [
      { kind: "decide", regionId: "B2-Kd", actor: actor(1, "Pa"), round: 1 },
    ]);
    expect(scores["B2-Kd"]).toBe(10);
    expect(scores["B2-Ka"]).toBe(5);
  });
});
