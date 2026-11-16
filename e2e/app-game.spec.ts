import { type Browser, expect, type Page, test } from "@playwright/test";

/**
 * End-to-end: one facilitator page and four real player browsers play a
 * one-round game through the actual UI (bind → consent → demographics →
 * briefing → propose/decide → end screen → export → replay).
 */
test.setTimeout(180_000);

async function newPlayer(browser: Browser): Promise<{ page: Page; terminal: number }> {
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 850 } });
  const page = await ctx.newPage();
  await page.goto("/");
  await expect(page.getByText("Please wait for the facilitator")).toBeVisible();
  const terminal = Number(await page.locator("div", { hasText: /^\d+$/ }).last().textContent());
  return { page, terminal };
}

async function onboard(page: Page) {
  await expect(page.getByText("Information and consent").first()).toBeVisible({ timeout: 20_000 });
  for (const cb of await page.locator("input[type=checkbox]").all()) await cb.check();
  await page.getByRole("button", { name: "I agree — continue" }).click();
  await expect(page.getByRole("heading", { name: "About you" })).toBeVisible();
  for (const fs of await page.locator("fieldset").all())
    await fs.locator("input[type=radio]").first().check();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Briefing" })).toBeVisible();
  await page.getByRole("button", { name: "I'm ready" }).click();
  await expect(page.getByText("You're all set")).toBeVisible();
}

async function act(page: Page, kind: "Propose" | "Decide", region: string) {
  await page.locator(`path[data-region="${region}"]`).click();
  await page.locator("aside").getByRole("button", { name: kind, exact: true }).click();
  await page.getByRole("button", { name: "Confirm" }).click();
}

test("facilitator + 4 players play a round through the UI", async ({ page: fac, browser }) => {
  fac.on("pageerror", (e) => console.log("facilitator page error:", e.message));
  await fac.goto("/facilitator");
  await expect(fac.getByRole("button", { name: "Create session" })).toBeVisible();
  await fac.getByLabel("Number of rounds").fill("1");
  await fac.locator(".row", { hasText: "Proposals per player" }).locator("input[type=number]").fill("1");
  await fac.locator(".row", { hasText: "Decisions per player" }).locator("input[type=number]").fill("1");
  await fac.getByLabel("Condition").fill("e2e");
  await fac.getByRole("button", { name: "Create session" }).click();
  await expect(fac.getByText("Session flow")).toBeVisible();

  const players = [];
  for (let i = 0; i < 4; i++) players.push(await newPlayer(browser));
  for (const [i, p] of players.entries()) {
    await fac
      .locator("select:has(option:text('bind terminal…'))")
      .first()
      .selectOption({ label: `Terminal ${p.terminal}` });
    await expect(p.page.getByText(`seat ${i + 1}`)).toBeVisible();
  }
  await fac.getByRole("button", { name: "🎲 Randomise labels" }).click();
  await fac.getByRole("button", { name: "Start onboarding" }).click();
  await Promise.all(players.map((p) => onboard(p.page)));

  const start = fac.getByRole("button", { name: "Start round 1 of 1" });
  await expect(start).toBeEnabled();
  await start.click();
  const regions = ["R02", "R05", "R07", "R10"];
  await Promise.all(
    players.map(async (p, i) => {
      await expect(p.page.getByText("Proposals left")).toBeVisible();
      await act(p.page, "Propose", regions[i]!);
      await act(p.page, "Decide", regions[(i + 1) % 4]!);
    }),
  );
  await expect(fac.getByText("Game complete", { exact: true })).toBeVisible({ timeout: 20_000 });
  for (const p of players)
    await expect(p.page.getByText(/WK-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]/)).toBeVisible();
  await players[0]!.page.screenshot({ path: "test-results/player-end.png" });
  await fac.screenshot({ path: "test-results/facilitator-live.png", fullPage: true });

  // export + replay
  await fac.getByRole("button", { name: "Sessions & data" }).click();
  await fac.getByRole("button", { name: "Export", exact: true }).first().click();
  await expect(fac.getByText(/standard export E-/)).toBeVisible();
  await fac.screenshot({ path: "test-results/facilitator-data.png", fullPage: true });
  await fac.locator("table").getByRole("button", { name: "Replay", exact: true }).first().click();
  await expect(fac.getByText("Replay").first()).toBeVisible();
  const slider = fac.locator("input[type=range]");
  await slider.fill((await slider.getAttribute("max")) ?? "0");
  // scrubbing to the end reproduces the final state with the shared reducer
  await expect(fac.getByText("game_complete", { exact: true })).toBeVisible();
  await expect(fac.getByText(/GameCompleted · |#\d+ GameCompleted/).first()).toBeVisible();
  await fac.screenshot({ path: "test-results/facilitator-replay.png", fullPage: true });
});
