import { z } from "zod";
import { DEFAULT_GAME_RULES } from "./game/rules";
import { MAX_SEATS } from "./labels";
import type { DeepReadonly } from "./state";

/* ─────────────────────────── Rounds ─────────────────────────── */

/**
 * Quota for one action kind per player per round. `null` = unlimited.
 * The default round is "propose 5 + decide 5 per player".
 */
const QuotaValue = z.number().int().min(0).nullable();

export const RoundSpecSchema = z
  .object({
    rule: z
      .enum(["quota", "manual"])
      .default("quota")
      .describe(
        "Round-completion rule: 'quota' = round ends when every active player has used all quotas; 'manual' = only the facilitator (or the time limit) ends the round",
      ),
    quota: z
      .object({
        propose: QuotaValue.default(5).describe("Max proposals per player in this round (null = unlimited)"),
        decide: QuotaValue.default(5).describe("Max decisions per player in this round (null = unlimited)"),
      })
      .default({ propose: 5, decide: 5 })
      .describe("Per-player action quotas for the round"),
    timeLimitSec: z
      .number()
      .int()
      .positive()
      .nullable()
      .default(null)
      .describe("Optional time limit in seconds; the round ends automatically when it elapses"),
  })
  .describe("What counts as a round");
export type RoundSpec = z.infer<typeof RoundSpecSchema>;

/* ─────────────────────────── Players: real or simulated ─────────────────────────── */

/**
 * Who plays a session. `real`: participants on player PCs (consent, participant
 * codes, client binding; stored in the participant database). `simulated`:
 * in-process agents driven by a policy (no consent, codes or clients; stored
 * in the separate simulation database).
 */
export const PLAYER_MODES = ["real", "simulated"] as const;
export type PlayerMode = (typeof PLAYER_MODES)[number];

/** Id of an agent policy in the simulation registry (packages/shared/src/simulation/). */
export const PolicyIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, "Policy ids are lowercase letters, digits and dashes")
  .max(40);

export const SIMULATION_DEFAULTS = {
  policy: "random",
  seatPolicies: {},
  params: {},
  seed: null,
  minDelayMs: 800,
  maxDelayMs: 2500,
};

export const SimulationConfigSchema = z
  .object({
    policy: PolicyIdSchema.default("random").describe(
      "Agent policy every simulated seat uses unless overridden (see ARCHITECTURE.md § Simulated players)",
    ),
    seatPolicies: z
      .record(z.string().regex(/^\d+$/), PolicyIdSchema)
      .default({})
      .describe("Per-seat policy overrides keyed by seat number, e.g. { '2': 'idle' }"),
    params: z
      .record(PolicyIdSchema, z.record(z.string(), z.unknown()))
      .default({})
      .describe(
        "Policy parameters keyed by policy id, e.g. { 'random': { 'proposeBias': 0.7 } }; each policy checks and completes its own",
      ),
    seed: z
      .string()
      .min(1)
      .max(40)
      .nullable()
      .default(null)
      .describe(
        "Seed for the agents' random choices; null = a random seed is drawn when the session is created and stored here",
      ),
    minDelayMs: z
      .number()
      .int()
      .min(0)
      .max(600_000)
      .default(800)
      .describe("Shortest pause before an agent's turn (ms); 0 and 0 = as fast as possible"),
    maxDelayMs: z
      .number()
      .int()
      .min(0)
      .max(600_000)
      .default(2500)
      .describe("Longest pause before an agent's turn (ms)"),
  })
  .describe("Simulated players (used only when players = 'simulated')");
export type SimulationConfig = z.infer<typeof SimulationConfigSchema>;

/* ─────────────────────────── Fake players ─────────────────────────── */

/** Pause between a fake player's actions (ms). Fake players are test clients the server creates. */
export const FAKE_PLAYER_PACES = {
  normal: { minDelayMs: 1000, maxDelayMs: 4000, label: "Normal · 1–4 s" },
  fast: { minDelayMs: 100, maxDelayMs: 300, label: "Fast · 0.1–0.3 s" },
} as const;
export type FakePlayerPace = keyof typeof FAKE_PLAYER_PACES;
export const FakePaceSchema = z
  .enum(Object.keys(FAKE_PLAYER_PACES) as [FakePlayerPace, ...FakePlayerPace[]])
  .describe(
    `Pause between a fake player's actions: ${Object.entries(FAKE_PLAYER_PACES)
      .map(([k, v]) => `'${k}' ${v.label.split(" · ")[1]}`)
      .join(", ")}`,
  );

/* ─────────────────────────── Session config ─────────────────────────── */

/** Audio recording is off unless a session switches it on (setup step 05). */
export const AUDIO_CONFIG_DEFAULTS = { enabled: false, requireCalibration: true };

export const MAX_TAGS = 20;
export const MAX_TAG_LENGTH = 40;

export const SessionConfigSchema = z
  .object({
    players: z
      .enum(PLAYER_MODES)
      .default("real")
      .describe(
        "Who plays: 'real' = participants on player PCs (consent, codes, client binding; participant database); 'simulated' = in-process agents (no consent, codes or clients; simulation database)",
      ),
    simulation: SimulationConfigSchema.default(SIMULATION_DEFAULTS),
    rules: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/)
      .default(DEFAULT_GAME_RULES)
      .describe(
        "Game rules: what players act on and how actions change the scores (id from game/rules.ts; see GAME-RULES.md)",
      ),
    seatCount: z
      .number()
      .int()
      .min(1)
      .max(MAX_SEATS)
      .default(4)
      .describe("Number of player seats (4 for real sessions; fewer for pilots)"),
    roundCount: z.number().int().min(1).max(20).default(3).describe("Number of rounds in the game"),
    defaultRound: RoundSpecSchema.default({
      rule: "quota",
      quota: { propose: 5, decide: 5 },
      timeLimitSec: null,
    }).describe("Round definition used for every round unless overridden"),
    roundOverrides: z
      .record(z.string().regex(/^\d+$/), RoundSpecSchema)
      .default({})
      .describe("Per-round overrides keyed by round number, e.g. { '3': { ... } }"),
    roundAdvance: z
      .enum(["facilitator", "auto"])
      .default("facilitator")
      .describe("Who starts the next round after one completes"),
    autoAdvanceDelaySec: z
      .number()
      .int()
      .min(0)
      .default(10)
      .describe("Delay before the next round starts when roundAdvance = 'auto'"),
    viewAssignment: z
      .enum(["byKnowledgeType", "manual"])
      .default("byKnowledgeType")
      .describe("How a seat's map view is chosen: from its K label, or set manually by the facilitator"),
    clearHighlightsEachRound: z
      .boolean()
      .default(true)
      .describe(
        "If true, the map only shows the current round's proposals (hatched) and decisions (filled); scores always carry over",
      ),
    pauseOnDisconnect: z
      .boolean()
      .default(true)
      .describe("Automatically pause the game when a player disconnects during a round"),
    onboarding: z
      .object({
        consent: z
          .boolean()
          .default(true)
          .describe("Show the in-game consent screen (keep ON for real sessions)"),
        demographics: z.boolean().default(true).describe("Show the demographics questionnaire"),
        briefing: z.boolean().default(true).describe("Show the briefing / instructions screen"),
      })
      .default({ consent: true, demographics: true, briefing: true })
      .describe("Onboarding steps each player completes before round 1"),
    audio: z
      .object({
        enabled: z
          .boolean()
          .default(false)
          .describe(
            "Record each participant's microphone, from their mic check (the last onboarding step, once every seat has finished the briefing) until the game is complete. Needs the consent step with the audio consent item, and HTTPS; never used for simulated sessions or fake players",
          ),
        requireCalibration: z
          .boolean()
          .default(true)
          .describe(
            "With audio on: round 1 can start only once the calibration (each seat reads a sentence aloud in turn while the others stay quiet) is done or skipped",
          ),
      })
      .default(AUDIO_CONFIG_DEFAULTS)
      .describe("Microphone recording (research data: see DATA-MANAGEMENT.md)"),
    visibility: z
      .object({
        showActorToPlayers: z
          .boolean()
          .default(true)
          .describe("Players see which seat made each proposal/decision"),
        showOwnLabels: z.boolean().default(true).describe("Players see their own K/P labels"),
        showOtherLabelsToPlayers: z.boolean().default(false).describe("Players see other seats' K/P labels"),
        showOthersProgress: z.boolean().default(true).describe("Players see other seats' quota progress"),
      })
      .default({
        showActorToPlayers: true,
        showOwnLabels: true,
        showOtherLabelsToPlayers: false,
        showOthersProgress: true,
      })
      .describe("What players can see about each other"),
    tags: z
      .array(
        z
          .string()
          .min(1)
          .max(MAX_TAG_LENGTH)
          .regex(/^[^,]+$/, "Tags cannot contain commas"),
      )
      .max(MAX_TAGS)
      .default([])
      .describe(
        "Researcher-entered session tags, e.g. ['pilot', 'condition-A'] (entered comma-separated; no personal data)",
      ),
  })
  // nobody may be recorded without consent: a session that records audio must ask for it
  .refine((c) => !c.audio.enabled || c.players === "simulated" || c.onboarding.consent, {
    message: "Recording audio needs the consent step (onboarding.consent)",
    path: ["audio", "enabled"],
  })
  .describe("Session configuration (stored verbatim in SessionCreated)");

export type SessionConfig = z.infer<typeof SessionConfigSchema>;
export type SessionConfigInput = z.input<typeof SessionConfigSchema>;

/**
 * Normalise tags typed as one comma-separated string (or a list): trimmed,
 * inner whitespace collapsed, empty entries dropped, de-duplicated
 * case-insensitively (first spelling wins), at most MAX_TAGS of at most
 * MAX_TAG_LENGTH characters.
 */
export function normaliseTags(input: string | readonly string[]): string[] {
  const parts = typeof input === "string" ? input.split(",") : input.flatMap((t) => t.split(","));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of parts) {
    const t = raw.replace(/\s+/g, " ").trim().slice(0, MAX_TAG_LENGTH).trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/**
 * Parse a session config, upgrading older formats: before tags existed,
 * sessions had a single free-text `condition`; it becomes the tag list, and
 * the old `appearance` block (player animations/theme) is dropped.
 * Used for new configs AND when replaying old SessionCreated events.
 */
export function parseSessionConfig(input: unknown): SessionConfig {
  const obj: Record<string, unknown> =
    input && typeof input === "object" ? { ...(input as Record<string, unknown>) } : {};
  if (!Array.isArray(obj.tags) && typeof obj.condition === "string") obj.tags = normaliseTags(obj.condition);
  if (Array.isArray(obj.tags)) obj.tags = normaliseTags(obj.tags as string[]);
  delete obj.condition;
  // Display settings (colours, font, text size, animations) used to be partly a session setting
  // (`appearance`); they are now each screen's own accessibility choice and never part of the config.
  delete obj.appearance;
  return SessionConfigSchema.parse(obj);
}

/**
 * What a simulated session actually runs with: no onboarding (agents cannot
 * consent or answer questionnaires), no pause on disconnect (agents never
 * disconnect) and no audio (agents have no microphone). A no-op for real
 * sessions.
 */
export function normaliseForPlayers(config: SessionConfig): SessionConfig {
  if (config.players !== "simulated") return config;
  return {
    ...config,
    onboarding: { consent: false, demographics: false, briefing: false },
    pauseOnDisconnect: false,
    audio: { ...config.audio, enabled: false },
  };
}

/** Effective round spec for round `n` (1-based). */
export function roundSpecFor(config: DeepReadonly<SessionConfig>, round: number): RoundSpec {
  return config.roundOverrides[String(round)] ?? config.defaultRound;
}

/* ─────────────────────────── Study / consent / demographics ─────────────────────────── */

export const StudyConfigSchema = z.object({
  title: z.string().describe("Study title shown to participants"),
  institution: z.string().default(""),
  researcher: z.string().describe("Researcher name/role shown on consent screen and takedown card"),
  contactEmail: z.string().describe("Contact address for questions and withdrawal requests"),
  supervisor: z.string().default(""),
  retention: z.string().describe("Human-readable retention statement"),
  takedownInstructions: z.string().describe("Text printed on the takedown card"),
  briefingMarkdownFile: z.string().default("briefing.md"),
});
export type StudyConfig = z.infer<typeof StudyConfigSchema>;

export const ConsentItemSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9_]+$/)
    .describe("Stable id of the consent statement"),
  text: z.string().describe("Statement the participant ticks"),
  required: z.boolean().default(true).describe("Participation is impossible without this item"),
  when: z
    .enum(["audio"])
    .optional()
    .describe("Shown only when the session records audio ('audio'); absent = always shown"),
  section: z
    .string()
    .optional()
    .describe(
      "The '## ' heading of the consent text this statement confirms: the consent screen shows each section with its one statement",
    ),
});

export const ConsentFormSchema = z.object({
  version: z.string().describe("Version of the consent form; bump whenever the text changes"),
  markdownFile: z.string().default("consent.md"),
  items: z.array(ConsentItemSchema).min(1),
});

export const DemographicQuestionSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/),
  text: z.string(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).min(2),
});

export const DemographicsFormSchema = z.object({
  version: z.string(),
  intro: z.string().default(""),
  questions: z.array(DemographicQuestionSchema),
});

/**
 * Compose the consent text and items for one session. Markdown between
 * `<!-- if audio -->` and `<!-- end if -->` is kept (markers stripped) when the
 * session records audio and removed when it does not; items with
 * `when: "audio"` are dropped when it does not. Pure and deterministic, so the
 * hash of the composed text identifies exactly what a participant saw.
 *
 * Throws on a marker it cannot pair (a missing or misspelled `<!-- end if -->`,
 * a nested block, an unknown condition), so audio-only text never leaks into
 * a session without audio.
 */
export function composeConsent<I extends { when?: "audio" | undefined }>(
  consent: { markdown: string; items: readonly I[] },
  opts: { audio: boolean },
): { markdown: string; items: I[] } {
  return {
    markdown: composeConditionalMarkdown(consent.markdown, opts.audio),
    items: consent.items.filter((i) => opts.audio || i.when !== "audio"),
  };
}

/** One sub-section of the consent screen: a `## ` section of the text and the one statement that confirms it. */
export interface ConsentSection<I> {
  title: string;
  /** The section's text, without its heading. */
  markdown: string;
  item: I;
}

/**
 * Split a composed consent text into its `## ` sections, each with the one statement (item) whose
 * `section` names its heading, in the order of the text. `intro` is the text before the first
 * section (the title). Throws unless every section has exactly one statement and every statement
 * names a section of the text, so no information is shown without its confirmation, and no
 * statement without its information.
 */
export function consentSections<I extends { id: string; section?: string | undefined }>(
  markdown: string,
  items: readonly I[],
): { intro: string; sections: ConsentSection<I>[] } {
  const parts = markdown.split(/^## +/m);
  const intro = parts.shift()!.trim();
  const sections = parts.map((part) => {
    const nl = part.indexOf("\n");
    const title = (nl < 0 ? part : part.slice(0, nl)).trim();
    const linked = items.filter((i) => i.section?.trim() === title);
    if (linked.length !== 1)
      throw new Error(
        `Consent text: section '${title}' needs exactly one consent statement with "section": "${title}" (has ${linked.length})`,
      );
    return { title, markdown: nl < 0 ? "" : part.slice(nl + 1).trim(), item: linked[0]! };
  });
  const titles = new Set(sections.map((sec) => sec.title));
  const orphan = items.find((i) => !i.section || !titles.has(i.section.trim()));
  if (orphan)
    throw new Error(
      `Consent statement '${orphan.id}': "section" must name a '## ' heading of the consent text${orphan.section ? ` ('${orphan.section}' is not one)` : ""}`,
    );
  return { intro, sections };
}

const AUDIO_BLOCK = /<!--\s*if\s+audio\s*-->([\s\S]*?)<!--\s*end\s*if\s*-->/gi;
/** Any condition marker left after composing means the text was not written as intended. */
const STRAY_MARKER = /<!--\s*(?:if\b|end\s*if\b)/i;

function composeConditionalMarkdown(md: string, audio: boolean): string {
  const composed = composeBlocks(md, audio);
  const stray = STRAY_MARKER.exec(composed);
  if (stray) {
    const line = composed.slice(0, stray.index).split("\n").length;
    throw new Error(
      `Consent text: unmatched or unknown condition marker near line ${line} (use '<!-- if audio -->' … '<!-- end if -->', not nested)`,
    );
  }
  return composed;
}

function composeBlocks(md: string, audio: boolean): string {
  let out = "";
  let last = 0;
  for (const m of md.matchAll(AUDIO_BLOCK)) {
    out += md.slice(last, m.index);
    last = m.index + m[0].length;
    if (audio) {
      // keep the content; a block written on lines of its own loses the line breaks next to its markers
      out += (m[1] ?? "").replace(/^[ \t]*\r?\n/, "").replace(/\r?\n[ \t]*$/, "");
      continue;
    }
    // removed: a block on lines of its own also takes its line break, and one of the blank lines around it
    if (out === "" || out.endsWith("\n")) {
      const eol = /^[ \t]*\r?\n/.exec(md.slice(last));
      if (eol) last += eol[0].length;
      if (out === "" || /\n[ \t]*\r?\n$/.test(out)) {
        const blank = /^[ \t]*\r?\n/.exec(md.slice(last));
        if (blank) last += blank[0].length;
      }
    }
  }
  return out + md.slice(last);
}

/** Value every demographic question must offer. */
export const PREFER_NOT_TO_SAY = "prefer_not_to_say";

/** Texts and timings of the audio steps (`config/audio.json`), used when a session records audio. */
export const AudioContentSchema = z.object({
  micCheck: z
    .object({
      phrase: z.string().min(1).max(300).describe("Sentence each player reads aloud during their mic check"),
      minSpeechMs: z
        .number()
        .int()
        .min(200)
        .max(30_000)
        .default(1000)
        .describe("Speech the mic check must hear before it passes (ms)"),
    })
    .describe("Each player's own mic check (onboarding step after consent)"),
  calibration: z
    .object({
      sentences: z
        .array(
          z.object({
            id: z
              .string()
              .regex(/^[a-z0-9_-]+$/)
              .max(40)
              .describe("Stable id of the sentence (logged in CalibrationStarted / CalibrationTurn)"),
            text: z.string().min(1).max(300).describe("Sentence a seat reads aloud in its calibration turn"),
          }),
        )
        .min(4)
        .refine((list) => new Set(list.map((s) => s.id)).size === list.length, {
          message: "Calibration sentence ids must be unique",
        })
        .describe("Sentences for the calibration turns (at least one per seat)"),
      turnMs: z.number().int().min(2000).max(30_000).default(6000).describe("Length of one seat's turn (ms)"),
      gapMs: z.number().int().min(0).max(10_000).default(1000).describe("Silence between two turns (ms)"),
    })
    .describe(
      "Facilitator-led calibration: each seat in turn reads a sentence while the others stay quiet (gives the leakage between microphones)",
    ),
});

/** Content shown to players during onboarding (sent inside their projection). */
export const OnboardingContentSchema = z.object({
  study: StudyConfigSchema,
  consent: z.object({
    version: z.string(),
    markdown: z.string(),
    sha256: z.string(),
    items: z.array(ConsentItemSchema),
  }),
  demographics: DemographicsFormSchema,
  briefing: z.object({ markdown: z.string(), sha256: z.string() }),
  audio: AudioContentSchema.optional().describe(
    "Mic check and calibration texts (sessions that record audio)",
  ),
});
export type OnboardingContent = z.infer<typeof OnboardingContentSchema>;
