import { describe, expect, it } from "vitest";
import {
  AUDIO_START_REASON_DEFS,
  AUDIO_STOP_REASON_DEFS,
  AUDIO_STOP_REASONS,
  audioTrackEnding,
  INTERRUPTED_STOP_REASONS,
  isAudioStopReason,
  MIC_LEVEL_STATES,
  MIC_STATE_DEFS,
  micCapturing,
  micHasLevel,
} from "../src";

describe("audio reason catalogue", () => {
  // reason → [ending, flagged by the facilitator's wrap-up check]
  const STOPS: Record<string, [string, boolean]> = {
    paused: ["clean", false],
    game_complete: ["clean", false],
    closed: ["clean", false],
    aborted: ["clean", false],
    withdrawn: ["clean", false],
    disconnect: ["interrupted", true],
    permission_lost: ["interrupted", true],
    error: ["interrupted", true],
    client_stop: ["clean", false],
    skipped: ["clean", false],
    interrupted: ["interrupted", true],
    context_suspended: ["clean", false],
    context_interrupted: ["clean", true],
    clock_jump: ["clean", false],
    discontinuity: ["clean", false],
    track_ended: ["interrupted", true],
    cleared: ["clean", false],
  };

  it.each(Object.entries(STOPS))("stop reason %s: %j", (reason, [ending, flagged]) => {
    expect(isAudioStopReason(reason)).toBe(true);
    const d = AUDIO_STOP_REASON_DEFS[reason as keyof typeof AUDIO_STOP_REASON_DEFS];
    expect(d.ending).toBe(ending);
    expect(d.wrapUpIssue !== null).toBe(flagged);
    expect(audioTrackEnding(reason)).toBe(ending);
  });

  it("lists every stop reason in the table above, and nothing else", () => {
    expect([...AUDIO_STOP_REASONS].sort()).toEqual(Object.keys(STOPS).sort());
    expect(INTERRUPTED_STOP_REASONS).toEqual([
      "disconnect",
      "permission_lost",
      "error",
      "interrupted",
      "track_ended",
    ]);
  });

  it("flags every interrupted reason in the wrap-up check", () => {
    for (const r of INTERRUPTED_STOP_REASONS) expect(AUDIO_STOP_REASON_DEFS[r].wrapUpIssue).toBeTruthy();
  });

  it("counts a missing stop reason as clean and an unknown one as interrupted", () => {
    expect(audioTrackEnding(null)).toBe("clean");
    expect(audioTrackEnding("context_closed")).toBe("interrupted");
    expect(audioTrackEnding("toString")).toBe("interrupted");
    expect(isAudioStopReason("constructor")).toBe(false);
  });

  // state → [capturing, hasLevel]
  const MICS: Record<string, [boolean, boolean]> = {
    recording: [true, true],
    no_signal: [true, true],
    paused: [true, false],
    denied: [false, false],
    error: [false, false],
    idle: [false, false],
    requesting: [false, false],
  };

  it.each(Object.entries(MICS))("mic state %s: capturing / has level %j", (state, [capturing, hasLevel]) => {
    expect(micCapturing(state)).toBe(capturing);
    expect(micHasLevel(state)).toBe(hasLevel);
  });

  it("lists every mic state in the table above; a level implies capturing; other states are neither", () => {
    expect([...MIC_LEVEL_STATES].sort()).toEqual(Object.keys(MICS).sort());
    for (const d of Object.values(MIC_STATE_DEFS)) if (d.hasLevel) expect(d.capturing).toBe(true);
    for (const s of ["off", "skipped", "toString"]) {
      expect(micCapturing(s)).toBe(false);
      expect(micHasLevel(s)).toBe(false);
    }
  });

  it("gives every reason and state a label and a description", () => {
    for (const d of [...Object.values(AUDIO_START_REASON_DEFS), ...Object.values(AUDIO_STOP_REASON_DEFS)]) {
      expect(d.label).toMatch(/^\S/);
      expect(d.description).toMatch(/^[a-z'].*[^.]$/);
    }
    for (const d of Object.values(MIC_STATE_DEFS)) expect(d.description).toMatch(/^[a-z].*[^.]$/);
  });
});
