import { describe, expect, it } from "vitest";
import { DISSOCIATED_PAIRINGS, isFullCycle, K_LABELS, pairedP, pairingText } from "../src";

/** every permutation of 0..3 */
function allPerms(): number[][] {
  const out: number[][] = [];
  const rec = (p: number[], rest: number[]) => {
    if (!rest.length) out.push(p);
    for (const r of rest)
      rec(
        [...p, r],
        rest.filter((x) => x !== r),
      );
  };
  rec([], [0, 1, 2, 3]);
  return out;
}

describe("K–P pairings", () => {
  it("has exactly 6 fully dissociative pairings", () => {
    expect(DISSOCIATED_PAIRINGS).toHaveLength(6);
    expect(new Set(DISSOCIATED_PAIRINGS.map((p) => p.join(""))).size).toBe(6);
  });

  it("each is fully dissociative: no same letter, no player pairs, one single loop", () => {
    for (const p of DISSOCIATED_PAIRINGS) {
      for (let i = 0; i < 4; i++) {
        expect(p[i], "same letter").not.toBe(i);
        expect(p[p[i]!], "mirrored player pair").not.toBe(i);
      }
      expect(isFullCycle(p)).toBe(true);
    }
  });

  it("is complete: every permutation with no fixed point and no 2-cycle is in the table", () => {
    const candidates = allPerms().filter((p) => p.every((v, i) => v !== i && p[v] !== i));
    expect(candidates.map((p) => p.join("")).sort()).toEqual(
      DISSOCIATED_PAIRINGS.map((p) => p.join("")).sort(),
    );
    // the 3 remaining derangements are double swaps (player pairs) and excluded
    const derangements = allPerms().filter((p) => p.every((v, i) => v !== i));
    expect(derangements).toHaveLength(9);
  });

  it("aligned pairs every K with its own letter", () => {
    expect(K_LABELS.map((k) => pairedP(k, { mode: "aligned", id: null }))).toEqual(["Pa", "Pb", "Pc", "Pd"]);
  });

  it("D6 is Ka–Pd Kb–Pc Kc–Pa Kd–Pb", () => {
    expect(pairingText({ mode: "dissociated", id: 6 })).toBe("Ka–Pd Kb–Pc Kc–Pa Kd–Pb");
  });
});
