import { type Browser, expect, type Page, test } from "@playwright/test";

/**
 * End-to-end through the real UI: the facilitator walks the 10-step setup
 * wizard, four player browsers onboard and play one round, the tab flips to
 * LIVE, the wrap-up popups export and close the session, then REPLAY.
 */
test.setTimeout(180_000);

async function newPlayer(browser: Browser): Promise<{ page: Page; terminal: number }> {
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 850 } });
  const page = await ctx.newPage();
  await page.goto("/");
  await expect(page.getByText("Waiting for the facilitator to assign a seat")).toBeVisible();
  const terminal = Number(await page.locator(".terminal-number").textContent());
  return { page, terminal };
}

async function onboard(page: Page) {
  await expect(page.getByText("Information and consent").first()).toBeVisible({ timeout: 20_000 });
  for (const cb of await page.locator("input[type=checkbox]").all()) await cb.check();
  await page.getByRole("button", { name: /I agree/ }).click();
  await expect(page.locator(".panel-title", { hasText: "About you" })).toBeVisible();
  for (const fs of await page.locator("fieldset").all())
    await fs.locator("input[type=radio]").first().check();
  await page.getByRole("button", { name: /Continue/ }).click();
  await expect(page.locator(".panel-title", { hasText: "Briefing" })).toBeVisible();
  await page.getByRole("button", { name: /I'm ready/ }).click();
  await expect(page.getByText("You're all set")).toBeVisible();
}

async function act(page: Page, kind: "Propose" | "Decide", region: string) {
  await page.locator(`path[data-region="${region}"]`).click();
  await page.locator("aside").getByRole("button", { name: kind, exact: true }).click();
  await page.keyboard.press("Enter"); // inline confirm prompt
  await expect(page.locator("aside").getByRole("button", { name: /Confirm/ })).toHaveCount(0);
}

const next = (fac: Page) =>
  fac.locator(".popup-foot").getByRole("button", { name: /Next|Create session|Start onboarding/ });

test("setup wizard → live round → wrap-up → replay", async ({ page: fac, browser }) => {
  fac.on("pageerror", (e) => console.log("facilitator page error:", e.message));
  await fac.goto("/facilitator");

  // 01 scenario
  await expect(fac.locator(".popup-title", { hasText: "Choose the scenario" })).toBeVisible();
  await expect(fac.locator(".popup-step", { hasText: "STEP 01/10" })).toBeVisible();
  await fac.getByRole("radio", { name: /Demo island/ }).check();
  await next(fac).click();
  // 02 rounds: one round, 1 + 1 actions
  await expect(fac.locator(".popup-step", { hasText: "STEP 02/10" })).toBeVisible();
  await fac.getByRole("spinbutton", { name: "Number of rounds" }).fill("1");
  await fac.getByRole("spinbutton", { name: "Proposals per player" }).fill("1");
  await fac.getByRole("spinbutton", { name: "Decisions per player" }).fill("1");
  await next(fac).click();
  // 03 players (defaults) → 04 onboarding (defaults)
  await expect(fac.locator(".popup-step", { hasText: "STEP 03/10" })).toBeVisible();
  await next(fac).click();
  await expect(fac.locator(".popup-step", { hasText: "STEP 04/10" })).toBeVisible();
  await next(fac).click();
  // 05 tags
  await expect(fac.locator(".popup-step", { hasText: "STEP 05/10" })).toBeVisible();
  await fac.getByRole("textbox", { name: "Tags" }).fill("e2e, pilot, E2E");
  await expect(fac.locator(".chip")).toHaveCount(2);
  await next(fac).click();
  // 06 review → create
  await expect(fac.locator(".popup-step", { hasText: "STEP 06/10" })).toBeVisible();
  await expect(fac.locator(".popup-body")).toContainText("e2e, pilot");
  await next(fac).click();

  // 07 connect & bind
  await expect(fac.locator(".popup-step", { hasText: "STEP 07/10" })).toBeVisible();
  const players = [];
  for (let i = 0; i < 4; i++) players.push(await newPlayer(browser));
  for (const [i, p] of players.entries()) {
    await fac
      .getByRole("combobox", { name: `Bind a terminal to seat ${i + 1}` })
      .selectOption({ label: `Terminal ${p.terminal}` });
    await expect(p.page.getByText(`Seat ${i + 1}`)).toBeVisible();
  }
  await expect(fac.locator(".popup").getByText("4/4 seats bound")).toBeVisible();
  await next(fac).click();
  // 08 labels
  await expect(fac.locator(".popup-step", { hasText: "STEP 08/10" })).toBeVisible();
  await fac
    .locator(".popup")
    .getByRole("button", { name: /Randomise all/ })
    .click();
  await expect(next(fac)).toBeEnabled();
  await next(fac).click();
  // 09 key sheet
  await expect(fac.locator(".popup-step", { hasText: "STEP 09/10" })).toBeVisible();
  await fac.getByRole("checkbox", { name: /key sheet is printed/ }).check();
  await next(fac).click();
  // 10 start onboarding → LIVE
  await expect(fac.locator(".popup-step", { hasText: "STEP 10/10" })).toBeVisible();
  await next(fac).click();
  await expect(fac.locator(".live-indicator")).toBeVisible();
  await expect(fac.locator(".tab.active")).toContainText("LIVE");

  await Promise.all(players.map((p) => onboard(p.page)));
  const start = fac.getByRole("button", { name: /Start round 1 of 1/ });
  await expect(start).toBeEnabled();
  await start.click();
  const regions = ["R02", "R05", "R07", "R10"];
  await Promise.all(
    players.map(async (p, i) => {
      await expect(p.page.getByText(/Round 1\/1/)).toBeVisible();
      await act(p.page, "Propose", regions[i]!);
      await act(p.page, "Decide", regions[(i + 1) % 4]!);
    }),
  );
  for (const p of players)
    await expect(p.page.getByText(/WK-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]/)).toBeVisible({ timeout: 20_000 });
  await players[0]!.page.screenshot({ path: "test-results/player-end.png" });
  await fac.screenshot({ path: "test-results/facilitator-live.png", fullPage: true });

  // wrap-up: cards → export → close
  await fac.getByRole("button", { name: /Wrap up session/ }).click();
  await fac.getByRole("checkbox", { name: /Cards are handed out/ }).check();
  await next(fac).click();
  await fac
    .locator(".popup")
    .getByRole("button", { name: /Export session/ })
    .click();
  await expect(fac.locator(".popup").getByText(/Written to/)).toBeVisible();
  await next(fac).click();
  await fac
    .locator(".popup-foot")
    .getByRole("button", { name: /Close session/ })
    .click();
  await expect(fac.locator(".live-indicator")).toHaveCount(0);
  await expect(fac.locator(".tab.active")).toContainText("SETUP");

  // DATABASE lists it with its tags; REPLAY reproduces the end state
  await fac.keyboard.press("3");
  await expect(fac.locator(".chip", { hasText: "pilot" }).first()).toBeVisible();
  await fac.screenshot({ path: "test-results/facilitator-database.png", fullPage: true });
  await fac
    .locator("table")
    .getByRole("button", { name: /Replay/ })
    .first()
    .click();
  const slider = fac.getByRole("slider", { name: "Replay position" });
  await slider.fill((await slider.getAttribute("max")) ?? "0");
  await expect(fac.locator(".panel").getByText("SessionClosed").first()).toBeVisible(); // last event of the closed session
  await fac.screenshot({ path: "test-results/facilitator-replay.png", fullPage: true });
});
