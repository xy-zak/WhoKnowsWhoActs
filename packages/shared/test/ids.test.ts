import { describe, expect, it } from "vitest";
import { generateParticipantCode, generateSessionId, normaliseParticipantCode } from "../src";

describe("participant codes", () => {
  it("generates well-formed, self-validating codes", () => {
    for (let i = 0; i < 500; i++) {
      const code = generateParticipantCode();
      expect(code).toMatch(/^WK-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]$/);
      expect(normaliseParticipantCode(code)).toBe(code);
    }
  });

  it("is practically unique", () => {
    const set = new Set(Array.from({ length: 5000 }, generateParticipantCode));
    expect(set.size).toBe(5000);
  });

  it("normalises sloppy input (case, spaces, O/0, I/1)", () => {
    const code = generateParticipantCode();
    const sloppy = code.toLowerCase().replace(/-/g, " ").replace(/0/g, "o").replace(/1/g, "l");
    expect(normaliseParticipantCode(sloppy)).toBe(code);
    expect(normaliseParticipantCode(code.replace(/^WK-/, ""))).toBe(code);
  });

  it("detects single-character typos via the check character", () => {
    const code = generateParticipantCode();
    const raw = code.replace(/-/g, "").slice(2);
    let detected = 0;
    let total = 0;
    const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    for (let pos = 0; pos < 8; pos++) {
      for (const ch of alphabet) {
        if (ch === raw[pos]) continue;
        total++;
        const typo = raw.slice(0, pos) + ch + raw.slice(pos + 1);
        if (normaliseParticipantCode(typo) === null) detected++;
      }
    }
    expect(detected).toBe(total);
  });

  it("rejects garbage", () => {
    expect(normaliseParticipantCode("")).toBeNull();
    expect(normaliseParticipantCode("WK-1234")).toBeNull();
    expect(normaliseParticipantCode("hello world!!")).toBeNull();
  });
});

describe("session ids", () => {
  it("encode the UTC date", () => {
    expect(generateSessionId(new Date("2026-11-16T10:00:00Z"))).toMatch(/^S-20261116-[0-9A-Z]{4}$/);
  });
});
