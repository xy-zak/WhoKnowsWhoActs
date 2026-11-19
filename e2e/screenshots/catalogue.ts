/**
 * The screenshot catalogue: every documentation screenshot, the gallery group
 * it belongs to, its title, its layout in the gallery, the scenario that takes
 * it and the source files that change it.
 *
 * - The version history (files, dates, commits, captions) is in
 *   docs/img/screenshots.json; `npm run screenshots -- publish` writes it.
 * - The gallery docs/img/SCREENSHOTS.md is generated from both.
 *
 * Add a shot: an entry here, plus a shot()/crop() call in e2e/screenshots.spec.ts
 * inside the scenario named by `scenario`. Then `npm run screenshots -- capture <id>`
 * and `npm run screenshots -- publish <id> --caption "…"`.
 * The workflow is in .claude/skills/screenshot-app/SKILL.md.
 */

export type Side = "server" | "client";
/** Gallery layout: full = on its own (700 px wide), half = in pairs (340 px), small = in pairs (320 px). */
export type Size = "full" | "half" | "small";
/** A scenario is one session played through the UI by e2e/screenshots.spec.ts. */
export type ScenarioName = "session" | "small-grid" | "simulation" | "audio-edge" | "audio-data";

export interface GroupDef {
  readonly id: string;
  readonly title: string;
  /** One or two sentences under the group heading. */
  readonly intro: string;
  /** Files (globs) whose changes can show in every shot of the group. */
  readonly sources: readonly string[];
}

export interface ShotDef {
  /** `<side>/<name>`: the image is docs/img/<side>/<name>.png (v1), <name>-v2.png, … */
  readonly id: `${Side}/${string}`;
  readonly group: string;
  /** Optional sub-heading inside the group; shots of one subgroup are listed together. */
  readonly subgroup?: string;
  readonly title: string;
  readonly size: Size;
  /** Display width in px, instead of the size's default. */
  readonly width?: number;
  /** The scenario that takes it (default "session"). */
  readonly scenario?: ScenarioName;
  /** Extra files (globs) that change this shot, on top of its group's. */
  readonly sources?: readonly string[];
}

const C = "apps/client/src";

export const GROUPS = [
  {
    id: "setup",
    title: "Setting up a session",
    intro:
      "Facilitator, SETUP tab: an eleven-step wizard. Steps 01–07 configure and create the session, 08–11 prepare the room (step 08 is in § 2).",
    sources: [`${C}/facilitator/setup/**`, "packages/shared/src/config.ts"],
  },
  {
    id: "connect",
    title: "Connecting the player PCs",
    intro:
      "Each player PC opens the game page and shows a client number; the facilitator binds every client to a seat in step 08.",
    sources: [`${C}/facilitator/seats.tsx`, `${C}/facilitator/setup/**`, `${C}/player/App.tsx`],
  },
  {
    id: "onboarding",
    title: "Onboarding",
    intro:
      "Players go through consent (one section at a time, each confirmed by its own box) → about you → briefing; the facilitator sees which step each seat is on.",
    sources: [`${C}/player/Onboarding.tsx`, `${C}/player/chrome.tsx`, "config/**"],
  },
  {
    id: "map",
    title: "Reading the map",
    intro:
      "Every player sees the same grid but only the scores of their own knowledge type. Each square has four sub-squares: Ka top left, Kb top right, Kc bottom left, Kd bottom right.",
    sources: [
      `${C}/map/**`,
      `${C}/player/Game.tsx`,
      "packages/shared/src/game/**",
      "packages/shared/src/board.ts",
      "packages/shared/src/projections.ts",
      "scenarios/**",
    ],
  },
  {
    id: "actions",
    title: "Proposing and deciding",
    intro:
      "A player acts on the sub-square of their power type (here Pd → Kd) in the square they pick. Every action is confirmed first.",
    sources: [`${C}/map/**`, `${C}/player/Game.tsx`, "packages/shared/src/game/**"],
  },
  {
    id: "following",
    title: "Following the round",
    intro: "Facilitator, LIVE tab: the whole session on one page.",
    sources: [
      `${C}/facilitator/live/**`,
      `${C}/facilitator/Composite.tsx`,
      `${C}/facilitator/seats.tsx`,
      `${C}/facilitator/App.tsx`,
      `${C}/map/**`,
    ],
  },
  {
    id: "timeline",
    title: "Timeline, event log and telemetry",
    intro: "What happened when: every action, pause and note, as it is recorded.",
    sources: [`${C}/facilitator/Timeline.tsx`, `${C}/facilitator/EventLog.tsx`],
  },
  {
    id: "steering",
    title: "Steering the session",
    intro: "The facilitator's tools, and what the players see when they are used.",
    sources: [`${C}/facilitator/live/**`, `${C}/facilitator/seats.tsx`, `${C}/player/Game.tsx`],
  },
  {
    id: "wrap-up",
    title: "End of the game and wrap-up",
    intro: "Players see their participant code; the facilitator wraps up in three steps.",
    sources: [`${C}/facilitator/live/**`, `${C}/player/App.tsx`],
  },
  {
    id: "data",
    title: "Stored sessions and replay",
    intro: "Facilitator, DATABASE and REPLAY tabs.",
    sources: [`${C}/facilitator/Database.tsx`, `${C}/facilitator/Replay.tsx`],
  },
  {
    id: "testing",
    title: "Testing without participants",
    intro:
      "Fake players are test clients the server creates; simulated players are agents that play every seat.",
    sources: [`${C}/facilitator/seats.tsx`, `${C}/facilitator/setup/**`, "packages/shared/src/simulation/**"],
  },
  {
    id: "small-map",
    title: "The 5 × 5 map",
    intro: "The small demo grid: 25 squares, 100 sub-squares.",
    sources: ["scenarios/demo-small/**", `${C}/map/**`],
  },
  {
    id: "audio",
    title: "Recording audio",
    intro:
      "Optional microphone recording (setup step 05, \"Record audio\"): each player's own mic check, the facilitator-led calibration, the recording indicator, and the facilitator's controls and audio tools.",
    sources: [
      `${C}/audio/**`,
      `${C}/player/MicCheckScreen.tsx`,
      `${C}/player/CalibrationScreen.tsx`,
      `${C}/player/RecordingIndicator.tsx`,
      `${C}/facilitator/live/Audio*.tsx`,
      `${C}/facilitator/database/**`,
      `${C}/ui/audio.tsx`,
    ],
  },
  {
    id: "display",
    title: "Display and accessibility",
    intro:
      "Every screen picks its own colours, font, text size and animations; the choice is never recorded.",
    sources: [
      `${C}/ui/prefs.ts`,
      `${C}/ui/DisplaySettings.tsx`,
      `${C}/ui/tokens.ts`,
      `${C}/player/DisplayMenu.tsx`,
      `${C}/ui/shortcuts.ts`,
    ],
  },
] as const satisfies readonly GroupDef[];

export type GroupId = (typeof GROUPS)[number]["id"];

export const SHOTS = [
  // 1. setup
  { id: "server/setup-scenario", group: "setup", title: "Setup · Scenario", size: "half" },
  { id: "server/setup-rounds", group: "setup", title: "Setup · Rounds", size: "half" },
  { id: "server/setup-who", group: "setup", title: "Setup · Who plays", size: "half" },
  { id: "server/setup-onboarding", group: "setup", title: "Setup · Onboarding", size: "half" },
  { id: "server/setup-tags", group: "setup", title: "Setup · Tags", size: "half" },
  { id: "server/setup-create", group: "setup", title: "Setup · Create session", size: "half" },
  { id: "server/setup-labels", group: "setup", title: "Setup · Labels", size: "half" },
  { id: "server/setup-keysheet", group: "setup", title: "Setup · Key sheet", size: "half" },
  { id: "server/setup-start", group: "setup", title: "Setup · Start", size: "half" },

  // 2. connect
  { id: "client/01-waiting-for-seat", group: "connect", title: "Waiting for a seat", size: "half" },
  { id: "server/setup-connect", group: "connect", title: "Setup · Connect", size: "half" },
  { id: "server/setup-connect-bound", group: "connect", title: "Setup · All seats bound", size: "half" },
  { id: "client/02-seat-assigned", group: "connect", title: "Seat assigned", size: "half" },

  // 3. onboarding
  { id: "client/03-consent", group: "onboarding", title: "Consent", size: "half" },
  { id: "client/04-about-you", group: "onboarding", title: "About you", size: "half" },
  { id: "client/05-briefing", group: "onboarding", title: "Briefing", size: "half" },
  { id: "client/06-ready", group: "onboarding", title: "Ready", size: "half" },
  {
    id: "server/live-01-onboarding",
    group: "onboarding",
    title: "LIVE during onboarding",
    size: "half",
    sources: [`${C}/facilitator/live/**`],
  },
  {
    id: "server/live-panel-seats-onboarding",
    group: "onboarding",
    title: "Seats panel",
    size: "full",
    sources: [`${C}/facilitator/seats.tsx`],
  },
  {
    id: "server/live-panel-next-ready",
    group: "onboarding",
    title: "NEXT panel",
    size: "full",
    sources: [`${C}/facilitator/live/**`],
  },

  // 4. map
  { id: "client/07-game-round-start", group: "map", title: "Start of round 1", size: "half" },
  { id: "client/08-game-square-selected", group: "map", title: "Square selected", size: "half" },
  { id: "client/part-status-line", group: "map", title: "Status line", size: "full" },
  { id: "client/part-map-detail", group: "map", title: "Map close-up", size: "small" },
  { id: "client/part-square-panel", group: "map", title: "Square panel", size: "small" },
  {
    id: "client/part-map-tooltip",
    group: "map",
    title: "Hover info",
    size: "small",
    sources: [`${C}/ui/Tooltip.tsx`],
  },

  // 5. actions
  { id: "client/part-tool-bar", group: "actions", title: "Tools", size: "full" },
  { id: "client/10-game-propose-tool", group: "actions", title: "Propose tool", size: "half" },
  { id: "client/09-game-confirm", group: "actions", title: "Confirmation", size: "half" },
  { id: "client/part-confirm-prompt", group: "actions", title: "Confirm or cancel", size: "small" },
  { id: "client/11-game-marks", group: "actions", title: "Marks on the map", size: "half" },

  // 6. following
  { id: "server/live-02-round", group: "following", title: "LIVE during round 1", size: "full" },
  { id: "server/live-panel-session", group: "following", title: "Session panel", size: "full" },
  { id: "server/live-panel-next", group: "following", title: "NEXT panel", size: "full" },
  { id: "server/live-panel-seats", group: "following", title: "Seats panel", size: "full" },
  { id: "server/live-panel-composite-map", group: "following", title: "Composite map", size: "full" },
  {
    id: "server/live-panel-square",
    group: "following",
    title: "Square comparison",
    size: "small",
    width: 300,
  },
  {
    id: "server/live-panel-player-views",
    group: "following",
    title: "Player views",
    size: "half",
    width: 360,
  },

  // 7. timeline
  { id: "server/live-panel-timeline", group: "timeline", title: "Timeline", size: "full" },
  {
    id: "server/live-panel-timeline-tooltip",
    group: "timeline",
    title: "Timeline hover info",
    size: "full",
    sources: [`${C}/ui/Tooltip.tsx`],
  },
  { id: "server/live-panel-event-log", group: "timeline", title: "Event log", size: "half" },
  { id: "server/live-panel-telemetry", group: "timeline", title: "Live telemetry", size: "half" },

  // 8. steering
  {
    id: "server/live-panel-tools",
    group: "steering",
    subgroup: "Messages and notes",
    title: "TOOLS panel",
    size: "half",
  },
  {
    id: "client/part-other-players-and-messages",
    group: "steering",
    subgroup: "Messages and notes",
    title: "Messages",
    size: "small",
  },
  { id: "server/live-03-paused", group: "steering", subgroup: "Pausing", title: "Paused", size: "half" },
  { id: "client/12-game-paused", group: "steering", subgroup: "Pausing", title: "Game paused", size: "half" },
  {
    id: "server/live-popup-revoke",
    group: "steering",
    subgroup: "Corrections",
    title: "Revoke",
    size: "half",
    sources: [`${C}/facilitator/EventLog.tsx`, `${C}/ui/Popup.tsx`],
  },
  {
    id: "server/live-popup-edit-labels",
    group: "steering",
    subgroup: "Corrections",
    title: "Edit labels",
    size: "half",
  },
  {
    id: "server/live-popup-end-round",
    group: "steering",
    subgroup: "Ending rounds and the game",
    title: "End round now",
    size: "half",
    sources: [`${C}/ui/Popup.tsx`],
  },
  {
    id: "server/live-popup-end-game",
    group: "steering",
    subgroup: "Ending rounds and the game",
    title: "End game early",
    size: "half",
    scenario: "small-grid",
    sources: [`${C}/ui/Popup.tsx`],
  },
  {
    id: "server/live-04-round-complete",
    group: "steering",
    subgroup: "Ending rounds and the game",
    title: "Between rounds",
    size: "half",
  },
  {
    id: "client/13-round-complete",
    group: "steering",
    subgroup: "Ending rounds and the game",
    title: "Round complete",
    size: "half",
  },

  // 9. wrap-up
  { id: "server/live-05-game-complete", group: "wrap-up", title: "Game complete", size: "half" },
  { id: "client/14-session-complete", group: "wrap-up", title: "Session complete", size: "half" },
  {
    id: "server/wrap-up-01-takedown-cards",
    group: "wrap-up",
    title: "Wrap-up 1 · Takedown cards",
    size: "half",
  },
  { id: "server/wrap-up-02-export", group: "wrap-up", title: "Wrap-up 2 · Export", size: "half" },
  { id: "server/wrap-up-03-close", group: "wrap-up", title: "Wrap-up 3 · Close", size: "half" },

  // 10. data
  { id: "server/database-01-participants", group: "data", title: "DATABASE · Participants", size: "half" },
  {
    id: "server/database-03-simulations",
    group: "data",
    title: "DATABASE · Simulations",
    size: "half",
    scenario: "simulation",
  },
  { id: "server/replay-01-choose", group: "data", title: "REPLAY · Choose a session", size: "half" },
  {
    id: "server/replay-02-session",
    group: "data",
    title: "REPLAY · A session",
    size: "half",
    sources: [`${C}/facilitator/Timeline.tsx`, `${C}/facilitator/Composite.tsx`],
  },
  {
    id: "server/database-02-erasure-lookup",
    group: "data",
    title: "Erasure lookup",
    size: "full",
    width: 560,
  },

  // audio
  {
    id: "client/audio-01-mic-check-held",
    group: "audio",
    subgroup: "Player: mic check",
    title: "Mic check held until everyone finished the briefing",
    size: "half",
  },
  {
    id: "client/audio-02-mic-check-ready",
    group: "audio",
    subgroup: "Player: mic check",
    title: "Mic check ready",
    size: "half",
  },
  {
    id: "client/audio-03-mic-check-listening",
    group: "audio",
    subgroup: "Player: mic check",
    title: "Mic check listening",
    size: "half",
  },
  {
    id: "client/audio-04-mic-check-passed",
    group: "audio",
    subgroup: "Player: mic check",
    title: "Mic check passed",
    size: "half",
  },
  {
    id: "client/audio-05-mic-denied",
    group: "audio",
    subgroup: "Player: mic check",
    title: "Microphone blocked",
    size: "half",
    scenario: "audio-edge",
  },
  {
    id: "client/audio-06-calibration-waiting",
    group: "audio",
    subgroup: "Player: calibration",
    title: "Calibration: ready? (part 2)",
    size: "half",
  },
  {
    id: "client/audio-07-calibration-turn",
    group: "audio",
    subgroup: "Player: calibration",
    title: "Calibration: your turn",
    size: "half",
  },
  {
    id: "client/audio-08-calibration-quiet",
    group: "audio",
    subgroup: "Player: calibration",
    title: "Calibration: stay quiet",
    size: "half",
  },
  {
    id: "client/audio-09-game-paused-recording",
    group: "audio",
    subgroup: "Player: in the game",
    title: "Game with recording paused",
    size: "half",
  },
  {
    id: "client/audio-10-game-mic-error",
    group: "audio",
    subgroup: "Player: in the game",
    title: "Game with a microphone error",
    size: "half",
    scenario: "audio-edge",
  },
  {
    id: "server/audio-next-held",
    group: "audio",
    subgroup: "Facilitator: onboarding",
    title: "NEXT: mic checks held",
    size: "full",
  },
  {
    id: "server/audio-next-calibration-running",
    group: "audio",
    subgroup: "Facilitator: onboarding",
    title: "NEXT: calibration running",
    size: "full",
  },
  {
    id: "server/audio-next-calibration-done",
    group: "audio",
    subgroup: "Facilitator: onboarding",
    title: "NEXT: calibration done",
    size: "full",
  },
  {
    id: "server/audio-calibration-card",
    group: "audio",
    subgroup: "Facilitator: LIVE",
    title: "Calibration quality",
    size: "full",
  },
  {
    id: "server/audio-event-log",
    group: "audio",
    subgroup: "Facilitator: LIVE",
    title: "Event log: the calibration",
    size: "half",
    sources: [`${C}/facilitator/EventLog.tsx`, `${C}/facilitator/audioLive.ts`],
  },
  {
    id: "server/audio-status-bar",
    group: "audio",
    subgroup: "Facilitator: LIVE",
    title: "Status bar with mics n/m",
    size: "full",
  },
  {
    id: "server/audio-popup-pause-recording",
    group: "audio",
    subgroup: "Facilitator: LIVE",
    title: "Pause recording for everyone",
    size: "half",
  },
  {
    id: "server/audio-tools-paused",
    group: "audio",
    subgroup: "Facilitator: LIVE",
    title: "TOOLS with recording paused",
    size: "full",
  },
  {
    id: "server/audio-popup-skip-mic-check",
    group: "audio",
    subgroup: "Facilitator: LIVE",
    title: "Skip a seat's mic check",
    size: "half",
    scenario: "audio-edge",
  },
  {
    id: "server/audio-live-mic-error",
    group: "audio",
    subgroup: "Facilitator: LIVE",
    title: "LIVE with a microphone problem",
    size: "half",
    scenario: "audio-edge",
  },
  {
    id: "server/audio-db-01-list",
    group: "audio",
    subgroup: "Facilitator: DATABASE",
    title: "DATABASE: sessions with the Audio column",
    size: "half",
    scenario: "audio-data",
  },
  {
    id: "server/audio-db-02-popup",
    group: "audio",
    subgroup: "Facilitator: DATABASE",
    title: "Audio popup",
    size: "half",
    scenario: "audio-data",
  },
  {
    id: "server/audio-db-03-attribution",
    group: "audio",
    subgroup: "Facilitator: DATABASE",
    title: "Speaker attribution result",
    size: "half",
    scenario: "audio-data",
  },
  {
    id: "server/audio-db-04-export",
    group: "audio",
    subgroup: "Facilitator: DATABASE",
    title: "Export audio result",
    size: "half",
    scenario: "audio-data",
  },
  {
    id: "server/audio-db-05-delete",
    group: "audio",
    subgroup: "Facilitator: DATABASE",
    title: "Delete audio: type the session id",
    size: "half",
    scenario: "audio-data",
  },

  // 11. testing
  {
    id: "server/setup-connect-fake-players",
    group: "testing",
    title: "Fake players",
    size: "half",
    scenario: "small-grid",
  },
  {
    id: "server/setup-who-simulated",
    group: "testing",
    title: "Simulated players · Setup",
    size: "half",
  },
  {
    id: "server/simulation-01-agents",
    group: "testing",
    title: "Simulated players · Agents",
    size: "half",
    scenario: "simulation",
  },
  {
    id: "server/simulation-02-live",
    group: "testing",
    title: "Simulated players · LIVE",
    size: "half",
    scenario: "simulation",
    sources: [`${C}/facilitator/live/**`],
  },

  // 12. small map
  {
    id: "server/setup-scenario-small-grid",
    group: "small-map",
    title: "Setup · Small grid",
    size: "half",
    scenario: "small-grid",
    sources: [`${C}/facilitator/setup/**`],
  },
  {
    id: "server/live-small-grid",
    group: "small-map",
    title: "LIVE on the small grid",
    size: "half",
    scenario: "small-grid",
    sources: [`${C}/facilitator/live/**`, `${C}/facilitator/Composite.tsx`],
  },
  {
    id: "client/game-small-grid",
    group: "small-map",
    title: "Game on the small grid",
    size: "half",
    scenario: "small-grid",
    sources: [`${C}/player/Game.tsx`],
  },

  // 13. display
  { id: "server/theme-mocha", group: "display", title: "Mocha", size: "half" },
  { id: "server/theme-high-contrast", group: "display", title: "High contrast", size: "half" },
  { id: "client/theme-mocha", group: "display", title: "Mocha", size: "half" },
  { id: "client/theme-high-contrast", group: "display", title: "High contrast", size: "half" },
  {
    id: "client/display-dyslexic-large",
    group: "display",
    title: "OpenDyslexic, large text",
    size: "half",
    sources: [`${C}/player/Game.tsx`],
  },
  {
    id: "server/popup-display-settings",
    group: "display",
    title: "Display settings",
    size: "half",
    sources: [`${C}/facilitator/App.tsx`],
  },
  { id: "client/part-display-panel", group: "display", title: "DISPLAY panel", size: "small", width: 300 },
  {
    id: "server/popup-keyboard-shortcuts",
    group: "display",
    title: "Keyboard shortcuts",
    size: "half",
    sources: [`${C}/facilitator/App.tsx`],
  },
] as const satisfies readonly ShotDef[];

export type ShotId = (typeof SHOTS)[number]["id"];

/**
 * Files used by almost every screen (theme, shared components, icons). A change
 * here is not mapped to single shots; `plan` asks for the REPRESENTATIVE ones.
 */
export const GLOBAL_SOURCES = [
  `${C}/ui/theme.css`,
  `${C}/ui/crt.css`,
  `${C}/ui/components.tsx`,
  `${C}/ui/icons.ts`,
  `${C}/ui/Icon.tsx`,
  `${C}/ui/index.ts`,
  "apps/client/*.html",
] as const;

/** Shots that together show most of the shared UI: captured when a GLOBAL_SOURCES file changes. */
export const REPRESENTATIVE: readonly ShotId[] = [
  "server/setup-scenario",
  "server/live-02-round",
  "server/theme-mocha",
  "client/03-consent",
  "client/11-game-marks",
  "client/theme-high-contrast",
];

/** Files that can change what the UI shows; `plan` ignores everything else. */
export const UI_PATHS = ["apps/client/**", "packages/shared/src/**", "config/**", "scenarios/**"] as const;

/* ─────────────────────────── helpers ─────────────────────────── */

export const allShots: readonly ShotDef[] = SHOTS;
export const allGroups: readonly GroupDef[] = GROUPS;

export const shotById = (id: string): ShotDef | undefined => allShots.find((s) => s.id === id);
export const groupById = (id: string): GroupDef | undefined => allGroups.find((g) => g.id === id);
export const sideOf = (id: string): Side => (id.startsWith("client/") ? "client" : "server");
export const scenarioOf = (s: ShotDef): ScenarioName => s.scenario ?? "session";
/** Every source glob of a shot: its own plus its group's. */
export const sourcesOf = (s: ShotDef): readonly string[] => [
  ...(s.sources ?? []),
  ...(groupById(s.group)?.sources ?? []),
];

/** Glob → RegExp: `**` any path, `*` any characters except `/`. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
    } else if (ch === "*") re += "[^/]*";
    else re += ch.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}
export const matchesAny = (file: string, globs: readonly string[]) =>
  globs.some((g) => globToRegExp(g).test(file));
