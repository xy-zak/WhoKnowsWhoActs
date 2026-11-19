import { describe, expect, it } from "vitest";
import {
  type AgentSeat,
  type ConsentStatus,
  emptySeat,
  type GameState,
  initialState,
  isRecordedSeat,
  type MicCheckStatus,
  NOT_RECORDING_REASONS,
  type NotRecordingReason,
  ONBOARDING_STEPS,
  PHASES,
  type Phase,
  type ReadonlyGameState,
  recordingVerdict,
  type SeatState,
  STOP_REASON_FOR,
  shouldRecord,
} from "../src";

/* ─── fixtures: states built directly, so impossible combinations are covered too ─── */

const AGENT: AgentSeat = { policy: "random", policyVersion: "1", params: {}, seed: "x" };

interface Case {
  audio?: boolean;
  paused?: boolean;
  phase?: Phase;
  micCheckStep?: boolean;
  /** seat 1, the seat under test (defaults: a bound participant who consented with audio) */
  seat?: Partial<SeatState>;
  /** seat 2: done with consent, still reading it, or not bound */
  other?: "consented" | "in_consent" | "unbound";
}

function stateOf(c: Case): GameState {
  const st = initialState();
  st.audio.enabled = c.audio ?? true;
  st.audio.recordingPaused = c.paused ?? false;
  st.phase = c.phase ?? "round_active";
  st.onboardingSteps = (c.micCheckStep ?? true) ? [...ONBOARDING_STEPS] : ["consent", "demographics"];
  st.seats[1] = { ...emptySeat(1), bound: true, consent: "given", audioConsent: true, ...c.seat };
  const other = c.other ?? "consented";
  st.seats[2] =
    other === "unbound"
      ? emptySeat(2)
      : {
          ...emptySeat(2),
          bound: true,
          consent: other === "consented" ? "given" : "pending",
          audioConsent: other === "consented",
        };
  return st;
}

const why = (st: ReadonlyGameState, seat: number): NotRecordingReason | null => {
  const v = recordingVerdict(st, st.seats[seat]!);
  return v.record ? null : v.reason;
};

/* ─── the table: (state, seat) → verdict ─── */

const TABLE: Array<[string, Case, NotRecordingReason | null]> = [
  ["a consenting participant in a round", {}, null],
  ["at the mic check in onboarding", { phase: "onboarding" }, null],
  ["in the break between rounds", { phase: "round_complete" }, null],
  ["the session records no audio", { audio: false }, "audio_off"],
  ["nobody in the seat", { seat: { bound: false } }, "unbound"],
  ["a fake player", { seat: { fake: true, consent: "skipped", audioConsent: false } }, "not_participant"],
  ["an agent, even with a (forged) consent", { seat: { agent: AGENT } }, "not_participant"],
  ["withdrawn", { seat: { withdrawn: true } }, "withdrawn"],
  [
    "withdrawn beats a skipped mic check and a pause",
    { seat: { withdrawn: true, micCheck: "skipped" }, paused: true },
    "withdrawn",
  ],
  [
    "consent declined, not withdrawn yet",
    { seat: { consent: "declined", audioConsent: false } },
    "consent_declined",
  ],
  ["consent without the audio item", { seat: { audioConsent: false } }, "no_audio_consent"],
  ["never asked: no consent step", { seat: { consent: "skipped", audioConsent: false } }, "no_audio_consent"],
  [
    "still reading the consent form",
    { phase: "onboarding", seat: { consent: "pending", audioConsent: false } },
    "consent_pending",
  ],
  [
    "in the lobby, before consent",
    { phase: "lobby", micCheckStep: false, seat: { consent: "pending", audioConsent: false } },
    "consent_pending",
  ],
  ["mic check skipped", { seat: { micCheck: "skipped" } }, "mic_check_skipped"],
  [
    "a skipped mic check beats the game's end",
    { seat: { micCheck: "skipped" }, phase: "game_complete" },
    "mic_check_skipped",
  ],
  ["onboarding without a mic check step", { phase: "onboarding", micCheckStep: false }, "no_mic_check_step"],
  ["in the lobby (with consent: only in a hand-built state)", { phase: "lobby" }, "not_started"],
  ["the game is complete", { phase: "game_complete" }, "game_complete"],
  ["the game's end beats a pause", { phase: "game_complete", paused: true }, "game_complete"],
  ["the session was closed", { phase: "closed" }, "session_closed"],
  ["the session was aborted", { phase: "aborted" }, "session_aborted"],
  [
    "another seat still reads the consent form",
    { phase: "onboarding", other: "in_consent" },
    "mic_check_held",
  ],
  [
    "the consent hold beats a pause",
    { phase: "onboarding", other: "in_consent", paused: true },
    "mic_check_held",
  ],
  ["paused by the facilitator", { paused: true }, "paused"],
];

describe("recordingVerdict", () => {
  it.each(TABLE)("%s", (_name, c, reason) => {
    expect(why(stateOf(c), 1)).toBe(reason);
  });

  it("names every reason in the table", () => {
    const named = new Set(TABLE.map(([, , r]) => r));
    expect(NOT_RECORDING_REASONS.filter((r) => !named.has(r))).toEqual([]);
  });

  it("expects audio from a seat (isRecordedSeat) when only the moment stops it, not the seat itself", () => {
    const expected = (c: Case) => {
      const st = stateOf(c);
      return isRecordedSeat(recordingVerdict(st, st.seats[1]!));
    };
    const moments: Case[] = [
      {},
      { paused: true },
      { phase: "game_complete" },
      { phase: "onboarding", other: "in_consent" },
    ];
    const seatStops: Case[] = [
      { audio: false },
      { seat: { withdrawn: true } },
      { seat: { micCheck: "skipped" } },
    ];
    expect(moments.map(expected)).toEqual([true, true, true, true]);
    expect(seatStops.map(expected)).toEqual([false, false, false]);
  });

  it("maps every reason to a documented stop reason", () => {
    expect(STOP_REASON_FOR).toMatchObject({
      withdrawn: "withdrawn",
      mic_check_skipped: "skipped",
      paused: "paused",
      game_complete: "game_complete",
      session_closed: "closed",
      session_aborted: "aborted",
      mic_check_held: "client_stop",
    });
  });
});

/* ─── every combination of the fields the verdict reads ─── */

function* matrix(): Generator<GameState> {
  const consents: ConsentStatus[] = ["pending", "given", "declined", "skipped"];
  const checks: MicCheckStatus[] = ["pending", "passed", "skipped"];
  const kinds: Array<Partial<SeatState>> = [{}, { fake: true }, { agent: AGENT }];
  for (const audio of [true, false])
    for (const phase of PHASES)
      for (const micCheckStep of [true, false])
        for (const other of ["consented", "in_consent", "unbound"] as const)
          for (const bound of [true, false])
            for (const withdrawn of [false, true])
              for (const kind of kinds)
                for (const consent of consents)
                  for (const audioConsent of [true, false])
                    for (const micCheck of checks)
                      yield stateOf({
                        audio,
                        paused: true,
                        phase,
                        micCheckStep,
                        other,
                        seat: { bound, withdrawn, ...kind, consent, audioConsent, micCheck },
                      });
}

describe("recordingVerdict over every combination of the fields it reads", () => {
  it("says paused only when the pause is all that stops the seat", () => {
    for (const st of matrix()) {
      const seat = st.seats[1]!;
      const unpaused = { ...st, audio: { ...st.audio, recordingPaused: false } };
      expect(why(st, 1) === "paused").toBe(shouldRecord(unpaused, seat));
    }
  });
});
