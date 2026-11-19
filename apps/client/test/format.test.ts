import { describe, expect, it } from "vitest";
import {
  fmtBytes,
  fmtDuration,
  fmtMinutes,
  fmtShare,
  fmtSigned,
  PLACEHOLDER,
  plural,
} from "../src/common/format";

describe("formatting", () => {
  it("formats durations as m:ss or h:mm:ss, and unknown as the placeholder", () => {
    expect(fmtDuration(0)).toBe("0:00");
    expect(fmtDuration(1_499)).toBe("0:01");
    expect(fmtDuration(65_000)).toBe("1:05");
    expect(fmtDuration(3_600_000 + 2 * 60_000 + 3_000)).toBe("1:02:03");
    expect(fmtDuration(null)).toBe(PLACEHOLDER);
    expect(fmtDuration(Number.NaN)).toBe(PLACEHOLDER);
    expect(fmtDuration(-5)).toBe("0:00");
    expect(fmtMinutes(-5)).toBe("0.0 min");
    expect(fmtMinutes(90_000)).toBe("1.5 min");
    expect(fmtMinutes(undefined)).toBe(PLACEHOLDER);
  });

  it("formats sizes in B, KB, MB and GB", () => {
    expect(fmtBytes(0)).toBe("0 B");
    expect(fmtBytes(1023)).toBe("1023 B");
    expect(fmtBytes(1024)).toBe("1.0 KB");
    expect(fmtBytes(1536)).toBe("1.5 KB");
    expect(fmtBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(fmtBytes(200 * 1024 * 1024)).toBe("200 MB");
    expect(fmtBytes(3 * 1024 ** 3)).toBe("3.0 GB");
    expect(fmtBytes(-1)).toBe(PLACEHOLDER);
  });

  it("formats shares, counted nouns and signed figures (one decimal: a failing 9.6 dB never reads as 10 dB)", () => {
    expect(fmtShare(0.254)).toBe("25 %");
    expect(fmtShare(null)).toBe(PLACEHOLDER);
    expect(plural(1, "track")).toBe("1 track");
    expect(plural(0, "audio file")).toBe("0 audio files");
    expect(fmtSigned(12.34, "dB")).toBe("+12.3 dB");
    expect(fmtSigned(9.6, "dB")).toBe("+9.6 dB");
    expect(fmtSigned(-4, "ppm", 0)).toBe("−4 ppm");
    expect(fmtSigned(-0.01, "dB")).toBe("0.0 dB");
    expect(fmtSigned(null, "ms")).toBe(PLACEHOLDER);
  });
});
