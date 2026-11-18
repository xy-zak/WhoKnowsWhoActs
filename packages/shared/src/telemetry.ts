import { z } from "zod";
import { ActionKindSchema, SeatSchema } from "./labels";
import { defineRecord } from "./meta";

/* ═══════════════════════════════════════════════════════════════════════════
 * TELEMETRY — fine-grained UI behaviour. Never changes game state.
 * Batched by the client (every 2 s or 20 items) and stored in `telemetry`.
 * Contains no free text, no pointer coordinates, no device information.
 * ═══════════════════════════════════════════════════════════════════════════ */

const Ms = (d: string) => z.number().min(0).describe(`${d} (milliseconds)`);

export const TELEMETRY_DEFS = {
  screen_view: defineRecord({
    summary: "The player's client showed a new screen.",
    trigger:
      "Client switches screen. Telemetry is only stored after consent, so pre-consent screens (waiting, lobby, consent, declined) never appear in the data.",
    actors: ["player"],
    changesState: false,
    visibleTo: "Facilitator",
    dataClass: "pseudonymous",
    frequency: "~10 per seat",
    payload: z.object({
      screen: z
        .enum([
          "waiting",
          "lobby",
          "consent",
          "declined",
          "mic_check",
          "demographics",
          "briefing",
          "ready",
          "calibration",
          "game",
          "round_break",
          "paused",
          "end",
          "withdrawn",
        ])
        .describe("Screen now shown"),
    }),
    example: { screen: "consent" },
  }),

  region_hover: defineRecord({
    summary: "The pointer rested on a sub-square of the map (recorded when it leaves).",
    trigger: "Pointer leaves a sub-square after ≥150 ms on it (shorter passes are ignored as noise).",
    actors: ["player"],
    changesState: false,
    visibleTo: "Facilitator (live hover indicator + log)",
    dataClass: "pseudonymous",
    frequency: "tens to hundreds per seat per round",
    payload: z.object({
      regionId: z.string().describe("Hovered sub-square, e.g. 'C7-Kb'"),
      durationMs: Ms("Hover duration"),
    }),
    example: { regionId: "C7-Kb", durationMs: 1840 },
  }),

  region_inspect: defineRecord({
    summary: "The player opened or closed the info panel of a square.",
    trigger: "Player clicks a square (open) or closes/replaces the panel (close).",
    actors: ["player"],
    changesState: false,
    visibleTo: "Facilitator",
    dataClass: "pseudonymous",
    frequency: "tens per seat per round",
    payload: z.object({
      regionId: z.string().describe("Inspected square, e.g. 'C7' (the panel shows all four sub-squares)"),
      action: z.enum(["open", "close"]).describe("Panel opened or closed"),
      durationMs: Ms("How long the panel was open (close only)").nullable(),
    }),
    example: { regionId: "C7", action: "close", durationMs: 5320 },
  }),

  map_view_change: defineRecord({
    summary: "The player panned or zoomed the map.",
    trigger: "Pan/zoom settles (debounced 500 ms) or the player presses 'reset view'.",
    actors: ["player"],
    changesState: false,
    visibleTo: "Facilitator",
    dataClass: "pseudonymous",
    frequency: "0–tens per seat per round",
    payload: z.object({
      x: z.number().describe("viewBox x (map units)"),
      y: z.number().describe("viewBox y (map units)"),
      w: z.number().describe("viewBox width (map units)"),
      h: z.number().describe("viewBox height (map units)"),
      zoom: z.number().describe("Zoom factor relative to the full map (1 = whole map)"),
    }),
    example: { x: 120, y: 80, w: 500, h: 350, zoom: 2 },
  }),

  tool_select: defineRecord({
    summary: "The player selected the propose or decide tool (or deselected).",
    trigger: "Player clicks a tool button or presses its keyboard shortcut.",
    actors: ["player"],
    changesState: false,
    visibleTo: "Facilitator",
    dataClass: "pseudonymous",
    frequency: "tens per seat per round",
    payload: z.object({ tool: ActionKindSchema.nullable().describe("Selected tool (null = none)") }),
    example: { tool: "propose" },
  }),

  action_draft: defineRecord({
    summary: "Confirmation step of a propose/decide: opened, cancelled or confirmed.",
    trigger:
      "Player clicks a square with a tool selected, or a Propose/Decide button in the square panel (opened), then confirms or cancels.",
    actors: ["player"],
    changesState: false,
    visibleTo: "Facilitator",
    dataClass: "pseudonymous",
    frequency: "≥ number of actions",
    payload: z.object({
      kind: ActionKindSchema,
      regionId: z
        .string()
        .describe("Sub-square the drafted action would land on (the one the game rules give this player)"),
      outcome: z
        .enum(["opened", "cancelled", "confirmed"])
        .describe("Confirmation step opened, cancelled, or confirmed (confirmed → intent sent)"),
    }),
    example: { kind: "propose", regionId: "C7-Kb", outcome: "cancelled" },
  }),

  focus_change: defineRecord({
    summary: "The game window gained or lost keyboard focus.",
    trigger: "Browser window focus/blur.",
    actors: ["player"],
    changesState: false,
    visibleTo: "Facilitator (player card shows focus state)",
    dataClass: "pseudonymous",
    frequency: "0–n",
    payload: z.object({ focused: z.boolean().describe("True = window has focus") }),
    example: { focused: false },
  }),

  visibility_change: defineRecord({
    summary: "The game tab became hidden or visible (tab switch, minimise).",
    trigger: "document.visibilitychange.",
    actors: ["player"],
    changesState: false,
    visibleTo: "Facilitator (player card shows visibility)",
    dataClass: "pseudonymous",
    frequency: "0–n",
    payload: z.object({ visible: z.boolean().describe("True = tab is visible") }),
    example: { visible: true },
  }),

  idle: defineRecord({
    summary: "No pointer/keyboard input for 30 s (start), or input resumed (end).",
    trigger: "Inactivity timer on the client.",
    actors: ["player"],
    changesState: false,
    visibleTo: "Facilitator",
    dataClass: "pseudonymous",
    frequency: "0–n",
    payload: z.object({
      state: z.enum(["start", "end"]).describe("Idle period started or ended"),
      durationMs: Ms("Length of the idle period (end only)").nullable(),
    }),
    example: { state: "end", durationMs: 47210 },
  }),

  state_received: defineRecord({
    summary: "Acknowledgement that the client received and rendered a state update.",
    trigger: "Every state push from the server (lets you compute exact 'saw it → acted' reaction times).",
    actors: ["player"],
    changesState: false,
    visibleTo: "Facilitator (not shown in the live log)",
    dataClass: "pseudonymous",
    frequency: "1 per state push (hundreds per seat)",
    payload: z.object({
      seq: z.number().int().min(0).describe("seq of the last event included in the state"),
    }),
    example: { seq: 58 },
  }),

  clock_sync: defineRecord({
    summary: "Result of a clock synchronisation between client and server.",
    trigger: "On connect and every 60 s (5 ping/pong samples, best round trip used).",
    actors: ["player"],
    changesState: false,
    visibleTo: "Facilitator (player card shows latency)",
    dataClass: "non-personal",
    frequency: "~1 per minute per seat",
    payload: z.object({
      offsetMs: z.number().describe("Estimated server clock minus client clock (ms)"),
      rttMs: Ms("Round-trip time of the best sample"),
      samples: z.number().int().min(1).describe("Number of ping/pong samples"),
    }),
    example: { offsetMs: -12.4, rttMs: 3.1, samples: 5 },
  }),

  mic_permission: defineRecord({
    summary:
      "The browser's answer when the game asked for the microphone, or a later change of that permission.",
    trigger:
      "The player's client asks for the microphone (mic check, reload, reconnect, after a loss) and gets an answer, or the permission or device changes during the session (sessions that record audio).",
    actors: ["player"],
    changesState: false,
    visibleTo: "Facilitator (LIVE mic column)",
    dataClass: "pseudonymous",
    frequency: "1–few per seat (audio sessions only)",
    payload: z.object({
      state: z
        .enum(["prompt", "granted", "denied", "error"])
        .describe(
          "'prompt' = the browser is asking the player, 'granted' = microphone available, 'denied' = permission refused, 'error' = no usable microphone (missing, busy, or not a secure page)",
        ),
      errorName: z
        .string()
        .regex(/^[A-Za-z]+$/)
        .max(64)
        .optional()
        .describe(
          "Name of the browser error for 'denied' / 'error', e.g. 'NotAllowedError', 'NotFoundError', 'NotReadableError' (never the device name)",
        ),
    }),
    example: { state: "denied", errorName: "NotAllowedError" },
  }),
} as const;

export type TelemetryDefs = typeof TELEMETRY_DEFS;
export type TelemetryType = keyof TelemetryDefs;
export const TELEMETRY_TYPES = Object.keys(TELEMETRY_DEFS) as TelemetryType[];
export type TelemetryPayloadOf<T extends TelemetryType> = z.infer<TelemetryDefs[T]["payload"]>;

/** One item as sent by the client inside a telemetry batch. */
export const TelemetryItemSchema = z.object({
  type: z.enum(TELEMETRY_TYPES as [TelemetryType, ...TelemetryType[]]),
  clientTs: z.number().describe("Client timestamp corrected to server time (epoch ms)"),
  payload: z.unknown(),
});
export type TelemetryItem = {
  [K in TelemetryType]: { type: K; clientTs: number; payload: TelemetryPayloadOf<K> };
}[TelemetryType];

/** Envelope of a stored telemetry row. */
export const TelemetryEnvelopeSchema = z.object({
  id: z.number().int().describe("Auto-increment row id"),
  sessionId: z.string().describe("Session id"),
  seat: SeatSchema.describe("Seat that produced the telemetry"),
  participantCode: z.string().describe("Pseudonymous participant code of that seat"),
  round: z.number().int().min(0).describe("Round when the batch was received (0 = before round 1)"),
  type: z.enum(TELEMETRY_TYPES as [TelemetryType, ...TelemetryType[]]).describe("Telemetry type"),
  clientTs: z.number().describe("Client timestamp corrected to server time (epoch ms)"),
  clientOffsetMs: z.number().describe("Clock offset applied by the client when correcting clientTs (ms)"),
  serverTs: z.number().describe("Server receive time, epoch ms"),
  serverWall: z.string().describe("Server receive time, ISO-8601 UTC"),
});
export type TelemetryEnvelope = z.infer<typeof TelemetryEnvelopeSchema>;
export type StoredTelemetry = TelemetryEnvelope & { payload: unknown };

export function parseTelemetryItem(item: unknown): TelemetryItem | null {
  const base = TelemetryItemSchema.safeParse(item);
  if (!base.success) return null;
  const def = TELEMETRY_DEFS[base.data.type];
  const payload = def.payload.safeParse(base.data.payload);
  if (!payload.success) return null;
  return { type: base.data.type, clientTs: base.data.clientTs, payload: payload.data } as TelemetryItem;
}

/** Telemetry types relayed live to the facilitator log (state_received/clock_sync are too chatty). */
export const LIVE_TELEMETRY_TYPES: ReadonlySet<TelemetryType> = new Set(
  TELEMETRY_TYPES.filter((t) => t !== "state_received" && t !== "clock_sync"),
);
