import { z } from "zod";
import { MAX_SEATS } from "./labels";

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

/* ─────────────────────────── Session config ─────────────────────────── */

export const SessionConfigSchema = z
  .object({
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
    allowDuplicateLabels: z.boolean().default(false).describe("Allow two seats to share a K or P label"),
    clearHighlightsEachRound: z
      .boolean()
      .default(true)
      .describe("If true, players only see the current round's proposals/decisions"),
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
    condition: z
      .string()
      .max(100)
      .default("")
      .describe("Free label for the experimental condition (researcher-entered, no personal data)"),
  })
  .describe("Session configuration (stored verbatim in SessionCreated)");

export type SessionConfig = z.infer<typeof SessionConfigSchema>;
export type SessionConfigInput = z.input<typeof SessionConfigSchema>;

export function parseSessionConfig(input: unknown): SessionConfig {
  return SessionConfigSchema.parse(input ?? {});
}

/** Effective round spec for round `n` (1-based). */
export function roundSpecFor(config: SessionConfig, round: number): RoundSpec {
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
});

export const ConsentFormSchema = z.object({
  version: z.string().describe("Version of the consent form; bump whenever the text changes"),
  markdownFile: z.string().default("consent.md"),
  items: z.array(ConsentItemSchema).min(1),
});
export type ConsentForm = z.infer<typeof ConsentFormSchema>;

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
export type DemographicsForm = z.infer<typeof DemographicsFormSchema>;

/** Value every demographic question must offer. */
export const PREFER_NOT_TO_SAY = "prefer_not_to_say";

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
});
export type OnboardingContent = z.infer<typeof OnboardingContentSchema>;
