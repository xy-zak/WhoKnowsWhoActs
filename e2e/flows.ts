import { type Browser, type BrowserContextOptions, expect, type Locator, type Page } from "@playwright/test";
import { Bot } from "../apps/server/src/tools/botClient";

export type { Bot };

/**
 * Steps through the real UI, shared by the e2e specs and the screenshot scenarios: the
 * facilitator's setup walk, player PCs, onboarding, propose/decide, wrap-up. Specs call these
 * instead of writing locators, so a UI change is fixed here once.
 *
 * The setup walk (`setupSession`) is driven by the expanded step's `data-step` key: each key
 * has a handler below, and a step without one is passed with its primary button. Adding a
 * setup step with defaults needs no change here; a step with inputs needs one handler.
 */

export const BASE = `http://127.0.0.1:${process.env.E2E_PORT ?? "3999"}`;

/* ─────────────────────────── page helpers ─────────────────────────── */

/** A panel by its title (the label on its top border). */
export const panel = (page: Page, title: string): Locator =>
  page
    .locator(
      `xpath=//section[contains(concat(' ', @class, ' '), ' panel ')][span[contains(@class, 'panel-title')][contains(., ${JSON.stringify(title)})]]`,
    )
    .first();

/** Move keyboard focus off any field or button, so single-key shortcuts work and no focus ring shows. */
export const blur = (page: Page) =>
  page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

/** The footer of the open popup (its Next / Cancel / Confirm buttons). */
export const popupFoot = (page: Page) => page.locator(".popup-foot");

/** A participant code on screen (game complete). */
export const PARTICIPANT_CODE = /WK-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]/;

/* ─────────────────────────── facilitator: setup walk ─────────────────────────── */

/** The expanded setup step. */
export const currentStep = (fac: Page) => fac.locator(".acc-step.current");

/** The primary button (Next / Create session / Start …) of the expanded setup step. */
export const next = (fac: Page) => currentStep(fac).locator(".acc-foot .btn-primary");

/** Wait until setup step `key` is the expanded one. */
export const current = (fac: Page, key: string) =>
  expect(fac.locator(`.acc-step.current[data-step="${key}"]`)).toBeVisible();

export interface Rounds {
  rounds: number;
  propose: number;
  decide: number;
  timeLimitSec?: number;
}

export interface SessionPlan {
  /** Start of the scenario's name (default "Demo grid"). */
  scenario?: string;
  /** Default: one round, one proposal and one decision per player. */
  rounds?: Rounds;
  /** Simulated players (agents): pace and seed; no clients, onboarding or key sheet. */
  simulated?: { pace?: "watchable" | "quick"; seed?: string };
  /** Record audio (consent, mic checks, calibration). */
  audio?: boolean;
  tags?: string;
  notes?: string;
  /** Seat the players (bind clients, fake players); the step's primary is then pressed. */
  connect?: (fac: Page) => Promise<void>;
  /** K–P labels (default aligned: repeatable). */
  labels?: "aligned" | "shuffle" | { dissociated: number };
  /**
   * Called on every step once it is filled, before its primary button: extra actions or
   * screenshots of a step. Return "stop" to leave the walk on that step.
   */
  onStep?: (key: string, fac: Page) => Promise<unknown>;
}

type StepHandler = (fac: Page, plan: SessionPlan, step: Locator) => Promise<void>;

/** What to fill in per setup step (`data-step`); a step without a handler keeps its defaults. */
const STEP_HANDLERS: Record<string, StepHandler> = {
  scenario: async (_fac, plan, step) => {
    await step.getByRole("radio", { name: new RegExp(`^${plan.scenario ?? "Demo grid"}`) }).check();
  },
  rounds: async (_fac, plan, step) => {
    const r = plan.rounds ?? { rounds: 1, propose: 1, decide: 1 };
    await step.getByRole("spinbutton", { name: "Number of rounds" }).fill(String(r.rounds));
    await step.getByRole("spinbutton", { name: "Proposals per player" }).fill(String(r.propose));
    await step.getByRole("spinbutton", { name: "Decisions per player" }).fill(String(r.decide));
    if (r.timeLimitSec)
      await step.getByRole("spinbutton", { name: "Time limit (seconds)" }).fill(String(r.timeLimitSec));
  },
  players: async (_fac, plan, step) => {
    if (!plan.simulated) return;
    await step.getByRole("radio", { name: "Simulated players" }).check();
    if (plan.simulated.pace)
      await step.getByRole("combobox").filter({ hasText: "Watchable" }).selectOption(plan.simulated.pace);
    if (plan.simulated.seed) await step.getByPlaceholder("random", { exact: true }).fill(plan.simulated.seed);
  },
  onboarding: async (_fac, plan, step) => {
    if (plan.audio) await step.getByRole("checkbox", { name: /Record audio/ }).check();
  },
  tags: async (_fac, plan, step) => {
    if (plan.tags) await step.getByRole("textbox", { name: "Tags" }).fill(plan.tags);
    if (plan.notes) await step.getByRole("textbox", { name: "Notes" }).fill(plan.notes);
  },
  connect: async (fac, plan) => {
    if (!plan.simulated) await plan.connect?.(fac);
  },
  labels: async (_fac, plan, step) => {
    const labels = plan.labels ?? "aligned";
    if (labels === "shuffle") await step.getByRole("button", { name: /Shuffle K across seats/ }).click();
    else {
      if (labels === "aligned") await step.getByRole("radio", { name: /Aligned/ }).check();
      else {
        await step.getByRole("radio", { name: /Dissociated/ }).check();
        await step
          .getByRole("combobox", { name: "Dissociative pairing" })
          .selectOption(String(labels.dissociated));
      }
      await step.getByRole("button", { name: /Save labels/ }).click();
    }
  },
  keysheet: async (_fac, _plan, step) => {
    const printed = step.getByRole("checkbox", { name: /key sheet is printed/ });
    if (await printed.count()) await printed.check();
  },
};

/** The expanded step's key, or "live" once the setup is done (null while neither shows). */
const stepOrLive = (fac: Page) =>
  fac.evaluate(() =>
    document.querySelector(".live-indicator")
      ? "live"
      : (document.querySelector(".acc-step.current")?.getAttribute("data-step") ?? null),
  );

/**
 * The facilitator's whole setup, from /facilitator to LIVE (or to the step where `onStep`
 * returns "stop"), step by step as the UI presents them.
 */
export async function setupSession(fac: Page, plan: SessionPlan = {}) {
  await fac.goto("/facilitator");
  let key: string | null = null;
  await expect.poll(async () => (key = await stepOrLive(fac)), { timeout: 15_000 }).not.toBeNull();
  if (key === "live") throw new Error("setupSession: a session is still live (did an earlier test fail?)");
  for (let guard = 0; key !== "live"; guard++) {
    if (guard > 20) throw new Error("setupSession: the setup did not reach LIVE");
    const from: string = key!;
    const step = currentStep(fac);
    await STEP_HANDLERS[from]?.(fac, plan, step);
    if ((await plan.onStep?.(from, fac)) === "stop") return;
    await expect(next(fac)).toBeEnabled();
    await next(fac).click();
    await expect.poll(async () => (key = await stepOrLive(fac)), { timeout: 15_000 }).not.toBe(from);
  }
}

/** Step "connect": bind a player PC (by its client number) to a seat; waits until it shows the seat. */
export async function bind(fac: Page, seat: number, player: Player | number) {
  const terminal = typeof player === "number" ? player : player.terminal;
  await fac
    .getByRole("combobox", { name: `Bind a client to seat ${seat}` })
    .selectOption({ label: `Client ${terminal}` });
  if (typeof player !== "number") await expect(player.page.getByText(`Seat ${seat}`)).toBeVisible();
}

/** Step "connect": the server's fake players take every empty seat. */
export async function fillWithFakePlayers(fac: Page, pace: "fast" | "normal" = "fast") {
  await fac.getByRole("combobox", { name: "Fake player pace" }).selectOption(pace);
  await fac.getByRole("button", { name: /Fill empty seats with fake players/ }).click();
}

/**
 * Step "connect": socket bots (apps/server/src/tools/botClient.ts) on the given seats. They go
 * through onboarding and play by themselves, over the same protocol as a browser.
 */
export async function bindBots(fac: Page, seats: number[]): Promise<Bot[]> {
  const bots = seats.map((s) => new Bot({ url: BASE, name: `bot${s}`, minDelayMs: 50, maxDelayMs: 200 }));
  const terminals = await Promise.all(bots.map((b) => b.waitForTerminal(15_000)));
  for (const [i, seat] of seats.entries()) await bind(fac, seat, terminals[i]!);
  return bots;
}

/* ─────────────────────────── players ─────────────────────────── */

export interface Player {
  page: Page;
  terminal: number;
}

export interface PlayerOpts {
  /** Browser context options (default: a laptop-sized window). */
  context?: BrowserContextOptions;
  /** Prepare the page before it opens the app (init scripts). */
  prepare?: (page: Page) => Promise<void>;
}

/** A player PC: its own browser context, on the app, waiting for a seat. */
export async function newPlayer(browser: Browser, o: PlayerOpts = {}): Promise<Player> {
  const ctx = await browser.newContext(o.context ?? { viewport: { width: 1300, height: 850 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("player page error:", e.message));
  await o.prepare?.(page);
  return openPlayer(page);
}

/** Open the player app on `page` and wait for its client number. */
export async function openPlayer(page: Page): Promise<Player> {
  await page.goto("/");
  await expect(page.getByText("Waiting for the facilitator to assign a seat")).toBeVisible();
  return { page, terminal: Number(await page.locator(".client-number").textContent()) };
}

/** The title of the player's onboarding screen ("Mic check", "About you", …). */
const screenTitle = (page: Page, title: string | RegExp) => page.locator(".panel-title", { hasText: title });

/** Consent, ticking every item (in a session that records audio, also the audio item). */
export async function consent(page: Page) {
  await expect(page.getByText("Information and consent").first()).toBeVisible({ timeout: 20_000 });
  for (const cb of await page.locator("input[type=checkbox]").all()) await cb.check();
  await page.getByRole("button", { name: /I agree/ }).click();
  await expect(screenTitle(page, /About you|Mic check/)).toBeVisible();
}

/** The mic check's panel title (sessions that record audio). */
export const onMicCheck = (page: Page) => screenTitle(page, "Mic check");

/**
 * Sessions that record audio: the player's own mic check, the real way. Waits while it is held
 * (another seat still in consent), clicks Start (Playwright's Chromium has a fake microphone that
 * plays a synthetic voice: playwright.config.ts, e2e/fakeVoice.ts) and waits until it passes and
 * the player has moved on.
 */
export async function micCheck(page: Page) {
  await expect(onMicCheck(page)).toBeVisible();
  const start = page.getByRole("button", { name: /Start mic check/ });
  await expect(start).toBeVisible({ timeout: 60_000 }); // shown once the consent hold is lifted
  await start.click();
  await expect(page.getByText("Mic check passed")).toBeVisible({ timeout: 30_000 });
  await expect(onMicCheck(page)).toHaveCount(0, { timeout: 10_000 });
}

export async function aboutYou(page: Page) {
  for (const fs of await page.locator("fieldset").all())
    await fs.locator("input[type=radio]").first().check();
  await page.getByRole("button", { name: /Continue/ }).click();
  await expect(screenTitle(page, "Briefing")).toBeVisible();
}

export async function briefing(page: Page) {
  await page.getByRole("button", { name: /I'm ready/ }).click();
  await expect(page.getByText("You're all set")).toBeVisible();
}

/** Consent → (mic check, in a session that records audio) → about you → briefing. */
export async function onboard(page: Page) {
  await consent(page);
  if (await onMicCheck(page).count()) await micCheck(page);
  await expect(screenTitle(page, "About you")).toBeVisible();
  await aboutYou(page);
  await briefing(page);
}

/**
 * NEXT panel (sessions that record audio): start the calibration and wait until every seat had its
 * turn. `players` (in seat order) are checked to show "Your turn" in turn; each turn takes ~7 s.
 */
export async function calibrate(fac: Page, players: Page[] = []) {
  await fac.getByRole("button", { name: "Start calibration" }).click();
  for (const p of players)
    await expect(p.getByText("Your turn: read this sentence aloud")).toBeVisible({ timeout: 60_000 });
  await expect(fac.getByText(/done · (separation ok|weak separation|checking)/)).toBeVisible({
    timeout: 60_000,
  });
}

/** NEXT panel: open "Skip mic check" for a seat and give a reason (the popup is left open). */
export async function openSkipMicCheck(fac: Page, seat: number, reason = "no working microphone") {
  await fac
    .locator(".row", { hasText: `Seat ${seat}: in the mic check` })
    .getByRole("button", { name: /Skip mic check/ })
    .click();
  await fac.locator(".popup").getByRole("textbox", { name: "Reason" }).fill(reason);
}

/** NEXT panel: start round `n` of `of` (waits until it can start). */
export async function startRound(fac: Page, n: number, of: number) {
  const start = fac.getByRole("button", { name: new RegExp(`Start round ${n} of ${of}`) });
  await expect(start).toBeEnabled({ timeout: 30_000 });
  await start.click();
}

/** TOOLS: pause recording for everyone (with a reason), or resume it. */
export async function pauseRecording(fac: Page, reason = "break") {
  await panel(fac, "Tools").getByRole("button", { name: "Pause recording" }).click();
  await fac
    .locator(".popup")
    .getByRole("textbox", { name: /^Reason/ })
    .fill(reason);
  await popupFoot(fac).getByRole("button", { name: "Pause recording" }).click();
}
export const resumeRecording = (fac: Page) =>
  panel(fac, "Tools").getByRole("button", { name: "Resume recording" }).click();

/** TOOLS: end the game early (asks first). */
export async function endGameEarly(fac: Page) {
  await panel(fac, "Tools")
    .getByRole("button", { name: /End game early/ })
    .click();
  await expect(fac.locator(".popup")).toBeVisible();
}

/** The recording state shown to the player ("recording", "paused", …). */
export const recTag = (page: Page, state: string) => page.locator(`.rec-tag.rec-${state}`).first();

/** A square of the grid map ("C3"). */
export const square = (page: Page, sq: string) =>
  page.locator(`g[data-square="${sq}"] rect.grid-square`).first();

export type ActKind = "Propose" | "Decide";

/** Click a square, then Propose/Decide in its panel and confirm (lands on the seat's power-type sub-square). */
export async function act(page: Page, kind: ActKind, sq: string) {
  await square(page, sq).click();
  await expect(screenTitle(page, `Square ${sq}`)).toBeVisible();
  await page
    .locator("aside")
    .getByRole("button", { name: new RegExp(`^${kind} ${sq} · K[a-d]`) })
    .click();
  await page.keyboard.press("Enter");
  await expect(page.locator("aside").getByRole("button", { name: /Confirm/ })).toHaveCount(0);
}

/** Several actions in a row, `gap` ms apart (spreads the marks on the timeline). */
export async function acts(page: Page, list: Array<[ActKind, string]>, gap = 0) {
  for (const [i, [kind, sq]] of list.entries()) {
    if (i > 0 && gap) await page.waitForTimeout(gap);
    await act(page, kind, sq);
  }
}

/** The participant's own DISPLAY panel (bottom right): open, change, close. */
export async function playerDisplay(page: Page, pick: (panel: Locator) => Promise<void>) {
  await page.getByRole("button", { name: /Display settings/ }).click();
  const dp = page.getByRole("dialog", { name: "Display settings" });
  await pick(dp);
  await page.keyboard.press("Escape");
  await expect(dp).toHaveCount(0);
  await blur(page); // no focus ring left on the DISPLAY button
}

/* ─────────────────────────── facilitator: wrap-up, DATABASE ─────────────────────────── */

/** Wrap-up popups: (takedown cards) → export → close. */
export async function wrapUp(fac: Page, cards: boolean) {
  await fac.getByRole("button", { name: /Wrap up session/ }).click();
  const popup = fac.locator(".popup");
  if (cards) {
    await fac.getByRole("checkbox", { name: /Cards are handed out/ }).check();
    await popupFoot(fac).getByRole("button", { name: /Next/ }).click();
  }
  await popup.getByRole("button", { name: /Export session/ }).click();
  await expect(popup.getByText(/Written to/)).toBeVisible();
  await popupFoot(fac).getByRole("button", { name: /Next/ }).click();
  await popupFoot(fac)
    .getByRole("button", { name: /Close session/ })
    .click();
  await expect(fac.locator(".live-indicator")).toHaveCount(0);
}

/** Switch the facilitator's tab by its shortcut: 1 SETUP/LIVE, 2 REPLAY, 3 DATABASE. */
export async function tab(fac: Page, n: 1 | 2 | 3) {
  await blur(fac);
  await fac.keyboard.press(String(n));
}

/** The session id shown in the LIVE indicator. */
export async function liveSessionId(fac: Page): Promise<string> {
  const id = (await fac.locator(".live-indicator").textContent())?.match(
    /\b(S|SIM)-\d{8}-[0-9A-Z]{4}\b/,
  )?.[0];
  if (!id) throw new Error("no session id in the LIVE indicator");
  return id;
}
