/// <reference types="node" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AUDIO_CONSENT_ITEM,
  AUDIO_LATE_CHUNK_GRACE_MS,
  AUDIO_MAX_CHUNK_SAMPLES,
  AUDIO_MAX_PENDING_SECONDS,
  AudioChunk,
  AudioContentSchema,
  AudioSettingsSchema,
  AudioStart,
  AudioStop,
  audioSendResult,
  ConsentItemSchema,
  calibrationNotReadySeats,
  calibrationReadyToStart,
  calibrationWaitingSeats,
  canSayCalibrationReady,
  canStartFirstRound,
  composeConsent,
  consentSections,
  isMicCheckHeld,
  isOnboardingComplete,
  MicCheckSubmit,
  micCheckHoldSeats,
  type NotRecordingReason,
  nextOnboardingStep,
  normaliseForPlayers,
  type OnboardingContent,
  type OnboardingStep,
  onboardingStepsFor,
  parseSessionConfig,
  playerView,
  recordingVerdict,
  reduceEvents,
  roundSpecFor,
  type SessionConfigInput,
  SessionConfigSchema,
  seatsInMicCheck,
} from "../src";
import { EventLog, readySession, TEST_MAP, testScenario } from "./helpers";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const readConfig = (f: string) => JSON.parse(readFileSync(`${root}config/${f}`, "utf8"));

const AUDIO_STEPS: OnboardingStep[] = ["consent", "demographics", "briefing", "mic_check"];
/** The order sessions logged before the mic check moved to the end of the onboarding. */
const LEGACY_AUDIO_STEPS: OnboardingStep[] = ["consent", "mic_check", "demographics", "briefing"];
const SETTINGS = {
  sampleRate: 48000,
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
};
const MIC_OK = {
  passed: true,
  attempts: 1,
  durationMs: 9000,
  settings: SETTINGS,
  noiseFloorDb: -60,
  speechDb: -22,
  speechMs: 2500,
};
const code = (seat: number) => `WK-TEST-000${seat}-X`;

/** A session in onboarding: 4 bound, labelled seats (optionally some fake), no step done yet. */
function onboardingSession(
  config: SessionConfigInput = { audio: { enabled: true } },
  opts: { steps?: OnboardingStep[]; fakeSeats?: number[] } = {},
): EventLog {
  const log = new EventLog();
  const cfg = SessionConfigSchema.parse(config);
  log.push(
    "SessionCreated",
    {
      config: cfg,
      scenario: { id: "test", title: "Test", version: "1", hash: "test" },
      ...TEST_MAP,
      viewIds: ["Ka", "Kb", "Kc", "Kd"],
      harness: { version: "0", gitCommit: "test" },
      notes: "",
    },
    { actor: "facilitator" },
  );
  const K = ["Ka", "Kb", "Kc", "Kd"] as const;
  const P = ["Pa", "Pb", "Pc", "Pd"] as const;
  for (let seat = 1; seat <= cfg.seatCount; seat++) {
    const fake = opts.fakeSeats?.includes(seat) ?? false;
    log.push(
      "SeatBound",
      { seat, terminal: seat, bindingId: `b${seat}`, fake },
      { seat, code: fake ? null : code(seat), actor: "facilitator" },
    );
  }
  log.push(
    "LabelsAssigned",
    {
      assignments: Array.from({ length: cfg.seatCount }, (_, i) => ({
        seat: i + 1,
        k: K[i]!,
        p: P[i]!,
        view: K[i]!,
      })),
      method: "manual",
      seed: null,
      pairing: { mode: "aligned", id: null },
    },
    { actor: "facilitator" },
  );
  const steps = opts.steps ?? (cfg.audio.enabled ? AUDIO_STEPS : ["consent", "demographics", "briefing"]);
  log.push("OnboardingStarted", { steps }, { actor: "facilitator" });
  return log;
}

function consent(log: EventLog, seat: number, answers: Record<string, boolean>, consented = true) {
  log.push(
    "ConsentRecorded",
    { formVersion: "1", textSha256: "x", answers, consented, durationMs: 1 },
    { seat, code: code(seat), actor: "player" },
  );
}

const fullConsent = { participate: true, [AUDIO_CONSENT_ITEM]: true };

function micCheck(log: EventLog, seat: number, passed = true) {
  log.push("MicCheckCompleted", { ...MIC_OK, passed }, { seat, code: code(seat), actor: "player" });
}

function finishOnboarding(log: EventLog, seat: number) {
  consent(log, seat, fullConsent);
  afterConsent(log, seat);
}

/** Demographics, briefing and the mic check (if used). */
function afterConsent(log: EventLog, seat: number) {
  questionnaireAndBriefing(log, seat);
  if (log.state.onboardingSteps.includes("mic_check")) micCheck(log, seat);
}

function questionnaireAndBriefing(log: EventLog, seat: number) {
  log.push(
    "DemographicsSubmitted",
    { formVersion: "1", answers: { age: "25_34" }, durationMs: 1 },
    { seat, code: code(seat), actor: "player" },
  );
  log.push(
    "BriefingAcknowledged",
    { textSha256: "y", durationMs: 1 },
    { seat, code: code(seat), actor: "player" },
  );
}

/** Consent, questionnaire and briefing: the seat is at its mic check (held until every seat is). */
function toMicCheck(log: EventLog, seat: number) {
  consent(log, seat, fullConsent);
  questionnaireAndBriefing(log, seat);
}

const seat = (log: EventLog, n: number) => log.state.seats[n]!;
/** Why the seat does not record now (null = it records). */
const why = (log: EventLog, n: number): NotRecordingReason | null => {
  const v = recordingVerdict(log.state, seat(log, n));
  return v.record ? null : v.reason;
};

const content: OnboardingContent = {
  study: {
    title: "Test",
    institution: "",
    researcher: "R",
    contactEmail: "r@example.org",
    supervisor: "",
    retention: "",
    takedownInstructions: "",
    briefingMarkdownFile: "briefing.md",
  },
  consent: { version: "1", markdown: "", sha256: "x", items: [] },
  demographics: { version: "1", intro: "", questions: [] },
  briefing: { markdown: "", sha256: "y" },
  audio: AudioContentSchema.parse(readConfig("audio.json")),
};

describe("audio config", () => {
  it("is off by default, also in config/session.default.json", () => {
    expect(SessionConfigSchema.parse({}).audio).toEqual({ enabled: false, requireCalibration: true });
    const defaults = parseSessionConfig(readConfig("session.default.json"));
    expect(defaults.audio).toEqual({ enabled: false, requireCalibration: true });
    expect(defaults).toEqual(SessionConfigSchema.parse({}));
  });

  it("keeps audio out of the onboarding block", () => {
    expect(Object.keys(SessionConfigSchema.parse({}).onboarding).sort()).toEqual([
      "briefing",
      "consent",
      "demographics",
    ]);
  });

  it("turns audio off for simulated sessions and leaves real ones untouched", () => {
    const sim = normaliseForPlayers(parseSessionConfig({ players: "simulated", audio: { enabled: true } }));
    expect(sim.audio).toEqual({ enabled: false, requireCalibration: true });
    const real = parseSessionConfig({ audio: { enabled: true } });
    expect(normaliseForPlayers(real)).toBe(real);
    expect(real.audio.enabled).toBe(true);
  });

  it("never records in a simulated session, even if its logged config says audio", () => {
    const log = onboardingSession({ players: "simulated", audio: { enabled: true } });
    expect(log.state.audio.enabled).toBe(false);
  });

  it("config/audio.json parses, with enough distinct calibration sentences for every seat", () => {
    const a = AudioContentSchema.parse(readConfig("audio.json"));
    expect(a.micCheck.phrase.length).toBeGreaterThan(0);
    expect(a.calibration.sentences.length).toBeGreaterThanOrEqual(4);
    expect(new Set(a.calibration.sentences.map((s) => s.id)).size).toBe(a.calibration.sentences.length);
    expect(a.calibration.turnMs).toBe(6000);
    expect(a.calibration.gapMs).toBe(1000);
  });

  it("refuses to record audio without the consent step (real sessions)", () => {
    expect(
      SessionConfigSchema.safeParse({ audio: { enabled: true }, onboarding: { consent: false } }).success,
    ).toBe(false);
    // simulated sessions never record anyway (normaliseForPlayers), so the draft may keep the choice
    expect(
      SessionConfigSchema.safeParse({
        players: "simulated",
        audio: { enabled: true },
        onboarding: { consent: false },
      }).success,
    ).toBe(true);
  });

  it("rejects duplicate sentence ids and too few sentences", () => {
    const a = readConfig("audio.json");
    const dup = structuredClone(a);
    dup.calibration.sentences[1].id = dup.calibration.sentences[0].id;
    expect(AudioContentSchema.safeParse(dup).success).toBe(false);
    const few = structuredClone(a);
    few.calibration.sentences = few.calibration.sentences.slice(0, 3);
    expect(AudioContentSchema.safeParse(few).success).toBe(false);
  });
});

describe("consent composition", () => {
  const md = [
    "# Information",
    "",
    "We record your clicks.",
    "",
    "<!-- if audio -->",
    "## Audio",
    "We also record your voice.",
    "<!-- end if -->",
    "",
    "## Contact",
    "We record <!-- if audio -->your voice and <!-- end if -->your actions.",
  ].join("\n");
  const items = [
    ConsentItemSchema.parse({ id: "participate", text: "I take part." }),
    ConsentItemSchema.parse({ id: AUDIO_CONSENT_ITEM, text: "Record my voice.", when: "audio" }),
  ];

  it("keeps audio blocks without their markers when the session records audio", () => {
    const c = composeConsent({ markdown: md, items }, { audio: true });
    expect(c.markdown).toBe(
      [
        "# Information",
        "",
        "We record your clicks.",
        "",
        "## Audio",
        "We also record your voice.",
        "",
        "## Contact",
        "We record your voice and your actions.",
      ].join("\n"),
    );
    expect(c.items.map((i) => i.id)).toEqual(["participate", AUDIO_CONSENT_ITEM]);
  });

  it("removes audio blocks and items, without leaving extra blank lines, when it does not", () => {
    const c = composeConsent({ markdown: md, items }, { audio: false });
    expect(c.markdown).toBe(
      ["# Information", "", "We record your clicks.", "", "## Contact", "We record your actions."].join("\n"),
    );
    expect(c.items.map((i) => i.id)).toEqual(["participate"]);
    expect(c.markdown).not.toContain("<!--");
  });

  it("handles a block at the very start and leaves text without markers unchanged", () => {
    const start = "<!-- if audio -->\nAudio first.\n<!-- end if -->\n\n# Title\n";
    expect(composeConsent({ markdown: start, items: [] }, { audio: false }).markdown).toBe("# Title\n");
    expect(composeConsent({ markdown: start, items: [] }, { audio: true }).markdown).toBe(
      "Audio first.\n\n# Title\n",
    );
    const plain = "# Title\n\nNo conditions here.\n";
    expect(composeConsent({ markdown: plain, items }, { audio: false }).markdown).toBe(plain);
  });

  it("throws on unmatched, misspelled, nested or unknown markers instead of leaking audio text", () => {
    const bad = [
      "<!-- if audio -->\nVoice.\n", // no end marker
      "<!-- if audio -->\nVoice.\n<!-- fi -->\n<!-- end if -->x<!-- end if -->",
      "<!-- if audio -->a <!-- if audio -->b<!-- end if --> c<!-- end if -->",
      "<!-- if video -->\nCamera.\n<!-- end if -->",
    ];
    for (const markdown of bad) {
      for (const audio of [true, false]) {
        expect(() => composeConsent({ markdown, items: [] }, { audio }), markdown).toThrow(
          /condition marker/,
        );
      }
    }
    // spacing and case of the markers do not matter
    expect(
      composeConsent({ markdown: "A<!-- If Audio -->B<!--endif-->C", items: [] }, { audio: false }).markdown,
    ).toBe("AC");
  });

  it("is deterministic (the composed text is what gets hashed)", () => {
    const a = composeConsent({ markdown: md, items }, { audio: true });
    expect(composeConsent({ markdown: md, items }, { audio: true })).toEqual(a);
  });
});

describe("onboarding steps with audio", () => {
  it("derives the steps from the config (the mic check only when recording real players)", () => {
    const steps = (c: SessionConfigInput) => onboardingStepsFor(SessionConfigSchema.parse(c));
    expect(steps({ audio: { enabled: true } })).toEqual(AUDIO_STEPS);
    expect(steps({})).toEqual(["consent", "demographics", "briefing"]);
    expect(steps({ onboarding: { consent: true, demographics: false, briefing: true } })).toEqual([
      "consent",
      "briefing",
    ]);
    const simulated = SessionConfigSchema.parse({ audio: { enabled: true } });
    expect(onboardingStepsFor({ ...simulated, players: "simulated" })).not.toContain("mic_check");
  });

  it("orders consent → demographics → briefing → mic_check", () => {
    const log = onboardingSession();
    const s = () => seat(log, 1);
    expect(log.state.onboardingSteps).toEqual(AUDIO_STEPS);
    expect(nextOnboardingStep(log.state, s())).toBe("consent");
    consent(log, 1, fullConsent);
    expect(nextOnboardingStep(log.state, s())).toBe("demographics");
    questionnaireAndBriefing(log, 1);
    expect(nextOnboardingStep(log.state, s())).toBe("mic_check");
    micCheck(log, 1, false);
    expect(s().micCheck).toBe("pending");
    expect(nextOnboardingStep(log.state, s())).toBe("mic_check");
    expect(isOnboardingComplete(log.state, s())).toBe(false);
    micCheck(log, 1);
    expect(s().micCheck).toBe("passed");
    expect(isOnboardingComplete(log.state, s())).toBe(true);
    finishOnboarding(log, 2);
    expect(isOnboardingComplete(log.state, seat(log, 2))).toBe(true);
  });

  it("keeps the order a session logged: an old session has the mic check after consent, held by consent only", () => {
    const log = onboardingSession(undefined, { steps: LEGACY_AUDIO_STEPS });
    for (const n of [1, 2, 3]) consent(log, n, fullConsent);
    expect(nextOnboardingStep(log.state, seat(log, 1))).toBe("mic_check");
    expect(micCheckHoldSeats(log.state)).toEqual([4]);
    consent(log, 4, fullConsent);
    expect(isMicCheckHeld(log.state)).toBe(false);
    expect(why(log, 1)).toBeNull();
    micCheck(log, 1);
    expect(nextOnboardingStep(log.state, seat(log, 1))).toBe("demographics");
  });

  it("counts a mic check skipped by the facilitator as done", () => {
    const log = onboardingSession();
    consent(log, 3, fullConsent);
    log.push(
      "MicCheckSkipped",
      { seat: 3, reason: "no microphone" },
      { seat: 3, code: code(3), actor: "facilitator" },
    );
    expect(seat(log, 3).micCheck).toBe("skipped");
    questionnaireAndBriefing(log, 3);
    expect(nextOnboardingStep(log.state, seat(log, 3))).toBeNull();
    // a late "passed" does not undo the skip
    micCheck(log, 3);
    expect(seat(log, 3).micCheck).toBe("skipped");
  });

  it("has no mic check when audio is off, and none for fake players", () => {
    const off = onboardingSession({});
    expect(off.state.onboardingSteps).toEqual(["consent", "demographics", "briefing"]);
    consent(off, 1, fullConsent);
    expect(nextOnboardingStep(off.state, seat(off, 1))).toBe("demographics");
    const fake = onboardingSession(undefined, { fakeSeats: [4] });
    expect(nextOnboardingStep(fake.state, seat(fake, 4))).toBeNull();
    expect(isOnboardingComplete(fake.state, seat(fake, 4))).toBe(true);
  });

  it("records audio consent only from a given consent with the audio item ticked", () => {
    const log = onboardingSession();
    consent(log, 1, fullConsent);
    consent(log, 2, { participate: true, [AUDIO_CONSENT_ITEM]: false });
    consent(log, 3, { participate: true });
    consent(log, 4, fullConsent, false);
    expect([1, 2, 3, 4].map((n) => seat(log, n).audioConsent)).toEqual([true, false, false, false]);
    expect(seat(log, 4).consent).toBe("declined");
    // without audio consent nobody is asked to speak into the mic: the step does not apply
    for (const n of [1, 2, 3]) questionnaireAndBriefing(log, n);
    expect(nextOnboardingStep(log.state, seat(log, 1))).toBe("mic_check");
    expect(nextOnboardingStep(log.state, seat(log, 2))).toBeNull();
    expect(nextOnboardingStep(log.state, seat(log, 3))).toBeNull();
  });
});

describe("recording verdict through the event log", () => {
  it("records a consenting participant from the mic check until the game is complete", () => {
    const log = onboardingSession();
    expect(why(log, 1)).toBe("consent_pending");
    consent(log, 1, fullConsent);
    // in the questionnaire: held, nobody's microphone opens before everyone is ready
    expect(why(log, 1)).toBe("mic_check_held");
    questionnaireAndBriefing(log, 1);
    // at the mic check, but held: the others are still reading the consent form
    expect(micCheckHoldSeats(log.state)).toEqual([2, 3, 4]);
    expect(why(log, 1)).toBe("mic_check_held");
    for (const n of [2, 3, 4]) consent(log, n, fullConsent);
    // and then still in the questionnaire and the briefing
    expect(micCheckHoldSeats(log.state)).toEqual([2, 3, 4]);
    for (const n of [2, 3, 4]) questionnaireAndBriefing(log, n);
    expect(isMicCheckHeld(log.state)).toBe(false);
    expect(why(log, 1)).toBeNull(); // at the mic check
    for (const n of [1, 2, 3, 4]) micCheck(log, n);
    expect(why(log, 1)).toBeNull(); // ready, waiting for the calibration
    log.push("CalibrationSkipped", { reason: "test" }, { actor: "facilitator" });
    log.push(
      "RoundStarted",
      { round: 1, spec: roundSpecFor(log.state.config, 1), startedBy: "facilitator" },
      { actor: "facilitator" },
    );
    expect(why(log, 1)).toBeNull();
    log.push("GamePaused", { reason: "facilitator", seat: null }, { actor: "facilitator" });
    expect(why(log, 1)).toBeNull(); // game pauses are recorded
    log.push("GameResumed", { pausedMs: 10 }, { actor: "facilitator" });
    log.push(
      "RoundCompleted",
      { round: 1, reason: "facilitator", durationMs: 1, pausedMs: 0, actionCounts: {} },
      { actor: "facilitator" },
    );
    expect(why(log, 1)).toBeNull(); // breaks too
    log.push("GameCompleted", { roundsPlayed: 1, reason: "facilitator" }, { actor: "facilitator" });
    expect(why(log, 1)).toBe("game_complete");
  });

  it("never records without audio, in the lobby, or without the audio consent item", () => {
    const off = onboardingSession({});
    consent(off, 1, fullConsent);
    expect(why(off, 1)).toBe("audio_off");
    const log = onboardingSession();
    const lobbyState = reduceEvents(log.events.filter((e) => e.type !== "OnboardingStarted"));
    expect(lobbyState.phase).toBe("lobby");
    expect(recordingVerdict(lobbyState, lobbyState.seats[1]!)).toEqual({
      record: false,
      reason: "consent_pending",
    });
    consent(log, 2, { participate: true, [AUDIO_CONSENT_ITEM]: false });
    consent(log, 3, fullConsent, false);
    expect(why(log, 2)).toBe("no_audio_consent");
    expect(why(log, 3)).toBe("consent_declined");
  });

  it("never records with consent skipped, nor fake players or agents", () => {
    const skipped = onboardingSession(
      // the config refuses audio without consent; an onboarding without the consent step still never records
      { audio: { enabled: true } },
      { steps: ["mic_check"] },
    );
    expect(seat(skipped, 1).consent).toBe("skipped");
    expect(why(skipped, 1)).toBe("no_audio_consent");
    const fake = onboardingSession(undefined, { fakeSeats: [4] });
    expect(seat(fake, 4).consent).toBe("skipped");
    expect(why(fake, 4)).toBe("not_participant");
    // an agent seat, even with a (forged) given consent, is never recorded
    const agent = onboardingSession();
    agent.push("AgentBound", { seat: 2, policy: "random", policyVersion: "1", params: {}, seed: "x:2" });
    consent(agent, 2, fullConsent);
    expect(seat(agent, 2).agent).not.toBeNull();
    expect(why(agent, 2)).toBe("not_participant");
  });

  it("stops for a withdrawn seat, a skipped mic check and while recording is paused", () => {
    const log = onboardingSession();
    for (const n of [1, 2, 3, 4]) toMicCheck(log, n);
    log.push(
      "ParticipantWithdrawn",
      { seat: 1, by: "facilitator", phase: "onboarding" },
      { seat: 1, code: code(1), actor: "facilitator" },
    );
    expect(why(log, 1)).toBe("withdrawn");
    log.push(
      "MicCheckSkipped",
      { seat: 2, reason: "broken mic" },
      { seat: 2, code: code(2), actor: "facilitator" },
    );
    expect(why(log, 2)).toBe("mic_check_skipped");
    expect(why(log, 3)).toBeNull();
    const pause = log.push("RecordingPaused", { reason: "private conversation" }, { actor: "facilitator" });
    expect(log.state.audio).toMatchObject({
      recordingPaused: true,
      pausedTs: pause.serverTs,
      pauseReason: "private conversation",
    });
    expect(why(log, 3)).toBe("paused");
    log.push("RecordingResumed", {}, { actor: "facilitator" });
    expect(log.state.audio).toMatchObject({ recordingPaused: false, pausedTs: null, pauseReason: null });
    expect(why(log, 3)).toBeNull();
  });

  it("holds every mic check until each real seat has finished the briefing; a decliner holds until withdrawn", () => {
    const log = onboardingSession(undefined, { fakeSeats: [4] });
    for (const n of [1, 2]) toMicCheck(log, n);
    // the fake seat never holds; seat 3 is still reading
    expect(micCheckHoldSeats(log.state)).toEqual([3]);
    expect(playerView(log.state, testScenario, 1, content, 0).audio).toMatchObject({
      micCheckHeld: true,
      record: false,
      notRecording: "mic_check_held",
    });
    consent(log, 3, fullConsent, false); // declined
    expect(micCheckHoldSeats(log.state)).toEqual([3]);
    expect(why(log, 1)).toBe("mic_check_held");
    log.push(
      "ParticipantWithdrawn",
      { seat: 3, by: "facilitator", phase: "onboarding" },
      { seat: 3, code: code(3), actor: "facilitator" },
    );
    expect(micCheckHoldSeats(log.state)).toEqual([]);
    expect(playerView(log.state, testScenario, 1, content, 0).audio).toMatchObject({
      micCheckHeld: false,
      record: true,
      notRecording: null,
    });
  });

  it("does not record when the session started onboarding without a mic check step", () => {
    const log = onboardingSession(undefined, { steps: ["consent", "demographics", "briefing"] });
    consent(log, 1, fullConsent);
    expect(why(log, 1)).toBe("no_mic_check_step");
  });
});

describe("calibration", () => {
  function readyAudioSession(config: SessionConfigInput = { audio: { enabled: true } }) {
    const log = onboardingSession(config);
    for (const n of [1, 2, 3, 4]) finishOnboarding(log, n);
    return log;
  }

  it("runs the turns, completes, records the quality check and gates round 1", () => {
    const log = readyAudioSession();
    const c = () => log.state.audio.calibration;
    expect(c().status).toBe("pending");
    expect(canStartFirstRound(log.state)).toBe(false);

    log.push(
      "CalibrationStarted",
      {
        order: [2, 1, 4, 3],
        sentenceIds: ["h01-01", "h01-02", "h01-03", "h01-04"],
        turnMs: 6000,
        gapMs: 1000,
      },
      { actor: "facilitator" },
    );
    expect(c()).toMatchObject({
      status: "running",
      order: [2, 1, 4, 3],
      turnIndex: null,
      turnMs: 6000,
      gapMs: 1000,
    });
    expect(canStartFirstRound(log.state)).toBe(false);

    const t0 = log.push(
      "CalibrationTurn",
      { index: 0, seat: 2, sentenceId: "h01-01" },
      { seat: 2, code: code(2) },
    );
    expect(c().turnIndex).toBe(0);
    // seat 2 sees its own sentence; everyone else only sees whose turn it is
    const v2 = playerView(log.state, testScenario, 2, content, t0.serverTs).audio;
    expect(v2.calibration).toMatchObject({
      status: "running",
      turnSeat: 2,
      myTurn: true,
      sentence: "The birch canoe slid on the smooth planks.",
      turnEndsAt: t0.serverTs + 6000,
      order: [2, 1, 4, 3],
    });
    const v1 = playerView(log.state, testScenario, 1, content, t0.serverTs).audio;
    expect(v1.calibration).toMatchObject({ turnSeat: 2, myTurn: false, sentence: null });
    expect(JSON.stringify(v1)).not.toContain("birch");

    const t1 = log.push(
      "CalibrationTurn",
      { index: 1, seat: 1, sentenceId: "h01-02" },
      { seat: 1, code: code(1), dt: 7000 },
    );
    expect(c().turns[0]!.endTs).toBe(t0.serverTs + 6000); // previous turn closed at its nominal end
    expect(c().turns[1]).toEqual({ seat: 1, sentenceId: "h01-02", startTs: t1.serverTs, endTs: null });
    log.push(
      "CalibrationTurn",
      { index: 2, seat: 4, sentenceId: "h01-03" },
      { seat: 4, code: code(4), dt: 7000 },
    );
    log.push(
      "CalibrationTurn",
      { index: 3, seat: 3, sentenceId: "h01-04" },
      { seat: 3, code: code(3), dt: 7000 },
    );

    const turns = c().turns.map((t) => ({ ...t, endTs: t.endTs ?? t.startTs + 6000 }));
    log.push("CalibrationCompleted", { turns }, { dt: 6000 });
    expect(c()).toMatchObject({ status: "done", turnIndex: null, turns });
    expect(c().completedTs).not.toBeNull();
    expect(canStartFirstRound(log.state)).toBe(true);
    expect(playerView(log.state, testScenario, 2, content, 0).audio.calibration).toMatchObject({
      status: "done",
      turnSeat: null,
      myTurn: false,
      sentence: null,
      turnEndsAt: null,
    });

    const perSeat = [1, 2, 3, 4].map((s) => ({
      seat: s,
      ownDb: -22,
      bestOtherDb: s === 3 ? -26 : -40,
      marginDb: s === 3 ? 4 : 18,
      ok: s !== 3,
    }));
    log.push("CalibrationChecked", { perSeat, ok: false });
    expect(c().quality).toMatchObject({ ok: false, perSeat });

    // redo: starts over, the old quality result goes
    log.push(
      "CalibrationStarted",
      {
        order: [1, 2, 3, 4],
        sentenceIds: ["h01-05", "h01-06", "h01-07", "h01-09"],
        turnMs: 6000,
        gapMs: 1000,
      },
      { actor: "facilitator" },
    );
    expect(c()).toMatchObject({ status: "running", turns: [], quality: null, completedTs: null });
    expect(canStartFirstRound(log.state)).toBe(false);
    // a late check of the earlier run does not attach to this one
    log.push("CalibrationChecked", { perSeat, ok: false });
    expect(c().quality).toBeNull();

    // cancelling a running calibration = skipping it
    log.push("CalibrationTurn", { index: 0, seat: 1, sentenceId: "h01-05" }, { seat: 1, code: code(1) });
    const skip = log.push(
      "CalibrationSkipped",
      { reason: "out of time" },
      { actor: "facilitator", dt: 2000 },
    );
    expect(c()).toMatchObject({ status: "skipped", turnIndex: null });
    expect(c().turns[0]!.endTs).toBe(skip.serverTs);
    expect(canStartFirstRound(log.state)).toBe(true);
    // a stale completion cannot turn a skipped calibration into a done one
    log.push("CalibrationCompleted", { turns: [] });
    expect(c().status).toBe("skipped");

    // the whole flow replays to the same state
    expect(reduceEvents(log.events).audio).toEqual(log.state.audio);
  });

  it("keeps a finished calibration done when the facilitator skips afterwards", () => {
    const log = readyAudioSession();
    log.push(
      "CalibrationStarted",
      { order: [1], sentenceIds: ["h01-01"], turnMs: 6000, gapMs: 1000 },
      { actor: "facilitator" },
    );
    const t = log.push(
      "CalibrationTurn",
      { index: 0, seat: 1, sentenceId: "h01-01" },
      { seat: 1, code: code(1) },
    );
    log.push(
      "CalibrationCompleted",
      { turns: [{ seat: 1, sentenceId: "h01-01", startTs: t.serverTs, endTs: t.serverTs + 6000 }] },
      { dt: 6000 },
    );
    log.push("CalibrationSkipped", { reason: "move on" }, { actor: "facilitator" });
    expect(log.state.audio.calibration.status).toBe("done");
  });

  it("ends a running turn at its nominal end when skipped during the gap", () => {
    const log = readyAudioSession();
    log.push(
      "CalibrationStarted",
      { order: [1, 2], sentenceIds: ["h01-01", "h01-02"], turnMs: 6000, gapMs: 1000 },
      { actor: "facilitator" },
    );
    const t = log.push(
      "CalibrationTurn",
      { index: 0, seat: 1, sentenceId: "h01-01" },
      { seat: 1, code: code(1) },
    );
    log.push("CalibrationSkipped", { reason: "x" }, { actor: "facilitator", dt: 6800 });
    expect(log.state.audio.calibration.turns[0]!.endTs).toBe(t.serverTs + 6000);
  });

  it("keeps the server's cancel of a running calibration until the next start", () => {
    const log = readyAudioSession();
    const start = () =>
      log.push(
        "CalibrationStarted",
        { order: [1], sentenceIds: ["h01-01"], turnMs: 6000, gapMs: 1000 },
        { actor: "facilitator" },
      );
    start();
    expect(log.state.audio.calibration.lastCancel).toBeNull();
    const cancel = log.push("CalibrationSkipped", { reason: "recording paused", cancelled: true });
    expect(log.state.audio.calibration).toMatchObject({
      status: "pending",
      lastCancel: { reason: "recording paused", ts: cancel.serverTs },
    });
    start();
    expect(log.state.audio.calibration.lastCancel).toBeNull();
    expect(reduceEvents(log.events).audio).toEqual(log.state.audio);
  });

  it("lists the seats the calibration waits for and the seats in their mic check", () => {
    const log = onboardingSession(undefined, { fakeSeats: [4] });
    const seats = (list: Array<{ seat: number }>) => list.map((s) => s.seat);
    expect(seats(calibrationWaitingSeats(log.state))).toEqual([1, 2, 3]);
    expect(seats(seatsInMicCheck(log.state))).toEqual([]);
    for (const n of [1, 2, 3]) toMicCheck(log, n);
    // through the briefing: every seat in its mic check, the calibration still waits for them
    expect(seats(calibrationWaitingSeats(log.state))).toEqual([1, 2, 3]);
    expect(seats(seatsInMicCheck(log.state))).toEqual([1, 2, 3]);
    micCheck(log, 1);
    expect(seats(calibrationWaitingSeats(log.state))).toEqual([2, 3]);
    expect(seats(seatsInMicCheck(log.state))).toEqual([2, 3]);
  });

  it("waits for every recorded seat to say it is ready; a redo asks again", () => {
    const log = onboardingSession(undefined, { fakeSeats: [4] });
    const ready = (n: number) =>
      log.push("CalibrationReady", {}, { seat: n, code: code(n), actor: "player" });
    for (const n of [1, 2]) finishOnboarding(log, n);
    // seat 3 still in its mic check: it may not say ready yet, and the calibration cannot start
    toMicCheck(log, 3);
    expect(canSayCalibrationReady(log.state, seat(log, 3))).toBe(false);
    expect(canSayCalibrationReady(log.state, seat(log, 1))).toBe(true);
    expect(calibrationReadyToStart(log.state)).toBe(false);
    micCheck(log, 3);
    expect([1, 2, 3].map((n) => canSayCalibrationReady(log.state, seat(log, n)))).toEqual([true, true, true]);
    expect(canSayCalibrationReady(log.state, seat(log, 4))).toBe(false); // a fake player is never recorded
    ready(1);
    ready(1); // a second one changes nothing
    ready(3);
    expect(log.state.audio.calibration.ready).toEqual([1, 3]);
    expect(canSayCalibrationReady(log.state, seat(log, 1))).toBe(false);
    expect(calibrationNotReadySeats(log.state)).toEqual([2]);
    expect(calibrationReadyToStart(log.state)).toBe(false);
    expect(playerView(log.state, testScenario, 1, content, 0).audio.calibration).toMatchObject({
      ready: true,
      canSayReady: false,
      waitingFor: [2],
    });
    // a paused recording holds the start
    log.push("RecordingPaused", {}, { actor: "facilitator" });
    ready(2);
    expect(log.state.audio.calibration.ready).toEqual([1, 3, 2]);
    expect(calibrationReadyToStart(log.state)).toBe(false);
    log.push("RecordingResumed", {}, { actor: "facilitator" });
    expect(calibrationReadyToStart(log.state)).toBe(true);
    // a run empties the list; a redo asks everyone again
    log.push(
      "CalibrationStarted",
      { order: [1, 2, 3], sentenceIds: ["a", "b", "c"], turnMs: 6000, gapMs: 1000 },
      { actor: "system" },
    );
    expect(log.state.audio.calibration).toMatchObject({ status: "running", ready: [] });
    ready(1); // too late: not waiting
    expect(log.state.audio.calibration.ready).toEqual([]);
    log.push("CalibrationRequested", {}, { actor: "facilitator" });
    expect(log.state.audio.calibration).toMatchObject({ status: "pending", ready: [], order: [] });
    expect(calibrationNotReadySeats(log.state)).toEqual([1, 2, 3]);
    expect(reduceEvents(log.events).audio).toEqual(log.state.audio);
  });

  it("does not gate round 1 when calibration is not required or audio is off", () => {
    expect(
      canStartFirstRound(readyAudioSession({ audio: { enabled: true, requireCalibration: false } }).state),
    ).toBe(true);
    expect(canStartFirstRound(readySession().state)).toBe(true);
  });
});

describe("player view: audio", () => {
  it("is disabled in sessions without audio", () => {
    const log = readySession();
    expect(playerView(log.state, testScenario, 1, null, 0).audio).toEqual({
      enabled: false,
      record: false,
      notRecording: "audio_off",
      paused: false,
      micCheck: "pending",
      micCheckHeld: false,
      calibration: {
        status: "pending",
        turnSeat: null,
        myTurn: false,
        sentence: null,
        turnEndsAt: null,
        order: [],
        ready: false,
        canSayReady: false,
        waitingFor: [],
      },
    });
  });

  it("tells the browser to record and shows the mic check phrase at the mic check", () => {
    const log = onboardingSession();
    for (const n of [1, 2, 3, 4]) toMicCheck(log, n);
    const v = playerView(log.state, testScenario, 1, content, 0);
    expect(v.me.nextStep).toBe("mic_check");
    expect(v.audio).toMatchObject({ enabled: true, record: true, paused: false, micCheck: "pending" });
    expect(v.audio.micCheckPhrase).toBe(content.audio!.micCheck.phrase);
    expect(v.audio.micCheckMinSpeechMs).toBe(content.audio!.micCheck.minSpeechMs);
    // the onboarding content a player receives never carries the calibration sentences
    expect(v.onboarding).not.toBeNull();
    expect(v.onboarding!.audio).toBeUndefined();
    expect(JSON.stringify(v)).not.toContain("birch");
    micCheck(log, 1);
    const after = playerView(log.state, testScenario, 1, content, 0).audio;
    expect(after.micCheck).toBe("passed");
    expect(after.micCheckPhrase).toBeUndefined();
    log.push("RecordingPaused", {}, { actor: "facilitator" });
    expect(playerView(log.state, testScenario, 1, content, 0).audio).toMatchObject({
      record: false,
      paused: true,
    });
  });
});

describe("audio messages", () => {
  it("keeps late chunks for longer than the browser buffers them, so a long outage is not lost", () => {
    expect(AUDIO_LATE_CHUNK_GRACE_MS).toBeGreaterThanOrEqual(AUDIO_MAX_PENDING_SECONDS * 1000);
  });

  const chunk = (pcm: unknown, sampleCount = 4) => ({
    trackId: "1b4e28ba-2fa1-4d2b-883f-0016d3cca427",
    seq: 0,
    startSample: 0,
    sampleCount,
    clientTs: 1_794_826_000_000,
    clockOffsetMs: -12.4,
    rmsDb: -30,
    peakDb: -6,
    clippedSamples: 0,
    pcm,
  });

  it("accepts binary PCM of exactly sampleCount × 2 bytes (ArrayBuffer, typed array or Node Buffer)", () => {
    expect(AudioChunk.safeParse(chunk(new ArrayBuffer(8))).success).toBe(true);
    expect(AudioChunk.safeParse(chunk(new Uint8Array(8))).success).toBe(true);
    expect(AudioChunk.safeParse(chunk(new Int16Array(4))).success).toBe(true);
    expect(AudioChunk.safeParse(chunk(Buffer.alloc(8))).success).toBe(true);
    expect(AudioChunk.safeParse(chunk(new Uint8Array(7))).success).toBe(false);
    expect(AudioChunk.safeParse(chunk("AAAA")).success).toBe(false);
    expect(AudioChunk.safeParse(chunk([0, 0, 0, 0, 0, 0, 0, 0])).success).toBe(false);
  });

  it("caps chunks at 6 s and checks the levels and ids", () => {
    const max = AUDIO_MAX_CHUNK_SAMPLES;
    expect(AudioChunk.safeParse(chunk(new Uint8Array(max * 2), max)).success).toBe(true);
    expect(AudioChunk.safeParse(chunk(new Uint8Array((max + 1) * 2), max + 1)).success).toBe(false);
    expect(AudioChunk.safeParse({ ...chunk(new Uint8Array(8)), rmsDb: 3 }).success).toBe(false);
    expect(AudioChunk.safeParse({ ...chunk(new Uint8Array(8)), trackId: "seat-1" }).success).toBe(false);
    expect(AudioChunk.safeParse({ ...chunk(new Uint8Array(8)), clippedSamples: 5 }).success).toBe(false);
  });

  it("never keeps a microphone's device id or label", () => {
    const s = AudioSettingsSchema.parse({
      ...SETTINGS,
      deviceId: "abc",
      groupId: "def",
      label: "USB headset",
    });
    expect(s).toEqual(SETTINGS);
    const m = MicCheckSubmit.parse({
      ...MIC_OK,
      settings: { ...SETTINGS, deviceId: "abc", label: "USB headset" },
      clientTs: 1,
    });
    expect(JSON.stringify(m)).not.toMatch(/deviceId|label|USB/);
  });

  it("takes the capture engine's start and stop info as it is", () => {
    // as MicRecorder reports it: Firefox gives no sample rate, newer Chrome a mode string
    const start = AudioStart.parse({
      trackId: "1b4e28ba-2fa1-4d2b-883f-0016d3cca427",
      reason: "context_resumed",
      sampleRate: 16000,
      chunkSamples: 80000,
      clientTs: 1_794_826_000_000,
      clockOffsetMs: -3,
      inputLatencyMs: 12,
      settings: { echoCancellation: "remote-only", noiseSuppression: false, sampleSize: 16, latency: 0.01 },
      context: { sampleRate: 44100, baseLatencyMs: 5.8, outputLatencyMs: null, timingMethod: "current-time" },
    });
    expect(start.settings).toEqual({ sampleRate: 44100, echoCancellation: true, noiseSuppression: false });
    expect(
      AudioStart.safeParse({ ...start, settings: { echoCancellation: false }, context: undefined }).success,
    ).toBe(false);
    const stop = AudioStop.parse({
      trackId: start.trackId,
      reason: "track_ended",
      chunks: 3,
      samples: 200_000,
      clientTs: 1,
      clockOffsetMs: 0,
    });
    expect(stop.droppedChunks).toBe(0);
    for (const r of ["context_suspended", "context_interrupted", "clock_jump", "discontinuity", "cleared"])
      expect(AudioStop.safeParse({ ...stop, reason: r }).success).toBe(true);
    for (const r of ["clock_jump", "discontinuity", "cleared"])
      expect(AudioStart.safeParse({ ...start, reason: r }).success).toBe(true);
  });

  it("maps audio acks to the send queue's results", () => {
    expect(audioSendResult({ ok: true, data: { trackId: "x", seq: 1 } })).toBe(true);
    expect(audioSendResult({ ok: false, error: "paused", retry: false })).toBe("rejected");
    expect(audioSendResult({ ok: false, error: "busy", retry: true })).toBe(false);
    expect(audioSendResult(undefined)).toBe(false);
  });
});

describe("recording windows and calibration runs (reducer)", () => {
  const PAUSE = ["RecordingPaused", {}] as const;
  const RESUME = ["RecordingResumed", {}] as const;
  const GAME_END = ["GameCompleted", { roundsPlayed: 1, reason: "facilitator" }] as const;
  const CALIBRATE = [
    "CalibrationStarted",
    { order: [1], sentenceIds: ["s1"], turnMs: 1000, gapMs: 0 },
  ] as const;
  const CANCEL = ["CalibrationSkipped", { reason: "paused", cancelled: true }] as const;
  type Step = typeof PAUSE | typeof RESUME | typeof GAME_END | typeof CALIBRATE | typeof CANCEL;

  // pauses and the game's end are given as indexes into the steps (their events' serverTs); null = still open
  const cases: Array<{
    name: string;
    steps: Step[];
    pauses: Array<[number, number | null]>;
    gameComplete: number | null;
    runs: number;
  }> = [
    { name: "nothing yet", steps: [], pauses: [], gameComplete: null, runs: 0 },
    { name: "a pause, resumed", steps: [PAUSE, RESUME], pauses: [[0, 1]], gameComplete: null, runs: 0 },
    {
      name: "two pauses",
      steps: [PAUSE, RESUME, PAUSE, RESUME],
      pauses: [
        [0, 1],
        [2, 3],
      ],
      gameComplete: null,
      runs: 0,
    },
    { name: "a resume with no pause open", steps: [RESUME], pauses: [], gameComplete: null, runs: 0 },
    { name: "a pause still open", steps: [PAUSE], pauses: [[0, null]], gameComplete: null, runs: 0 },
    {
      name: "a pause still open at game complete stays open",
      steps: [PAUSE, GAME_END],
      pauses: [[0, null]],
      gameComplete: 1,
      runs: 0,
    },
    {
      name: "resumed after the game completed",
      steps: [PAUSE, GAME_END, RESUME],
      pauses: [[0, 2]],
      gameComplete: 1,
      runs: 0,
    },
    {
      name: "every started calibration counts, a cancelled one too",
      steps: [CALIBRATE, PAUSE, CANCEL, RESUME, CALIBRATE],
      pauses: [[1, 3]],
      gameComplete: null,
      runs: 2,
    },
  ];

  it.each(cases)("$name", ({ steps, pauses, gameComplete, runs }) => {
    const log = readySession({ audio: { enabled: true } });
    const ts = steps.map(([type, payload]) => log.push(type, payload as never).serverTs);
    const at = (i: number | null) => (i === null ? null : ts[i]!);
    expect(log.state.audio.pauses).toEqual(pauses.map(([from, to]) => ({ fromTs: at(from), toTs: at(to) })));
    expect(log.state.audio.gameCompleteTs).toBe(at(gameComplete));
    expect(log.state.audio.calibrationRuns).toBe(runs);
    // the same log folded again gives the same figures (a session loaded after a restart)
    expect(reduceEvents(log.events).audio).toEqual(log.state.audio);
  });
});

describe("consent sections", () => {
  const md = "# Title\n\nIntro.\n\n## About\nText A.\n\n## Data\n- one\n- two\n";
  const items = [
    { id: "a", section: "About" },
    { id: "d", section: "Data" },
  ];

  it("splits the text into its sections, each with the one statement that confirms it", () => {
    const { intro, sections } = consentSections(md, items);
    expect(intro).toBe("# Title\n\nIntro.");
    expect(sections.map((x) => [x.title, x.markdown, x.item.id])).toEqual([
      ["About", "Text A.", "a"],
      ["Data", "- one\n- two", "d"],
    ]);
  });

  it("refuses a section without its statement, two statements for one section, or a statement without a section", () => {
    expect(() => consentSections(md, [items[0]!])).toThrow(/'Data' needs exactly one/);
    expect(() => consentSections(md, [...items, { id: "x", section: "Data" }])).toThrow(/has 2/);
    expect(() => consentSections(md, [...items, { id: "x" }])).toThrow(/'x'/);
    expect(() => consentSections(md, [...items, { id: "x", section: "Nope" }])).toThrow(/'Nope' is not one/);
  });

  it("fits the shipped consent form, with and without audio", () => {
    const form = readConfig("consent.json") as {
      markdownFile: string;
      items: Array<{ id: string; section?: string; when?: "audio" }>;
    };
    const text = readFileSync(`${root}config/${form.markdownFile}`, "utf8");
    for (const audio of [false, true]) {
      const c = composeConsent({ markdown: text, items: form.items }, { audio });
      const { sections } = consentSections(c.markdown, c.items);
      expect(sections.length).toBe(c.items.length);
      expect(sections.some((x) => x.item.id === AUDIO_CONSENT_ITEM)).toBe(audio);
    }
  });
});
