import {
  emptySeat,
  type GameState,
  initialState,
  NOT_RECORDING_REASONS,
  type NotRecordingReason,
  ONBOARDING_STEPS,
  type Phase,
  recordingVerdict,
  type SeatState,
} from "@wkwa/shared";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { LiveAudio } from "../src/audio/live";
import type { Store } from "../src/db/store";

/* Which audio a seat may upload, per recording verdict reason: `chunk` is refusal() (null = a chunk
 * is stored, cut to a pause or the game's end), `start` the refusal of a new track. */

interface Case {
  audio?: boolean;
  paused?: boolean;
  phase?: Phase;
  micCheckStep?: boolean;
  seat?: Partial<SeatState>;
  otherInConsent?: boolean;
  audioFiles?: boolean;
}

function liveOf(c: Case) {
  const st: GameState = initialState();
  st.audio.enabled = c.audio ?? true;
  st.audio.recordingPaused = c.paused ?? false;
  st.phase = c.phase ?? "round_active";
  st.onboardingSteps = (c.micCheckStep ?? true) ? [...ONBOARDING_STEPS] : ["consent", "demographics"];
  const done = {
    bound: true,
    consent: "given",
    audioConsent: true,
    demographics: true,
    briefing: true,
  } as const;
  st.seats[1] = { ...emptySeat(1), ...done, participantCode: "AAAA-1111", ...c.seat };
  st.seats[2] = c.otherInConsent
    ? { ...emptySeat(2), bound: true, participantCode: "BBBB-2222" }
    : { ...emptySeat(2), ...done, participantCode: "BBBB-2222" };
  const store = { audioFiles: (c.audioFiles ?? true) ? {} : null } as unknown as Store;
  const live = new LiveAudio({
    sessionId: "s",
    store,
    clock: Date.now,
    log: pino({ level: "silent" }),
    state: () => st,
    append: () => {
      throw new Error("not used");
    },
    run: (fn) => fn(),
    isFinal: () => st.phase === "closed" || st.phase === "aborted",
  });
  const verdict = recordingVerdict(st, st.seats[1]!);
  return {
    reason: verdict.record ? null : verdict.reason,
    chunk: live.refusal(1),
    start: live.refusal(1, true),
  };
}

const NO_CONSENT = "No audio consent for this seat";

/** [case, verdict reason, chunk refusal, start refusal] */
const TABLE: Array<[Case, NotRecordingReason | null, string | null, string | null]> = [
  [{}, null, null, null],
  [{ audio: false }, "audio_off", "This session does not record audio", "This session does not record audio"],
  [{ seat: { bound: false } }, "unbound", "This seat is not recorded", "This seat is not recorded"],
  [{ seat: { fake: true } }, "not_participant", "This seat is not recorded", "This seat is not recorded"],
  [
    { seat: { withdrawn: true } },
    "withdrawn",
    "The participant has withdrawn",
    "The participant has withdrawn",
  ],
  [{ seat: { consent: "declined", audioConsent: false } }, "consent_declined", NO_CONSENT, NO_CONSENT],
  [{ seat: { audioConsent: false } }, "no_audio_consent", NO_CONSENT, NO_CONSENT],
  [
    { phase: "onboarding", seat: { consent: "pending", audioConsent: false } },
    "consent_pending",
    NO_CONSENT,
    NO_CONSENT,
  ],
  [
    { seat: { micCheck: "skipped" } },
    "mic_check_skipped",
    "The mic check of this seat was skipped",
    "The mic check of this seat was skipped",
  ],
  [
    { phase: "onboarding", micCheckStep: false },
    "no_mic_check_step",
    null,
    "This seat should not record now",
  ],
  [{ phase: "lobby" }, "not_started", null, "Nothing is recorded in phase 'lobby'"],
  [{ phase: "game_complete" }, "game_complete", null, "Nothing is recorded in phase 'game_complete'"],
  [{ phase: "closed" }, "session_closed", "The session has ended", "The session has ended"],
  [{ phase: "aborted" }, "session_aborted", "The session has ended", "The session has ended"],
  [
    { phase: "onboarding", otherInConsent: true },
    "mic_check_held",
    "Waiting for every seat to finish the consent form",
    "Waiting for every seat to finish the consent form",
  ],
  [{ paused: true }, "paused", null, "Recording is paused"],
  // server-only checks
  [{ audioFiles: false }, null, "This database does not record audio", "This database does not record audio"],
  [
    { seat: { participantCode: null } },
    null,
    "This seat has no participant code",
    "This seat has no participant code",
  ],
];

describe("live audio refusals per recording verdict reason", () => {
  it.each(TABLE)("%j → %s", (c, reason, chunk, start) => {
    expect(liveOf(c)).toEqual({ reason, chunk, start });
  });

  it("covers every reason", () => {
    const covered = new Set(TABLE.map((row) => row[1]));
    expect(NOT_RECORDING_REASONS.filter((r) => !covered.has(r))).toEqual([]);
  });
});
