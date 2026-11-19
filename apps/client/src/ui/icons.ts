/**
 * Semantic icon table: every concept in the app has exactly ONE Iconoir icon.
 * Components never import iconoir-react directly; they use <Icon name="…"/>.
 * docs/AESTHETIC-RULES.md § Icons is generated from this table.
 */
export const ICON_TABLE = {
  // navigation & structure
  setup: { iconoir: "Settings", meaning: "SETUP tab, configuration" },
  live: { iconoir: "AntennaSignal", meaning: "LIVE tab and indicator, running session" },
  replay: { iconoir: "ClockRotateRight", meaning: "REPLAY tab" },
  database: { iconoir: "Database", meaning: "DATABASE tab, stored sessions" },
  next: { iconoir: "NavArrowRight", meaning: "Next step" },
  back: { iconoir: "NavArrowLeft", meaning: "Previous step" },
  close: { iconoir: "Xmark", meaning: "Close a popup or panel, cancel" },
  help: { iconoir: "HelpCircle", meaning: "Help / keyboard shortcuts" },
  info: { iconoir: "InfoCircle", meaning: "Information callout" },
  // session flow
  scenario: { iconoir: "Map", meaning: "Scenario, map" },
  rounds: { iconoir: "Repeat", meaning: "Rounds, round rules" },
  visibility: { iconoir: "Eye", meaning: "Visibility, what players see, player mirrors" },
  onboarding: { iconoir: "Journal", meaning: "Onboarding, briefing" },
  consent: { iconoir: "ShieldCheck", meaning: "Consent" },
  demographics: { iconoir: "TextBox", meaning: "Demographics questionnaire" },
  tag: { iconoir: "Hashtag", meaning: "Session tags" },
  notes: { iconoir: "EditPencil", meaning: "Notes, facilitator annotations" },
  review: { iconoir: "List", meaning: "Review / summary, event log" },
  create: { iconoir: "Plus", meaning: "Create a new session" },
  start: { iconoir: "Play", meaning: "Start / resume (onboarding, round, replay playback)" },
  pause: { iconoir: "Pause", meaning: "Pause" },
  endRound: { iconoir: "SkipNext", meaning: "End the current round" },
  stop: { iconoir: "Prohibition", meaning: "End game early, abort session" },
  archive: { iconoir: "Archive", meaning: "Close (archive) a session" },
  resumeSession: { iconoir: "SystemRestart", meaning: "Re-attach an unfinished session" },
  // seats & players
  seat: { iconoir: "User", meaning: "A seat / player" },
  seats: { iconoir: "Group", meaning: "All seats" },
  client: { iconoir: "Computer", meaning: "A client: a connected player browser / PC" },
  bind: { iconoir: "UserPlus", meaning: "Bind a client to a seat" },
  withdraw: { iconoir: "UserXmark", meaning: "Withdraw a participant / unbind a seat" },
  agent: { iconoir: "Cpu", meaning: "A simulated player (agent) in a seat" },
  simulation: { iconoir: "Flask", meaning: "Simulated session, simulation database" },
  fake: {
    iconoir: "TestTube",
    meaning: "A fake player: a test client the server created, not a participant",
  },
  labels: { iconoir: "Label", meaning: "K/P labels" },
  randomise: { iconoir: "DiceFive", meaning: "Random draw (a pairing drawn with a logged seed)" },
  connected: { iconoir: "Wifi", meaning: "Connected" },
  disconnected: { iconoir: "WifiOff", meaning: "Disconnected" },
  idle: { iconoir: "Hourglass", meaning: "Idle / waiting" },
  hidden: { iconoir: "EyeClosed", meaning: "Tab hidden / not visible" },
  // map actions
  propose: { iconoir: "MapPin", meaning: "Propose (mark a sub-square, no score change)" },
  decide: { iconoir: "DoubleCheck", meaning: "Decide (fill a sub-square, change scores)" },
  revoke: { iconoir: "Undo", meaning: "Revoke (undo) an action" },
  zoomIn: { iconoir: "Plus", meaning: "Zoom in" },
  zoomOut: { iconoir: "Minus", meaning: "Zoom out" },
  zoomReset: { iconoir: "Expand", meaning: "Reset map view" },
  // communication & monitoring
  broadcast: { iconoir: "Megaphone", meaning: "Broadcast a message to players" },
  timeline: { iconoir: "Timer", meaning: "Timeline, round timer" },
  telemetry: { iconoir: "Activity", meaning: "Live telemetry" },
  clock: { iconoir: "Clock", meaning: "Session clock" },
  // audio (microphone recording, § 8.1)
  microphone: { iconoir: "Microphone", meaning: "Microphone being recorded ([REC]), mic OK" },
  microphoneOff: {
    iconoir: "MicrophoneMute",
    meaning: "Not recording: recording paused, audio off, mic skipped",
  },
  microphoneWarning: {
    iconoir: "MicrophoneWarning",
    meaning: "Microphone problem: no signal, permission denied, error",
  },
  voice: { iconoir: "Voice", meaning: "Mic calibration, a seat's speaking turn" },
  upload: { iconoir: "CloudUpload", meaning: "Audio upload backlog (recorded chunks not yet on the server)" },
  // data
  export: { iconoir: "DatabaseExport", meaning: "Export a session" },
  anonymise: { iconoir: "Fingerprint", meaning: "Anonymised export" },
  print: { iconoir: "Printer", meaning: "Print a page" },
  keysheet: { iconoir: "Key", meaning: "Key sheet (code ↔ handwritten name)" },
  cards: { iconoir: "MultiplePages", meaning: "Takedown cards" },
  erase: { iconoir: "Trash", meaning: "Erase participant data (irreversible)" },
  search: { iconoir: "Search", meaning: "Look up" },
  refresh: { iconoir: "Refresh", meaning: "Reload a list" },
  register: { iconoir: "Reports", meaning: "Erasure / export register" },
  // status & appearance
  ok: { iconoir: "Check", meaning: "Done, valid" },
  done: { iconoir: "CheckCircle", meaning: "Step complete" },
  warning: { iconoir: "WarningTriangle", meaning: "Warning, destructive confirmation" },
  error: { iconoir: "XmarkCircle", meaning: "Error" },
  lock: { iconoir: "Lock", meaning: "Locked (step can no longer be changed)" },
  themeLight: { iconoir: "SunLight", meaning: "Switch to the light theme (Latte)" },
  themeDark: { iconoir: "HalfMoon", meaning: "Switch to the dark theme (Mocha)" },
  themeContrast: { iconoir: "Brightness", meaning: "Switch to the high-contrast theme" },
  display: { iconoir: "Accessibility", meaning: "Display settings: colours, font, text size, animations" },
  font: { iconoir: "Text", meaning: "Font choice" },
  textSize: { iconoir: "TextArrowsUpDown", meaning: "Text size" },
  animations: {
    iconoir: "Sparks",
    meaning: "Toggle animations (CRT-style screen switches, popups, connect/disconnect)",
  },
} as const;

export type IconName = keyof typeof ICON_TABLE;
