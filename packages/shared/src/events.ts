import { z } from "zod";
import { AUDIO_SAMPLE_RATE, AudioSettingsSchema, Dbfs, TrackIdSchema as TrackId } from "./audio";
import { AudioStartReasonSchema, AudioStopReasonSchema } from "./audioReasons";
import { BoardSchema } from "./board";
import { FakePaceSchema, RoundSpecSchema, SessionConfigSchema } from "./config";
import {
  ActionKindSchema,
  KLabelSchema,
  LabelPairingSchema,
  PLabelSchema,
  SeatSchema,
  ViewIdSchema,
} from "./labels";
import { defineRecord } from "./meta";
import { ONBOARDING_STEPS } from "./state";

/* ═══════════════════════════════════════════════════════════════════════════
 * GAME EVENTS — the append-only, authoritative log of a session.
 *
 * Invariant: a participant code NEVER appears inside a payload. It lives only
 * in the envelope column `participantCode`, so erasure is a single
 * `DELETE … WHERE participant_code = ?`. Inside a session players are
 * referred to by seat number.
 * ═══════════════════════════════════════════════════════════════════════════ */

const SeatList = z.array(SeatSchema);
const Ms = (d: string) => z.number().min(0).describe(`${d} (milliseconds)`);

const ConfigExample = SessionConfigSchema.parse({});

const EXAMPLE_TRACK_ID = "1b4e28ba-2fa1-4d2b-883f-0016d3cca427";
const EXAMPLE_SETTINGS = {
  sampleRate: 48000,
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 1,
};
const SentenceId = z.string().min(1).max(40).describe("Id of the calibration sentence (config/audio.json)");

/** One sub-square's score before and after an action, as computed by the game rules when it was accepted. */
const ScoreChangesSchema = z
  .array(
    z.object({
      regionId: z.string().describe("Sub-square whose score changed, e.g. 'C7-Ka'"),
      from: z.number().describe("Score before"),
      to: z.number().describe("Score after"),
    }),
  )
  .optional()
  .describe(
    "Score changes caused by this event, computed by the session's game rules (docs/GAME-RULES.md); only sub-squares whose score changed. Absent in sessions recorded before the grid map",
  );

export const EVENT_DEFS = {
  SessionCreated: defineRecord({
    summary: "A new session was created with a scenario and configuration.",
    trigger: "Facilitator clicks 'Create session' on the setup screen.",
    actors: ["facilitator"],
    changesState: true,
    visibleTo: "Facilitator",
    dataClass: "non-personal",
    frequency: "1 per session",
    payload: z.object({
      config: SessionConfigSchema.describe("Full effective session configuration"),
      scenario: z
        .object({
          id: z.string().describe("Scenario id"),
          title: z.string().describe("Scenario title"),
          version: z.string().describe("Scenario version"),
          hash: z.string().describe("SHA-256 of the loaded scenario (board, views and starting scores)"),
        })
        .describe("Scenario used in this session"),
      regionIds: z
        .array(z.string())
        .describe(
          "Every region id of the map: one per sub-square, e.g. 'C7-Kb' (square C7, knowledge type Kb)",
        ),
      viewIds: z
        .array(z.string())
        .describe("All view ids available in the scenario (one per knowledge type)"),
      board: BoardSchema.optional().describe(
        "Size of the grid map in squares (absent in sessions recorded before the grid map)",
      ),
      initialScores: z
        .record(z.string(), z.number())
        .optional()
        .describe("Starting score of every sub-square, by region id (from the scenario)"),
      rules: z
        .object({
          id: z.string().describe("Id of the game rules (game/rules.ts)"),
          version: z
            .string()
            .describe("Version of those rules' code (bumped whenever their behaviour changes)"),
        })
        .optional()
        .describe("Game rules this session is played with (docs/GAME-RULES.md)"),
      harness: z
        .object({
          version: z.string().describe("Harness package version"),
          gitCommit: z.string().describe("Git commit of the harness code ('unknown' if not a git checkout)"),
        })
        .describe("Software version, for reproducibility"),
      notes: z.string().describe("Researcher notes entered at creation (no personal data)"),
    }),
    example: {
      config: ConfigExample,
      scenario: { id: "demo", title: "Demo grid", version: "2", hash: "9f2c…" },
      regionIds: ["A1-Ka", "A1-Kb", "A1-Kc", "A1-Kd", "B1-Ka"],
      viewIds: ["Ka", "Kb", "Kc", "Kd"],
      board: { cols: 10, rows: 10 },
      initialScores: { "A1-Ka": 6, "A1-Kb": 3, "A1-Kc": 8, "A1-Kd": 5, "B1-Ka": 7 },
      rules: { id: "standard", version: "1" },
      harness: { version: "0.1.0", gitCommit: "3e1a9c2" },
      notes: "Pilot session",
    },
  }),

  SessionNote: defineRecord({
    summary:
      "Facilitator annotation (e.g. 'fire alarm', 'participant asked a question'), or a system note in a simulated session (e.g. an agent that stopped after errors).",
    trigger: "Facilitator adds a note on the dashboard; the simulation runner when an agent policy fails.",
    actors: ["facilitator", "system"],
    changesState: false,
    visibleTo: "Facilitator",
    dataClass: "non-personal",
    frequency: "0–n per session",
    payload: z.object({
      text: z
        .string()
        .max(500)
        .describe("Note text — must not contain names or other identifying information"),
    }),
    example: { text: "Seat 3 asked how to zoom; explained." },
  }),

  SeatBound: defineRecord({
    summary:
      "A client (player browser) was assigned to a seat and a participant code was generated. For a fake player (a test client the server created) no code is generated.",
    trigger:
      "Facilitator binds a connected client to a seat in the lobby (setup step 08), or adds a fake player to a seat there.",
    actors: ["facilitator"],
    changesState: true,
    visibleTo: "Facilitator; the bound player sees their seat",
    dataClass: "pseudonymous",
    frequency: "1 per seat (more if re-bound)",
    payload: z.object({
      seat: SeatSchema,
      terminal: z
        .number()
        .int()
        .min(1)
        .describe(
          "Client number displayed on the player's screen (field kept as `terminal` for compatibility)",
        ),
      bindingId: z.string().describe("Random id of this binding (used to derive the reconnect token)"),
      fake: z
        .boolean()
        .optional()
        .describe(
          "True if the client is a fake player: a test client the server created itself (no participant, no code, no onboarding). Absent in sessions recorded before fake players existed (= false)",
        ),
      fakePace: FakePaceSchema.optional().describe(
        "Fake players only: pause between their actions ('normal' 1–4 s, 'fast' 0.1–0.3 s)",
      ),
    }),
    example: { seat: 2, terminal: 3, bindingId: "b-7KQ2M9", fake: false },
  }),

  SeatUnbound: defineRecord({
    summary: "A seat binding was removed before the game started.",
    trigger: "Facilitator unbinds a seat (wrong PC, participant left before onboarding).",
    actors: ["facilitator"],
    changesState: true,
    visibleTo: "Facilitator",
    dataClass: "pseudonymous",
    frequency: "rare",
    payload: z.object({
      seat: SeatSchema,
      reason: z.string().max(200).describe("Short reason"),
    }),
    example: { seat: 2, reason: "bound wrong client" },
  }),

  AgentBound: defineRecord({
    summary:
      "A simulated player (agent) took a seat. Simulated sessions only: the seat gets no participant code and no client.",
    trigger: "Server, right after SessionCreated, once per seat of a simulated session.",
    actors: ["system"],
    changesState: true,
    visibleTo: "Facilitator",
    dataClass: "non-personal",
    frequency: "1 per seat (simulated sessions only)",
    payload: z.object({
      seat: SeatSchema,
      policy: z.string().describe("Id of the agent policy that plays this seat"),
      policyVersion: z
        .string()
        .describe("Version of that policy's code (bumped whenever its behaviour changes)"),
      params: z
        .record(z.string(), z.unknown())
        .describe("Effective policy parameters for this seat, defaults filled in"),
      seed: z.string().describe("Seed of this agent's random number generator (session seed + seat number)"),
    }),
    example: {
      seat: 1,
      policy: "random",
      policyVersion: "1",
      params: { proposeBias: 0.5 },
      seed: "7KQ2M9AB:1",
    },
  }),

  LabelsAssigned: defineRecord({
    summary: "Knowledge-type, power-type and map view were (re)assigned to seats, with the K–P pairing used.",
    trigger:
      "Facilitator chooses the K–P pairing (each seat keeps its K; seat n holds the n-th K by default), in setup step 09 or between rounds; the bots and tests may also shuffle K across seats. P always follows from the pairing. Not allowed during an active round.",
    actors: ["facilitator"],
    changesState: true,
    visibleTo: "Facilitator; each player sees own labels (configurable)",
    dataClass: "pseudonymous",
    frequency: "1–n per session",
    payload: z.object({
      assignments: z
        .array(
          z.object({
            seat: SeatSchema,
            k: KLabelSchema,
            p: PLabelSchema,
            view: ViewIdSchema,
          }),
        )
        .describe("Complete assignment for every seat"),
      method: z.enum(["manual", "random"]).describe("How the assignment was produced"),
      seed: z.string().nullable().describe("Seed of the random part of the assignment (null for manual)"),
      pairing: LabelPairingSchema,
    }),
    example: {
      assignments: [
        { seat: 1, k: "Ka", p: "Pd", view: "Ka" },
        { seat: 2, k: "Kb", p: "Pc", view: "Kb" },
      ],
      method: "random",
      seed: "4QX9T2",
      pairing: { mode: "dissociated", id: 6 },
    },
  }),

  OnboardingStarted: defineRecord({
    summary: "Seats are locked; players move to the consent / demographics / briefing / mic check screens.",
    trigger: "Facilitator clicks 'Start onboarding' once all seats are bound and labelled.",
    actors: ["facilitator"],
    changesState: true,
    visibleTo: "Everyone",
    dataClass: "non-personal",
    frequency: "1 per session",
    payload: z.object({
      steps: z
        .array(z.enum(ONBOARDING_STEPS))
        .describe(
          "Onboarding steps enabled for this session, in order ('mic_check' only when the session records audio)",
        ),
    }),
    example: { steps: ["consent", "demographics", "briefing"] },
  }),

  ConsentRecorded: defineRecord({
    summary: "Participant answered the in-game consent form.",
    trigger: "Player submits the consent screen (agree or decline).",
    actors: ["player"],
    changesState: true,
    visibleTo: "Facilitator (consent status only)",
    dataClass: "pseudonymous-sensitive",
    frequency: "1 per seat",
    payload: z.object({
      formVersion: z.string().describe("Version of the consent form shown"),
      textSha256: z.string().describe("SHA-256 of the exact consent text shown"),
      answers: z.record(z.string(), z.boolean()).describe("Answer per consent item id"),
      consented: z.boolean().describe("True if all required items were accepted"),
      durationMs: Ms("Time the consent screen was open"),
    }),
    example: {
      formVersion: "2026-11-v1",
      textSha256: "a3f1…",
      answers: { participate: true, data_use: true, future_research: false },
      consented: true,
      durationMs: 84213,
    },
  }),

  MicCheckCompleted: defineRecord({
    summary:
      "A player finished their own mic check (sessions that record audio): how loud the room and their voice were, and whether it passed.",
    trigger:
      "The player's browser ends the mic check (the last onboarding step, part 1 of 'Mic check & calibration'; it opens once every seat has finished the briefing). Passed: it heard enough speech above the background noise, and the step is done. Not passed: the step stays open (the player tries again, or the facilitator skips the check). Recording starts with the mic check.",
    actors: ["player"],
    changesState: true,
    visibleTo: "Facilitator (mic check status and levels)",
    dataClass: "pseudonymous",
    frequency: "1 per seat (audio sessions only; more if failed checks are logged)",
    payload: z.object({
      passed: z
        .boolean()
        .describe(
          "True if enough speech was heard above the background noise; the mic check step is then done",
        ),
      attempts: z.number().int().min(1).max(100).describe("Attempts the player made, including the last one"),
      durationMs: Ms("Time the mic check screen was open"),
      settings: AudioSettingsSchema,
      noiseFloorDb: Dbfs("Background level measured before the player spoke"),
      speechDb: Dbfs("Level of the player's speech"),
      speechMs: Ms("Speech heard"),
    }),
    example: {
      passed: true,
      attempts: 1,
      durationMs: 14250,
      settings: EXAMPLE_SETTINGS,
      noiseFloorDb: -58.2,
      speechDb: -21.7,
      speechMs: 2840,
    },
  }),

  MicCheckSkipped: defineRecord({
    summary:
      "The facilitator skipped a seat's mic check: the player continues onboarding, but the seat is NOT recorded.",
    trigger:
      "Facilitator clicks 'Skip mic check' for a seat (e.g. no working microphone); the seat's recording stops.",
    actors: ["facilitator"],
    changesState: true,
    visibleTo: "Facilitator; the player moves on to the next onboarding step",
    dataClass: "pseudonymous",
    frequency: "rare (audio sessions only)",
    payload: z.object({
      seat: SeatSchema,
      reason: z
        .string()
        .max(200)
        .describe("Facilitator's reason, e.g. 'no working microphone' (free text, no personal data)"),
    }),
    example: { seat: 3, reason: "no working microphone" },
  }),

  DemographicsSubmitted: defineRecord({
    summary: "Participant submitted the demographics questionnaire.",
    trigger: "Player submits the demographics screen.",
    actors: ["player"],
    changesState: true,
    visibleTo: "Nobody live (facilitator sees 'submitted ✓' only); exported to demographics.csv only",
    dataClass: "pseudonymous-sensitive",
    frequency: "1 per seat",
    payload: z.object({
      formVersion: z.string().describe("Version of the demographics form"),
      answers: z.record(z.string(), z.string()).describe("Selected option value per question id"),
      durationMs: Ms("Time the questionnaire was open"),
    }),
    example: {
      formVersion: "2026-11-v1",
      answers: { age_bracket: "25_34", field: "design", games_experience: "weekly" },
      durationMs: 41022,
    },
  }),

  BriefingAcknowledged: defineRecord({
    summary: "Participant confirmed they read the briefing / instructions.",
    trigger: "Player presses 'I'm ready' on the briefing screen.",
    actors: ["player"],
    changesState: true,
    visibleTo: "Facilitator",
    dataClass: "pseudonymous",
    frequency: "1 per seat",
    payload: z.object({
      textSha256: z.string().describe("SHA-256 of the briefing text shown"),
      durationMs: Ms("Time the briefing was open"),
    }),
    example: { textSha256: "77be…", durationMs: 120400 },
  }),

  PlayerConnected: defineRecord({
    summary: "A bound player's browser (re)connected.",
    trigger: "Socket connects and authenticates with its seat token.",
    actors: ["system"],
    changesState: true,
    visibleTo: "Facilitator; other players see connection status",
    dataClass: "pseudonymous",
    frequency: "1 + number of reconnects per seat",
    payload: z.object({
      seat: SeatSchema,
      reconnect: z.boolean().describe("True if this seat had connected before in this session"),
    }),
    example: { seat: 2, reconnect: false },
  }),

  PlayerDisconnected: defineRecord({
    summary: "A bound player's browser disconnected.",
    trigger: "Socket disconnects (tab closed, network drop, reload).",
    actors: ["system"],
    changesState: true,
    visibleTo: "Facilitator; other players see connection status",
    dataClass: "pseudonymous",
    frequency: "0–n per seat",
    payload: z.object({
      seat: SeatSchema,
      reason: z.string().describe("Socket.IO disconnect reason, e.g. 'transport close'"),
    }),
    example: { seat: 2, reason: "transport close" },
  }),

  AudioTrackStarted: defineRecord({
    summary:
      "A seat's browser started a new audio track: one continuous capture run of its microphone, uploaded in 5 s chunks of 16 kHz mono audio.",
    trigger:
      "Recording (re)starts for a seat: at its mic check, after the facilitator resumes recording, after a reconnect or page reload, or when the microphone comes back after a permission or device loss.",
    actors: ["player"],
    changesState: false,
    visibleTo: "Facilitator (LIVE mic column)",
    dataClass: "pseudonymous",
    frequency: "1 per seat, plus 1 per reconnect, reload and recording pause (audio sessions only)",
    payload: z.object({
      trackId: TrackId,
      sampleRate: z
        .literal(AUDIO_SAMPLE_RATE)
        .describe("Sample rate of the uploaded audio (Hz; always 16 000)"),
      settings: AudioSettingsSchema,
      reason: AudioStartReasonSchema,
    }),
    example: {
      trackId: EXAMPLE_TRACK_ID,
      sampleRate: AUDIO_SAMPLE_RATE,
      settings: EXAMPLE_SETTINGS,
      reason: "mic_check",
    },
  }),

  AudioTrackStopped: defineRecord({
    summary:
      "A seat's audio track ended. The audio itself is stored separately, encrypted (never in the event log).",
    trigger:
      "The browser stops capturing (recording paused, game complete, page unload, microphone lost, capture error), or the server closes the track (disconnect, withdrawal, session closed or aborted).",
    actors: ["player", "system"],
    changesState: false,
    visibleTo: "Facilitator (LIVE mic column)",
    dataClass: "pseudonymous",
    frequency: "1 per AudioTrackStarted",
    payload: z.object({
      trackId: TrackId,
      reason: AudioStopReasonSchema,
      samples: z
        .number()
        .int()
        .min(0)
        .describe("Samples the server stored for this track (16 000 per second)"),
      chunks: z.number().int().min(0).describe("Chunks the server stored for this track"),
      droppedChunks: z
        .number()
        .int()
        .min(0)
        .describe(
          "Chunks the browser had to drop (e.g. its in-memory resend queue overflowed during a long disconnect); their audio is missing",
        ),
    }),
    example: {
      trackId: EXAMPLE_TRACK_ID,
      reason: "paused",
      samples: 9_600_000,
      chunks: 120,
      droppedChunks: 0,
    },
  }),

  CalibrationRequested: defineRecord({
    summary:
      "The facilitator asked for the calibration to be run again: every recorded seat is asked again to say it is ready, and the turns start once all are.",
    trigger:
      "Facilitator clicks 'Redo calibration' (in the onboarding or between rounds); a running calibration ends with it (its turns so far are not used).",
    actors: ["facilitator"],
    changesState: true,
    visibleTo: "Everyone (players see the 'ready for the calibration' button again)",
    dataClass: "non-personal",
    frequency: "0–1 per redo (audio sessions only)",
    payload: z.object({}),
    example: {},
  }),

  CalibrationReady: defineRecord({
    summary:
      "A player said they are ready for the calibration (part 2 of 'Mic check & calibration', after their mic check), so the turns never start by surprise.",
    trigger:
      "Player clicks 'I'm ready for the calibration'. Once every recorded seat is ready, the server starts the calibration (CalibrationStarted).",
    actors: ["player"],
    changesState: true,
    visibleTo: "Facilitator (who is ready); players see who they wait for",
    dataClass: "pseudonymous",
    frequency: "1 per recorded seat per calibration run (audio sessions only)",
    payload: z.object({}),
    example: {},
  }),

  CalibrationStarted: defineRecord({
    summary:
      "The calibration started: each seat in turn reads a sentence aloud while the others stay quiet, which measures how much each voice leaks into the other microphones.",
    trigger:
      "The server, as soon as every recorded seat has said it is ready (CalibrationReady) and every seat is past its mic check; or the facilitator's 'Start calibration' then (sessions that record audio).",
    actors: ["system", "facilitator"],
    changesState: true,
    visibleTo: "Everyone (players see whose turn it is)",
    dataClass: "non-personal",
    frequency: "0–1 per session, plus 1 per redo (audio sessions only)",
    payload: z
      .object({
        order: z.array(SeatSchema).min(1).describe("Seats in turn order"),
        sentenceIds: z
          .array(SentenceId)
          .min(1)
          .describe("Sentence each turn reads (ids from config/audio.json), parallel to order"),
        turnMs: Ms("Length of one seat's turn"),
        gapMs: Ms("Silence between two turns"),
      })
      .refine((p) => p.sentenceIds.length === p.order.length, {
        message: "sentenceIds must have one entry per seat in order",
      }),
    example: {
      order: [1, 2, 3, 4],
      sentenceIds: ["h01-01", "h01-02", "h01-03", "h01-04"],
      turnMs: 6000,
      gapMs: 1000,
    },
  }),

  CalibrationTurn: defineRecord({
    summary:
      "A seat's calibration turn began (the event's serverTs is the start of the turn): that seat reads its sentence aloud, the others stay quiet.",
    trigger:
      "Server timer during the calibration: right after CalibrationStarted, then every turnMs + gapMs.",
    actors: ["system"],
    changesState: true,
    visibleTo: "Everyone (only the seat whose turn it is sees the sentence)",
    dataClass: "pseudonymous",
    frequency: "1 per seat per calibration",
    payload: z.object({
      index: z.number().int().min(0).describe("Position of the turn in the order (0-based)"),
      seat: SeatSchema.describe("Seat whose turn it is"),
      sentenceId: SentenceId,
    }),
    example: { index: 2, seat: 3, sentenceId: "h01-03" },
  }),

  CalibrationCompleted: defineRecord({
    summary:
      "Every calibration turn has run; the turn windows are used to measure the leakage between microphones.",
    trigger: "Server timer, at the end of the last turn.",
    actors: ["system"],
    changesState: true,
    visibleTo: "Everyone",
    dataClass: "non-personal",
    frequency: "0–1 per calibration",
    payload: z.object({
      turns: z
        .array(
          z.object({
            seat: SeatSchema,
            sentenceId: SentenceId,
            startTs: z.number().describe("Start of the turn (server clock, Unix epoch ms)"),
            endTs: z.number().describe("End of the turn (server clock, Unix epoch ms)"),
          }),
        )
        .describe("Every turn with its window, in order"),
    }),
    example: {
      turns: [
        { seat: 1, sentenceId: "h01-01", startTs: 1794825979000.4, endTs: 1794825985000.4 },
        { seat: 2, sentenceId: "h01-02", startTs: 1794825986000.9, endTs: 1794825992000.9 },
      ],
    },
  }),

  CalibrationChecked: defineRecord({
    summary:
      "Quick quality check of the calibration: per seat, how much louder its own voice was on its own microphone than on the loudest other one.",
    trigger: "Server, right after CalibrationCompleted, from the audio of the calibration turns.",
    actors: ["system"],
    changesState: true,
    visibleTo:
      "Facilitator (LIVE: per-seat margins and advice, e.g. 'check the headset is plugged in and worn close to the mouth')",
    dataClass: "pseudonymous",
    frequency: "1 per CalibrationCompleted",
    payload: z.object({
      perSeat: z
        .array(
          z.object({
            seat: SeatSchema,
            ownDb: Dbfs("Level of the seat's voice on its own mic during its turn").nullable(),
            bestOtherDb: Dbfs("Loudest level of that voice on another seat's mic").nullable(),
            marginDb: z
              .number()
              .nullable()
              .describe("ownDb − bestOtherDb (dB); null when the seat's audio is missing"),
            ok: z.boolean().describe("True if the margin is large enough to tell this seat's speech apart"),
          }),
        )
        .describe("Result per seat"),
      ok: z.boolean().describe("True if every seat passed"),
    }),
    example: {
      perSeat: [
        { seat: 1, ownDb: -22.4, bestOtherDb: -38.9, marginDb: 16.5, ok: true },
        { seat: 3, ownDb: -30.1, bestOtherDb: -34.2, marginDb: 4.1, ok: false },
      ],
      ok: false,
    },
  }),

  CalibrationSkipped: defineRecord({
    summary:
      "The facilitator skipped (or cancelled) the calibration; speaker attribution then assumes a conservative default leakage between microphones. Logged by the server with `cancelled: true` when it had to stop a running calibration itself (recording paused, server restart): the calibration is then back to not done and has to be run (or skipped) again.",
    trigger:
      "Facilitator clicks 'Skip calibration' and confirms; or the server stops a running calibration (recording paused, restart).",
    actors: ["facilitator", "system"],
    changesState: true,
    visibleTo: "Everyone",
    dataClass: "non-personal",
    frequency: "0–1 per session (audio sessions only), plus 1 per cancelled run",
    payload: z.object({
      reason: z.string().max(200).describe("Facilitator's reason (free text, no personal data)"),
      cancelled: z
        .boolean()
        .optional()
        .describe(
          "True when the server stopped a running calibration (recording paused, restart): its status goes back to 'pending', so round 1 still waits for a calibration (absent = a facilitator skip)",
        ),
    }),
    example: { reason: "everyone uses a headset" },
  }),

  RoundStarted: defineRecord({
    summary: "A round began; players may now propose/decide.",
    trigger: "Facilitator clicks 'Start round' (or auto-advance timer fires).",
    actors: ["facilitator", "system"],
    changesState: true,
    visibleTo: "Everyone",
    dataClass: "non-personal",
    frequency: "roundCount per session (default 3)",
    payload: z.object({
      round: z.number().int().min(1).describe("Round number (1-based)"),
      spec: RoundSpecSchema.describe("Effective round definition"),
      startedBy: z
        .enum(["facilitator", "auto"])
        .describe("Started by the facilitator, or automatically (roundAdvance = auto)"),
    }),
    example: {
      round: 1,
      spec: { rule: "quota", quota: { propose: 5, decide: 5 }, timeLimitSec: null },
      startedBy: "facilitator",
    },
  }),

  ProposalMade: defineRecord({
    summary:
      "A player proposed a sub-square of the map (hatched in its knowledge-type colour for all players).",
    trigger:
      "Player picks a square with the propose tool and confirms; the server accepts it. The sub-square is the one the game rules give the player (standard rules: the one matching their power type).",
    actors: ["player"],
    changesState: true,
    visibleTo: "Everyone (actor seat visible to players if showActorToPlayers)",
    dataClass: "pseudonymous",
    frequency: "≤ quota.propose × seats × rounds (default 60)",
    payload: z.object({
      regionId: z.string().describe("Target sub-square, e.g. 'C7-Kb'"),
      quotaUsed: z
        .number()
        .int()
        .min(1)
        .describe("Proposals this seat has made this round, including this one"),
      quotaLimit: z.number().int().nullable().describe("Proposal quota this round (null = unlimited)"),
      priorProposals: SeatList.describe("Seats that had already proposed this sub-square this round"),
      priorDecisions: SeatList.describe("Seats that had already decided this sub-square this round"),
      msSinceRoundStart: Ms("Active (un-paused) server time since the round started"),
      scoreChanges: ScoreChangesSchema,
    }),
    example: {
      regionId: "C7-Kb",
      quotaUsed: 2,
      quotaLimit: 5,
      priorProposals: [3],
      priorDecisions: [],
      msSinceRoundStart: 51234,
      scoreChanges: [],
    },
  }),

  DecisionMade: defineRecord({
    summary:
      "A player decided on a sub-square of the map (filled in its knowledge-type colour for all players); the game rules change the scores.",
    trigger:
      "Player picks a square with the decide tool and confirms; the server accepts it. The sub-square is the one the game rules give the player (standard rules: the one matching their power type).",
    actors: ["player"],
    changesState: true,
    visibleTo: "Everyone (actor seat visible to players if showActorToPlayers)",
    dataClass: "pseudonymous",
    frequency: "≤ quota.decide × seats × rounds (default 60)",
    payload: z.object({
      regionId: z.string().describe("Target sub-square, e.g. 'C7-Kb'"),
      quotaUsed: z
        .number()
        .int()
        .min(1)
        .describe("Decisions this seat has made this round, including this one"),
      quotaLimit: z.number().int().nullable().describe("Decision quota this round (null = unlimited)"),
      priorProposals: SeatList.describe(
        "Seats that had proposed this sub-square this round before this decision",
      ),
      priorDecisions: SeatList.describe("Seats that had already decided this sub-square this round"),
      msSinceRoundStart: Ms("Active (un-paused) server time since the round started"),
      scoreChanges: ScoreChangesSchema,
    }),
    example: {
      regionId: "C7-Kb",
      quotaUsed: 1,
      quotaLimit: 5,
      priorProposals: [3, 2],
      priorDecisions: [],
      msSinceRoundStart: 73410,
      scoreChanges: [
        { regionId: "C7-Kb", from: 6, to: 10 },
        { regionId: "C7-Ka", from: 5, to: 4 },
        { regionId: "C7-Kc", from: 2, to: 1 },
      ],
    },
  }),

  IntentRejected: defineRecord({
    summary: "A player's propose/decide attempt was refused by the rules.",
    trigger:
      "Server validation fails (not active, paused, quota used up, unknown sub-square, a sub-square the game rules do not give this player, …).",
    actors: ["player"],
    changesState: false,
    visibleTo: "Facilitator; the acting player gets an error message",
    dataClass: "pseudonymous",
    frequency: "rare",
    payload: z.object({
      kind: ActionKindSchema,
      regionId: z.string().describe("Sub-square the player tried to act on"),
      reason: z
        .enum(["round_not_active", "paused", "seat_inactive", "unknown_region", "quota_exhausted", "rule"])
        .describe("Machine-readable rejection reason"),
      detail: z.string().describe("Human-readable explanation"),
    }),
    example: {
      kind: "decide",
      regionId: "B2-Ka",
      reason: "quota_exhausted",
      detail: "No decisions left this round",
    },
  }),

  ActionRevoked: defineRecord({
    summary: "Facilitator undid a proposal/decision (e.g. misclick). The original event is kept.",
    trigger: "Facilitator clicks 'Revoke' on an action during the active round.",
    actors: ["facilitator"],
    changesState: true,
    visibleTo: "Everyone (the hatch/fill disappears and its score changes are undone)",
    dataClass: "pseudonymous",
    frequency: "rare",
    payload: z.object({
      targetSeq: z.number().int().describe("seq of the ProposalMade/DecisionMade being revoked"),
      targetType: z.enum(["ProposalMade", "DecisionMade"]).describe("Type of the revoked event"),
      targetSeat: SeatSchema.describe("Seat whose action was revoked"),
      regionId: z.string().describe("Sub-square of the revoked action"),
      reason: z.string().max(200).describe("Facilitator's reason (free text, no personal data)"),
      scoreChanges: ScoreChangesSchema.describe(
        "Score changes caused by the revocation: the scores replayed without the revoked action, compared with before. Absent in sessions recorded before the grid map",
      ),
    }),
    example: {
      targetSeq: 57,
      targetType: "DecisionMade",
      targetSeat: 4,
      regionId: "F3-Kd",
      reason: "misclick",
      scoreChanges: [
        { regionId: "F3-Kd", from: 9, to: 5 },
        { regionId: "F3-Ka", from: 2, to: 3 },
      ],
    },
  }),

  RoundCompleted: defineRecord({
    summary: "A round ended.",
    trigger: "All quotas used (rule 'quota'), time limit elapsed, or facilitator force-ended the round.",
    actors: ["system", "facilitator"],
    changesState: true,
    visibleTo: "Everyone",
    dataClass: "non-personal",
    frequency: "roundCount per session",
    payload: z.object({
      round: z.number().int().min(1).describe("Round that ended (1-based)"),
      reason: z
        .enum(["quota_met", "time_limit", "facilitator"])
        .describe("Why the round ended: all quotas used, time limit elapsed, or facilitator force-ended it"),
      durationMs: Ms("Wall-clock server time from RoundStarted to RoundCompleted, pauses included"),
      pausedMs: Ms("Total time paused during the round"),
      actionCounts: z
        .record(z.string(), z.object({ propose: z.number().int(), decide: z.number().int() }))
        .describe("Non-revoked actions per seat in this round"),
    }),
    example: {
      round: 1,
      reason: "quota_met",
      durationMs: 612000,
      pausedMs: 0,
      actionCounts: { "1": { propose: 5, decide: 5 }, "2": { propose: 5, decide: 5 } },
    },
  }),

  GamePaused: defineRecord({
    summary: "The game was paused; actions are refused until resumed.",
    trigger: "Facilitator presses pause, or a player disconnects during a round (pauseOnDisconnect).",
    actors: ["facilitator", "system"],
    changesState: true,
    visibleTo: "Everyone",
    dataClass: "non-personal",
    frequency: "0–n",
    payload: z.object({
      reason: z
        .enum(["facilitator", "disconnect"])
        .describe("Paused by the facilitator, or automatically because a player disconnected"),
      seat: SeatSchema.nullable().describe("Seat that disconnected (reason = disconnect)"),
    }),
    example: { reason: "disconnect", seat: 3 },
  }),

  GameResumed: defineRecord({
    summary: "The game was resumed after a pause.",
    trigger: "Facilitator presses resume.",
    actors: ["facilitator"],
    changesState: true,
    visibleTo: "Everyone",
    dataClass: "non-personal",
    frequency: "0–n",
    payload: z.object({ pausedMs: Ms("Length of the pause") }),
    example: { pausedMs: 45000 },
  }),

  RecordingPaused: defineRecord({
    summary:
      "The facilitator paused audio recording for every seat (players cannot mute themselves). The game itself goes on.",
    trigger: "Facilitator clicks 'Pause recording' in TOOLS and confirms; every seat's track stops.",
    actors: ["facilitator"],
    changesState: true,
    visibleTo: "Everyone (players see that recording is paused)",
    dataClass: "non-personal",
    frequency: "0–n (audio sessions only)",
    payload: z.object({
      reason: z
        .string()
        .max(200)
        .optional()
        .describe("Facilitator's reason, e.g. 'private conversation' (free text, no personal data)"),
    }),
    example: { reason: "break" },
  }),

  RecordingResumed: defineRecord({
    summary: "The facilitator resumed audio recording; every recorded seat starts a new track.",
    trigger: "Facilitator clicks 'Resume recording' in TOOLS.",
    actors: ["facilitator"],
    changesState: true,
    visibleTo: "Everyone",
    dataClass: "non-personal",
    frequency: "1 per RecordingPaused",
    payload: z.object({}),
    example: {},
  }),

  FacilitatorBroadcast: defineRecord({
    summary: "Facilitator sent a message shown on every player's screen.",
    trigger: "Facilitator uses 'Broadcast'.",
    actors: ["facilitator"],
    changesState: true,
    visibleTo: "Everyone",
    dataClass: "non-personal",
    frequency: "0–n",
    payload: z.object({ text: z.string().max(300).describe("Message text") }),
    example: { text: "Five minutes left in this round." },
  }),

  ParticipantWithdrawn: defineRecord({
    summary: "A participant withdrew (during the session) or their data was erased afterwards.",
    trigger: "Facilitator marks a participant as withdrawn, or an erasure request is executed.",
    actors: ["facilitator", "system"],
    changesState: true,
    visibleTo: "Facilitator; other players see the seat as inactive",
    dataClass: "non-personal",
    frequency: "rare",
    payload: z.object({
      seat: SeatSchema,
      by: z.enum(["facilitator", "erasure"]).describe("How the withdrawal was recorded"),
      phase: z.string().describe("Session phase when the withdrawal was recorded"),
    }),
    example: { seat: 3, by: "facilitator", phase: "round_active" },
  }),

  GameCompleted: defineRecord({
    summary: "The last round finished (or the facilitator ended the game early).",
    trigger: "RoundCompleted for the final round, or facilitator clicks 'End game'.",
    actors: ["system", "facilitator"],
    changesState: true,
    visibleTo: "Everyone (players see the end screen with their takedown code)",
    dataClass: "non-personal",
    frequency: "1 per session",
    payload: z.object({
      roundsPlayed: z.number().int().min(0).describe("Number of rounds started"),
      reason: z
        .enum(["all_rounds", "facilitator"])
        .describe("All rounds were played, or the facilitator ended the game early"),
    }),
    example: { roundsPlayed: 3, reason: "all_rounds" },
  }),

  SessionClosed: defineRecord({
    summary: "Session archived; no further events except erasure markers.",
    trigger: "Facilitator clicks 'Close session'.",
    actors: ["facilitator"],
    changesState: true,
    visibleTo: "Facilitator",
    dataClass: "non-personal",
    frequency: "1 per session",
    payload: z.object({}),
    example: {},
  }),

  SessionAborted: defineRecord({
    summary: "Session abandoned before completion (data kept, marked as aborted).",
    trigger: "Facilitator clicks 'Abort session'.",
    actors: ["facilitator"],
    changesState: true,
    visibleTo: "Everyone",
    dataClass: "non-personal",
    frequency: "rare",
    payload: z.object({
      reason: z.string().max(200).describe("Facilitator's reason (free text, no personal data)"),
    }),
    example: { reason: "network failure" },
  }),
} as const;

export type EventDefs = typeof EVENT_DEFS;
export type EventType = keyof EventDefs;
export const EVENT_TYPES = Object.keys(EVENT_DEFS) as EventType[];
export type PayloadOf<T extends EventType> = z.infer<EventDefs[T]["payload"]>;

export const ActorKindSchema = z.enum(["player", "facilitator", "system"]).describe("Who caused the event");
export type ActorKind = z.infer<typeof ActorKindSchema>;

/** Envelope fields shared by every stored event. Column names in SQLite are snake_case. */
export const EventEnvelopeSchema = z.object({
  sessionId: z.string().describe("Session id, e.g. S-20261116-7KQ2"),
  seq: z
    .number()
    .int()
    .min(1)
    .describe("Position in the session's event log (1, 2, 3, …; gaps only after erasure)"),
  type: z.enum(EVENT_TYPES as [EventType, ...EventType[]]).describe("Event type"),
  actorKind: ActorKindSchema,
  seat: SeatSchema.nullable().describe("Seat the event is about/caused by (null for session-level events)"),
  participantCode: z
    .string()
    .nullable()
    .describe("Pseudonymous participant code of that seat — the ONLY place codes are stored"),
  round: z.number().int().min(0).describe("Current round when the event happened (0 = before round 1)"),
  serverTs: z
    .number()
    .describe(
      "Server timestamp, Unix epoch milliseconds with sub-ms precision (monotonic within a server run)",
    ),
  serverWall: z.string().describe("Server wall-clock time, ISO-8601 UTC (human-readable copy of serverTs)"),
  clientTs: z
    .number()
    .nullable()
    .describe("Client timestamp corrected to server time (epoch ms) for player-initiated events, else null"),
  clientSeq: z
    .number()
    .int()
    .nullable()
    .describe("Client-side sequence number of the intent (idempotency on reconnect), else null"),
});
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

/** A stored event: envelope + typed payload (a discriminated union on `type`). */
export type StoredEvent = {
  [K in EventType]: Omit<EventEnvelope, "type"> & { type: K; payload: PayloadOf<K> };
}[EventType];

export type EventOf<T extends EventType> = Extract<StoredEvent, { type: T }>;

/** What the server passes to the event store; seq/timestamps are filled in on append. */
export type NewEvent = {
  [K in EventType]: {
    type: K;
    payload: PayloadOf<K>;
    actorKind: ActorKind;
    seat?: number | null;
    participantCode?: string | null;
    clientTs?: number | null;
    clientSeq?: number | null;
  };
}[EventType];

/** Types whose payload must be hidden from live dashboards and generic exports. */
export const REDACTED_EVENT_TYPES: ReadonlySet<EventType> = new Set(["DemographicsSubmitted"]);
