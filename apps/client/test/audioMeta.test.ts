import { MIC_LEVEL_STATES } from "@wkwa/shared";
import { describe, expect, it } from "vitest";
import {
  CLIP_PEAK_DB,
  cellCount,
  dbToCells,
  formatDb,
  levelState,
  levelTone,
  meterCells,
  meterValue,
  QUIET_DB,
  REC_STATE_META,
  REC_STATES,
  recStateMeta,
} from "../src/ui/audioMeta";
import { ICON_TABLE } from "../src/ui/icons";

describe("dbToCells", () => {
  it("maps the default −60…0 dB scale onto 12 cells (5 dB per cell, rounded)", () => {
    expect(dbToCells(0)).toBe(12);
    expect(dbToCells(-30)).toBe(6);
    expect(dbToCells(-24)).toBe(7); // 36/60 × 12 = 7.2
    expect(dbToCells(-57.5)).toBe(1); // half a cell rounds up
    expect(dbToCells(-59)).toBe(0);
  });
  it("clamps to the scale", () => {
    expect(dbToCells(-60)).toBe(0);
    expect(dbToCells(-70)).toBe(0);
    expect(dbToCells(6)).toBe(12);
    expect(dbToCells(Number.POSITIVE_INFINITY)).toBe(12);
  });
  it("draws nothing for silence (−∞), no level (null) or NaN", () => {
    expect(dbToCells(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(dbToCells(null)).toBe(0);
    expect(dbToCells(undefined)).toBe(0);
    expect(dbToCells(Number.NaN)).toBe(0);
  });
  it("honours a custom scale and cell count", () => {
    expect(dbToCells(-20, { min: -40, max: 0, cells: 8 })).toBe(4);
    expect(dbToCells(-0.5, { cells: 8 })).toBe(8);
    expect(dbToCells(-20, { cells: 0 })).toBe(1); // at least one cell
    expect(dbToCells(-20, { min: 0, max: 0 })).toBe(0); // empty scale
  });
  it("normalises the cell count to a whole number of at least one", () => {
    expect(cellCount()).toBe(12);
    expect(cellCount(8.4)).toBe(8);
    expect(cellCount(0)).toBe(1);
    expect(cellCount(-3)).toBe(1);
    expect(cellCount(Number.NaN)).toBe(12);
  });
});

describe("levelState / levelTone", () => {
  it("is neutral for a normal speaking level and when there is no level yet", () => {
    expect(levelState(-24, -6)).toBe("ok");
    expect(levelTone(-24, -6)).toBe("neutral");
    expect(levelState(null)).toBe("none");
    expect(levelTone(null, null)).toBe("neutral");
  });
  it("warns when too quiet (below −50 dBFS), including digital silence", () => {
    expect(QUIET_DB).toBe(-50);
    expect(levelState(-50)).toBe("ok");
    expect(levelState(-50.1)).toBe("quiet");
    expect(levelTone(-55)).toBe("warn");
    expect(levelTone(Number.NEGATIVE_INFINITY)).toBe("warn");
  });
  it("warns when clipping (peak ≥ −1 dBFS), which wins over too quiet", () => {
    expect(CLIP_PEAK_DB).toBe(-1);
    expect(levelState(-20, -1)).toBe("clipping");
    expect(levelState(-20, -1.1)).toBe("ok");
    expect(levelState(-55, 0)).toBe("clipping");
    expect(levelState(null, 0)).toBe("clipping");
    expect(levelTone(-12, -0.2)).toBe("warn");
  });
  it("accepts custom thresholds", () => {
    expect(levelTone(-45, null, { quietDb: -40 })).toBe("warn");
    expect(levelTone(-10, -3, { clipPeakDb: -3 })).toBe("warn");
  });
  it("can switch either warning off with null (silence is normal while others talk)", () => {
    expect(levelState(-70, null, { quietDb: null })).toBe("ok");
    expect(levelTone(Number.NEGATIVE_INFINITY, null, { quietDb: null })).toBe("neutral");
    expect(levelState(-20, 0, { clipPeakDb: null })).toBe("ok");
    expect(levelState(-70, 0, { quietDb: null, clipPeakDb: null })).toBe("ok");
    expect(levelState(null, 0, { clipPeakDb: null })).toBe("none");
  });
});

describe("formatDb", () => {
  it("writes whole decibels with a real minus sign", () => {
    expect(formatDb(-24.4)).toBe("−24 dB");
    expect(formatDb(-0.4)).toBe("0 dB");
    expect(formatDb(-0.5)).toBe("0 dB"); // rounds to −0
    expect(formatDb(0)).toBe("0 dB");
    expect(formatDb(2)).toBe("+2 dB");
    expect(formatDb(-70)).toBe("−70 dB");
  });
  it("marks silence and missing levels", () => {
    expect(formatDb(Number.NEGATIVE_INFINITY)).toBe("−∞ dB");
    expect(formatDb(null)).toBe("– dB");
    expect(formatDb(Number.NaN)).toBe("– dB");
  });
});

describe("meterCells", () => {
  const str = (cells: string[]) => cells.map((c) => ({ on: "▮", off: "▯", peak: "▲" })[c]).join("");
  it("is lit cells then empty cells", () => {
    expect(str(meterCells(7, 0, 12))).toBe("▮▮▮▮▮▮▮▯▯▯▯▯");
    expect(str(meterCells(0, 0, 12))).toBe("▯▯▯▯▯▯▯▯▯▯▯▯");
    expect(str(meterCells(12, 12, 12))).toBe("▮▮▮▮▮▮▮▮▮▮▮▮");
  });
  it("lights a lone peak-hold cell above the level", () => {
    expect(str(meterCells(4, 9, 12))).toBe("▮▮▮▮▯▯▯▯▲▯▯▯");
    expect(str(meterCells(4, 5, 12))).toBe("▮▮▮▮▲▯▯▯▯▯▯▯");
    expect(str(meterCells(0, 12, 12))).toBe("▯▯▯▯▯▯▯▯▯▯▯▲");
  });
  it("ignores a peak at or below the level and is always exactly `cells` long", () => {
    expect(meterCells(6, 3, 12)).toEqual(meterCells(6, 0, 12));
    expect(meterCells(6, 6, 12)).toEqual(meterCells(6, 0, 12));
    for (const [f, p] of [
      [0, 0],
      [3, 8],
      [12, 4],
      [20, 30],
      [-2, -1],
    ] as const) {
      expect(meterCells(f, p, 12)).toHaveLength(12);
    }
    expect(meterCells(3, 0, 0)).toHaveLength(1);
  });
});

describe("meterValue", () => {
  it("clamps the reported aria-valuenow to the scale", () => {
    expect(meterValue(-24)).toBe(-24);
    expect(meterValue(-70)).toBe(-60);
    expect(meterValue(3)).toBe(0);
    expect(meterValue(Number.NEGATIVE_INFINITY)).toBe(-60);
    expect(meterValue(null)).toBe(-60);
    expect(meterValue(null, -40, 0)).toBe(-40);
  });
});

describe("recording states (AESTHETIC-RULES § 8.1)", () => {
  it("describes every state", () => {
    expect(Object.keys(REC_STATE_META).sort()).toEqual([...REC_STATES].sort());
    for (const s of REC_STATES) {
      const m = REC_STATE_META[s];
      expect(m.text.length, s).toBeGreaterThan(0);
      expect(m.short.length, s).toBeGreaterThan(0);
      expect(m.tip.length, s).toBeGreaterThan(0);
      expect(m.banner.length, s).toBeGreaterThan(0);
      expect(ICON_TABLE[m.icon], `${s}: unknown icon ${m.icon}`).toBeDefined();
    }
  });
  it("uses the reserved tones: recording is live, never red", () => {
    const tones = Object.fromEntries(REC_STATES.map((s) => [s, REC_STATE_META[s].tone]));
    expect(tones).toEqual({
      recording: "live",
      paused: "warn",
      no_signal: "warn",
      requesting: "warn",
      denied: "danger",
      error: "danger",
      off: "neutral",
      skipped: "neutral",
    });
  });
  it("gives errors the warning-microphone icon and keeps the microphone icon for recording only", () => {
    for (const s of REC_STATES) {
      const m = REC_STATE_META[s];
      if (m.tone === "danger") expect(m.icon, s).toBe("microphoneWarning");
      if (s !== "recording") expect(m.icon, s).not.toBe("microphone");
    }
    expect(REC_STATE_META.recording.icon).toBe("microphone");
  });
  it("has a look for every state the browser reports except idle (shown as off), plus off and skipped", () => {
    const expected = [...MIC_LEVEL_STATES.filter((s) => s !== "idle"), "off", "skipped"];
    expect([...REC_STATES].sort()).toEqual(expected.sort());
    expect(recStateMeta("recording")).toBe(REC_STATE_META.recording);
  });
  it("writes tag text in lower case (the tag style upper-cases it, except with OpenDyslexic)", () => {
    for (const s of REC_STATES) {
      expect(REC_STATE_META[s].text, s).toBe(REC_STATE_META[s].text.toLowerCase());
      expect(REC_STATE_META[s].short, s).toBe(REC_STATE_META[s].short.toLowerCase());
    }
  });
});
