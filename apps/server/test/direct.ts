/**
 * A SessionManager on its own encrypted database, driven directly: no hub, no sockets. With the
 * helpers that take its seats through binding, labels, consent, mic check and onboarding.
 */
import path from "node:path";
import { AUDIO_CONSENT_ITEM, type SessionConfigInput, type StoredEvent } from "@wkwa/shared";
import pino from "pino";
import type { AudioFileStore } from "../src/audio/fileStore";
import { loadOnboardingContent, ScenarioLibrary } from "../src/content";
import type { Store } from "../src/db/store";
import { REPO_ROOT } from "../src/runtime";
import { SessionManager } from "../src/session/SessionManager";
import { tempStore } from "./audioFixtures";

export const CONFIG_DIR = path.join(REPO_ROOT, "config");
export const SCENARIOS = new ScenarioLibrary(path.join(REPO_ROOT, "scenarios"));
export const SETTINGS = {
  sampleRate: 48_000,
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 1,
};
export const ROUND = { rule: "quota" as const, quota: { propose: 1, decide: 1 }, timeLimitSec: null };

export interface Direct {
  m: SessionManager;
  store: Store;
  files: AudioFileStore;
  events: StoredEvent[];
  /** The session loaded again from the store, as after a server restart (disposed by close()). */
  reload(): SessionManager;
  close(): void;
}

/** A SessionManager on its own encrypted database, driven directly (no sockets). */
export function direct(
  config: SessionConfigInput = { audio: { enabled: true } },
  opts: { clock?: () => number; sim?: boolean } = {},
): Direct {
  const t = tempStore({ audio: !opts.sim });
  const events: StoredEvent[] = [];
  const audio = config.players !== "simulated" && config.audio?.enabled === true;
  const deps = {
    store: t.store,
    scenario: SCENARIOS.load("demo"),
    onboarding: loadOnboardingContent(CONFIG_DIR, { audio }),
    serverSecret: "test-secret",
    log: pino({ level: "silent" }),
    clock: opts.clock,
  };
  const m = SessionManager.create(
    { ...deps, onEvents: (e) => events.push(...e) },
    { seatCount: 2, roundCount: 1, defaultRound: ROUND, ...config } as never,
    "live audio test",
  );
  const loaded: SessionManager[] = [];
  return {
    m,
    store: t.store,
    files: t.files,
    events,
    reload() {
      const r = SessionManager.load({ ...deps, onEvents: () => {} }, m.sessionId);
      loaded.push(r);
      return r;
    },
    close() {
      for (const r of loaded) r.dispose();
      m.dispose();
      t.close();
    },
  };
}

/** Bind seats (seat n on terminal n; `fake` seats as fake players), assign labels, start onboarding. */
export function onboard(m: SessionManager, fake: number[] = []) {
  for (const s of Object.keys(m.state.seats).map(Number))
    m.bindSeat(s, s, fake.includes(s) ? { fake: true } : {});
  m.randomiseLabels();
  m.startOnboarding();
}

export function consent(m: SessionManager, seat: number, audio = true, all = true) {
  const c = m.onboarding.consent;
  m.submitConsent(seat, {
    formVersion: c.version,
    textSha256: c.sha256,
    answers: Object.fromEntries(c.items.map((i) => [i.id, i.id === AUDIO_CONSENT_ITEM ? audio : all])),
    durationMs: 1000,
    clientTs: Date.now(),
  });
}

export const MIC_OK = {
  passed: true,
  attempts: 1,
  durationMs: 1000,
  settings: SETTINGS,
  noiseFloorDb: -60,
  speechDb: -20,
  speechMs: 1500,
  clientTs: 0,
};

export function finishOnboarding(m: SessionManager, seat: number) {
  const o = m.onboarding;
  m.submitDemographics(seat, {
    formVersion: o.demographics.version,
    answers: Object.fromEntries(o.demographics.questions.map((q) => [q.id, q.options[0]!.value])),
    durationMs: 1,
    clientTs: 0,
  });
  m.acknowledgeBriefing(seat, { textSha256: o.briefing.sha256, durationMs: 1, clientTs: 0 });
}
