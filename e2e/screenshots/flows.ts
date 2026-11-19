import { type Browser, expect, type Locator, type Page } from "@playwright/test";
import { CONTEXT, prime, SCREEN, showTips } from "./capture";

/**
 * Reusable steps through the real UI: the facilitator's setup wizard, player
 * PCs, onboarding, propose/decide, wrap-up. Used by the screenshot scenarios;
 * any Playwright spec can use them to reach a screen.
 */

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

/**
 * Hover an element until its tooltip (data-tip) shows. Scrolls first and lets
 * the scroll settle: the tooltip layer hides on every scroll.
 */
export async function hoverTip(page: Page, target: Locator) {
  await target.scrollIntoViewIfNeeded();
  await page.mouse.move(SCREEN.width / 2, 1);
  await page.waitForTimeout(150);
  await target.hover({ force: true });
  await showTips(page);
  await expect(page.locator(".tooltip")).toBeVisible();
}

/** The footer of the open popup (its Next / Cancel / Confirm buttons). */
export const popupFoot = (page: Page) => page.locator(".popup-foot");

/* ─────────────────────────── facilitator: setup wizard ─────────────────────────── */

/** The primary button of the expanded setup step. */
export const next = (fac: Page) =>
  fac
    .locator(".acc-step.current .acc-foot")
    .getByRole("button", { name: /Next|Create session|Start onboarding|Start simulation/ });

/** Wait until setup step `key` (scenario, rounds, players, … start) is the expanded one. */
export const current = (fac: Page, key: string) =>
  expect(fac.locator(`.acc-step.current[data-step="${key}"]`)).toBeVisible();

/** Press the primary button through each of these steps, checking each one is current first. */
export async function nextThrough(fac: Page, keys: string[]) {
  for (const key of keys) {
    await current(fac, key);
    await next(fac).click();
  }
}

/** Step 01: pick a scenario by the start of its name ("Demo grid", "Small demo grid"). */
export async function chooseScenario(fac: Page, name: string) {
  await current(fac, "scenario");
  await fac.getByRole("radio", { name: new RegExp(`^${name}`) }).check();
}

/** Step 02: rounds and quotas (time limit in seconds, optional). */
export async function fillRounds(
  fac: Page,
  r: { rounds: number; propose: number; decide: number; timeLimitSec?: number },
) {
  await current(fac, "rounds");
  await fac.getByRole("spinbutton", { name: "Number of rounds" }).fill(String(r.rounds));
  await fac.getByRole("spinbutton", { name: "Proposals per player" }).fill(String(r.propose));
  await fac.getByRole("spinbutton", { name: "Decisions per player" }).fill(String(r.decide));
  if (r.timeLimitSec)
    await fac.getByRole("spinbutton", { name: "Time limit (seconds)" }).fill(String(r.timeLimitSec));
}

/** Step 08: bind a player PC (by its client number) to a seat. */
export async function bind(fac: Page, seat: number, terminal: number) {
  await fac
    .getByRole("combobox", { name: `Bind a client to seat ${seat}` })
    .selectOption({ label: `Client ${terminal}` });
}

/** Step 08: a fake player (a test client the server creates, at the normal pace) for a seat. */
export async function addFake(fac: Page, seat: number) {
  const row = fac.locator(".acc-step.current tr", { hasText: `SEAT ${seat}` });
  await row.getByRole("button", { name: "Fake player" }).click();
  await expect(row).toContainText("none (fake player)");
}

/**
 * Step 09: choose the K–P pairing, aligned (Ka–Pa …) or dissociated D1–D6; each seat keeps its K
 * (seat 1 → Ka …). Every choice is saved at once (no save button).
 */
export async function saveLabels(fac: Page, pairing: "aligned" | { dissociated: number } = "aligned") {
  await current(fac, "labels");
  const step = fac.locator(".acc-step.current");
  if (pairing === "aligned") await step.getByRole("radio", { name: /Aligned/ }).check();
  else {
    await step.getByRole("radio", { name: /Dissociated/ }).check();
    const pick = step.getByRole("combobox", { name: "Dissociative pairing" });
    await expect(pick).toBeVisible(); // shown once the drawn pairing is in force
    await pick.selectOption(String(pairing.dissociated));
    await expect(step).toContainText(`In force: D${pairing.dissociated}`);
  }
  await expect(next(fac)).toBeEnabled();
}

/** Step 10: confirm the key sheet is printed. */
export async function confirmKeySheet(fac: Page) {
  await current(fac, "keysheet");
  await fac.getByRole("checkbox", { name: /key sheet is printed/ }).check();
}

/* ─────────────────────────── players ─────────────────────────── */

/** A new player PC (own browser context, full screen), waiting for a seat. */
export async function newPlayer(browser: Browser): Promise<{ page: Page; terminal: number }> {
  const ctx = await browser.newContext(CONTEXT);
  const page = await ctx.newPage();
  await prime(page);
  await page.goto("/");
  await expect(page.getByText("Waiting for the facilitator to assign a seat")).toBeVisible();
  return { page, terminal: Number(await page.locator(".client-number").textContent()) };
}

/**
 * Consent: each sub-section of the accordion in turn, ticking its one statement (which confirms it
 * and opens the next; in a session that records audio, also the audio section), then "I agree".
 */
export async function consent(page: Page) {
  await expect(page.getByText("Information and consent").first()).toBeVisible({ timeout: 20_000 });
  const sections = page.locator(".accordion .acc-step");
  const n = await sections.count();
  for (let i = 0; i < n; i++) {
    // ticking confirms the section: it closes (its box goes with it) and the next one opens
    await sections.nth(i).locator("input[type=checkbox]").click();
    await expect(sections.nth(i)).toHaveClass(/\bdone\b/);
  }
  await page.getByRole("button", { name: /I agree/ }).click();
  await expect(page.locator(".panel-title", { hasText: /About you|Briefing/ })).toBeVisible();
}

/** Part 1 of "Mic check & calibration": the mic check, held or not (sessions that record audio). */
export const onMicCheck = (page: Page) => page.locator(".panel-title", { hasText: "part 1 of 2" });

/**
 * Sessions that record audio: the player's own mic check, the real way. Waits while it is held
 * (another seat not through the briefing yet), clicks Start (Playwright's Chromium has a fake
 * microphone that plays a synthetic voice: playwright.config.ts, e2e/fakeVoice.ts) and waits until
 * it passes and the player is on part 2 (ready for the calibration?).
 */
export async function micCheck(page: Page) {
  await expect(onMicCheck(page)).toBeVisible();
  const start = page.getByRole("button", { name: /Start mic check/ });
  await expect(start).toBeVisible({ timeout: 60_000 }); // shown once the hold is lifted
  await start.click();
  await expect(page.getByText("Mic check passed")).toBeVisible({ timeout: 30_000 });
  await expect(onMicCheck(page)).toHaveCount(0, { timeout: 10_000 });
  await expect(page.getByText("Part 2: the calibration")).toBeVisible();
}

/** Part 2 of "Mic check & calibration": the player says they are ready for the calibration. */
export async function readyForCalibration(page: Page) {
  await page.getByRole("button", { name: "I'm ready for the calibration" }).click();
  // the last one to say so starts the calibration at once
  await expect(
    page.getByText("You are ready.").or(page.getByText(/Your turn: read this sentence aloud|Stay quiet/)),
  ).toBeVisible();
}

export async function aboutYou(page: Page) {
  for (const fs of await page.locator("fieldset").all())
    await fs.locator("input[type=radio]").first().check();
  await page.getByRole("button", { name: /Continue/ }).click();
  await expect(page.locator(".panel-title", { hasText: "Briefing" })).toBeVisible();
}

/** The briefing's "I'm ready": then READY, or (sessions that record audio) part 1, the mic check. */
export async function briefing(page: Page) {
  await page.getByRole("button", { name: /I'm ready$/ }).click();
  await expect(page.getByText("You're all set").or(onMicCheck(page))).toBeVisible();
}

/** Consent → about you → briefing (→ mic check, in a session that records audio). */
export async function onboard(page: Page) {
  await consent(page);
  await aboutYou(page);
  await briefing(page);
  if (await onMicCheck(page).count()) await micCheck(page);
}

/**
 * Sessions that record audio: every recorded player (in seat order) says they are ready for the
 * calibration, which then starts by itself; waits until every seat had its turn ("Your turn" on
 * each `players` page in turn; each turn takes ~7 s).
 */
export async function calibrate(fac: Page, players: Page[]) {
  for (const p of players) await readyForCalibration(p);
  for (const p of players)
    await expect(p.getByText("Your turn: read this sentence aloud")).toBeVisible({ timeout: 60_000 });
  await expect(fac.getByText(/done · (separation ok|weak separation|checking)/)).toBeVisible({
    timeout: 60_000,
  });
}

/** NEXT panel: skip a seat's mic check (confirmation with a logged reason). */
export async function skipMicCheck(fac: Page, seat: number, reason = "no working microphone") {
  await fac
    .locator(".row", { hasText: `Seat ${seat}: in the mic check` })
    .getByRole("button", { name: /Skip mic check/ })
    .click();
  await fac.locator(".popup").getByRole("textbox", { name: "Reason" }).fill(reason);
  await popupFoot(fac)
    .getByRole("button", { name: /Skip mic check/ })
    .click();
}

/** Step 05: switch audio recording on (needs the consent screen, which is on by default). */
export async function enableAudio(fac: Page) {
  await current(fac, "onboarding");
  await fac.getByRole("checkbox", { name: /Record audio/ }).check();
}

/** A square of the grid map ("C3"). */
export const square = (page: Page, sq: string) =>
  page.locator(`g[data-square="${sq}"] rect.grid-square`).first();

export type ActKind = "Propose" | "Decide";

/** Click a square, then Propose/Decide in its panel and confirm (lands on the seat's power-type sub-square). */
export async function act(page: Page, kind: ActKind, sq: string) {
  await square(page, sq).click();
  await expect(page.locator(".panel-title", { hasText: `Square ${sq}` })).toBeVisible();
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

/* ─────────────────────────── facilitator: wrap-up ─────────────────────────── */

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
