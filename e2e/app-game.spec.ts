import { type Browser, expect, type Page, test } from "@playwright/test";

/**
 * End-to-end through the real UI: the facilitator walks the 10-step setup
 * accordion, four player browsers onboard and play one round, the tab flips to
 * LIVE, the wrap-up popups export and close the session, then REPLAY.
 */
test.setTimeout(180_000);

async function newPlayer(browser: Browser): Promise<{ page: Page; terminal: number }> {
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 850 } });
  const page = await ctx.newPage();
  await page.goto("/");
  await expect(page.getByText("Waiting for the facilitator to assign a seat")).toBeVisible();
  const terminal = Number(await page.locator(".client-number").textContent());
  return { page, terminal };
}

/** Consent → (mic check, in a session that records audio: e2e/app-audio.spec.ts) → about you → briefing. */
async function onboard(page: Page) {
  await expect(page.getByText("Information and consent").first()).toBeVisible({ timeout: 20_000 });
  for (const cb of await page.locator("input[type=checkbox]").all()) await cb.check();
  await page.getByRole("button", { name: /I agree/ }).click();
  await expect(page.locator(".panel-title", { hasText: /About you|Mic check/ })).toBeVisible();
  if (await page.locator(".panel-title", { hasText: "Mic check" }).count()) {
    // Chromium's fake microphone plays a synthetic voice (playwright.config.ts): the real check passes
    await page.getByRole("button", { name: /Start mic check/ }).click({ timeout: 60_000 });
    await expect(page.getByText("Mic check passed")).toBeVisible({ timeout: 30_000 });
  }
  await expect(page.locator(".panel-title", { hasText: "About you" })).toBeVisible();
  for (const fs of await page.locator("fieldset").all())
    await fs.locator("input[type=radio]").first().check();
  await page.getByRole("button", { name: /Continue/ }).click();
  await expect(page.locator(".panel-title", { hasText: "Briefing" })).toBeVisible();
  await page.getByRole("button", { name: /I'm ready/ }).click();
  await expect(page.getByText("You're all set")).toBeVisible();
}

/** Click a square of the grid map, then Propose/Decide in its panel (lands on the player's power-type sub-square). */
async function act(page: Page, kind: "Propose" | "Decide", square: string) {
  await page.locator(`g[data-square="${square}"] rect.grid-square`).click();
  await expect(page.locator(".panel-title", { hasText: `Square ${square}` })).toBeVisible();
  await page
    .locator("aside")
    .getByRole("button", { name: new RegExp(`^${kind} ${square} · K[a-d]`) })
    .click();
  await page.keyboard.press("Enter"); // inline confirm prompt
  await expect(page.locator("aside").getByRole("button", { name: /Confirm/ })).toHaveCount(0);
}

/** The primary button of the expanded setup step (accordion). */
const next = (fac: Page) =>
  fac
    .locator(".acc-step.current .acc-foot")
    .getByRole("button", { name: /Next|Create session|Start onboarding/ });
const current = (fac: Page, key: string) =>
  expect(fac.locator(`.acc-step.current[data-step="${key}"]`)).toBeVisible();

test("setup wizard → live round → wrap-up → replay", async ({ page: fac, browser }) => {
  fac.on("pageerror", (e) => console.log("facilitator page error:", e.message));
  await fac.goto("/facilitator");

  // 01 scenario
  await current(fac, "scenario");
  await expect(fac.locator(".popup")).toHaveCount(0); // setup uses an accordion, not popups
  await fac.getByRole("radio", { name: /^Demo grid/ }).check();
  await next(fac).click();
  // 02 rounds: one round, 1 + 1 actions
  await current(fac, "rounds");
  await fac.getByRole("spinbutton", { name: "Number of rounds" }).fill("1");
  await fac.getByRole("spinbutton", { name: "Proposals per player" }).fill("1");
  await fac.getByRole("spinbutton", { name: "Decisions per player" }).fill("1");
  await next(fac).click();
  // 03 players (defaults) → 04 onboarding (defaults)
  await current(fac, "players");
  await next(fac).click();
  await current(fac, "onboarding");
  await next(fac).click();
  // 05 tags
  await current(fac, "tags");
  await fac.getByRole("textbox", { name: "Tags" }).fill("e2e, pilot, E2E");
  await expect(fac.locator(".chip")).toHaveCount(2);
  await next(fac).click();
  // 06 review → create
  await current(fac, "review");
  await expect(fac.locator(".acc-step.current.accent .acc-body")).toContainText("e2e, pilot");
  // the wayfinder is pinned (sticky) and filled with the primary colour
  const way = fac.locator("nav.wayfinder");
  expect(await way.evaluate((el) => getComputedStyle(el).position)).toBe("sticky");
  await expect(way).toContainText("STEP 06/10");
  await next(fac).click();

  // 07 connect & bind
  await current(fac, "connect");
  const players = [];
  for (let i = 0; i < 4; i++) players.push(await newPlayer(browser));
  for (const [i, p] of players.entries()) {
    await fac
      .getByRole("combobox", { name: `Bind a client to seat ${i + 1}` })
      .selectOption({ label: `Client ${p.terminal}` });
    await expect(p.page.getByText(`Seat ${i + 1}`)).toBeVisible();
  }
  await expect(fac.locator(".acc-step.current").getByText("4/4 seats bound")).toBeVisible();
  await next(fac).click();
  // 08 labels
  await current(fac, "labels");
  // fully dissociated pairing D6 in seat order: Ka–Pd, Kb–Pc, Kc–Pa, Kd–Pb
  const step8 = fac.locator(".acc-step.current");
  await step8.getByRole("radio", { name: /Dissociated/ }).check();
  await step8.getByRole("combobox", { name: "Dissociative pairing" }).selectOption("6");
  await step8.getByRole("button", { name: /Save labels/ }).click();
  await expect(next(fac)).toBeEnabled();
  await expect(fac.locator(".acc-step.current")).toContainText("Ka–Pd Kb–Pc Kc–Pa Kd–Pb");
  await next(fac).click();
  // 09 key sheet
  await current(fac, "keysheet");
  await fac.getByRole("checkbox", { name: /key sheet is printed/ }).check();
  await next(fac).click();
  // 10 start onboarding (same accent colour as review) → LIVE
  await current(fac, "start");
  await expect(fac.locator('.acc-step.current.accent[data-step="start"]')).toBeVisible();
  await next(fac).click();
  await expect(fac.locator(".live-indicator")).toBeVisible();
  await expect(fac.locator(".tab.active")).toContainText("LIVE");

  await Promise.all(players.map((p) => onboard(p.page)));
  const start = fac.getByRole("button", { name: /Start round 1 of 1/ });
  await expect(start).toBeEnabled();
  await start.click();
  const squares = ["B2", "E5", "G7", "J10"];
  await Promise.all(
    players.map(async (p, i) => {
      await expect(p.page.getByText(/Round 1\/1/)).toBeVisible();
      await act(p.page, "Propose", squares[i]!);
      await act(p.page, "Decide", squares[(i + 1) % 4]!);
    }),
  );
  for (const p of players)
    await expect(p.page.getByText(/WK-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]/)).toBeVisible({ timeout: 20_000 });
  await players[0]!.page.screenshot({ path: "test-results/player-end.png" });
  await fac.screenshot({ path: "test-results/facilitator-live.png", fullPage: true });

  // wrap-up: cards → export → close
  const popupNext = fac.locator(".popup-foot").getByRole("button", { name: /Next/ });
  await fac.getByRole("button", { name: /Wrap up session/ }).click();
  await fac.getByRole("checkbox", { name: /Cards are handed out/ }).check();
  await popupNext.click();
  await fac
    .locator(".popup")
    .getByRole("button", { name: /Export session/ })
    .click();
  await expect(fac.locator(".popup").getByText(/Written to/)).toBeVisible();
  await popupNext.click();
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

test("simulated players: setup without clients or key sheet → agents play LIVE → export → simulation database", async ({
  page: fac,
}) => {
  fac.on("pageerror", (e) => console.log("facilitator page error:", e.message));
  const primary = () =>
    fac
      .locator(".acc-step.current .acc-foot")
      .getByRole("button", { name: /Next|Create session|Start simulation/ });
  await fac.goto("/facilitator");

  // 01 scenario → 02 rounds: two short rounds
  await current(fac, "scenario");
  await fac.getByRole("radio", { name: /^Demo grid/ }).check();
  await primary().click();
  await current(fac, "rounds");
  await fac.getByRole("spinbutton", { name: "Number of rounds" }).fill("2");
  await fac.getByRole("spinbutton", { name: "Proposals per player" }).fill("2");
  await fac.getByRole("spinbutton", { name: "Decisions per player" }).fill("1");
  await primary().click();

  // 03 players: simulated, one idle-free setup with a fixed seed and a quick pace
  await current(fac, "players");
  await fac.getByRole("radio", { name: "Simulated players" }).check();
  const step3 = fac.locator(".acc-step.current");
  await expect(step3.getByRole("combobox", { name: "Policy of seat 4" })).toBeVisible();
  await step3.getByRole("combobox").filter({ hasText: "Watchable" }).selectOption("quick");
  await step3.getByPlaceholder("random", { exact: true }).fill("E2ESEED");
  await expect(fac.locator("nav.wayfinder")).toContainText("simulated players");
  await primary().click();

  // 04 onboarding is skipped for agents
  await current(fac, "onboarding");
  await expect(fac.locator(".acc-step.current")).toContainText("Simulated players skip onboarding");
  await primary().click();
  await current(fac, "tags");
  await expect(fac.locator(".wayfinder-strip button.skipped")).toHaveText(/– 04 Onboarding/);
  await primary().click();

  // 06 review → create (simulation database)
  await current(fac, "review");
  const review = fac.locator(".acc-step.current");
  await expect(review).toContainText("simulated · random ×4");
  await expect(review).toContainText("simulation database");
  await primary().click();

  // 07 agents instead of client binding: already done
  await current(fac, "connect");
  const agents = fac.locator(".acc-step.current");
  await expect(agents).toContainText("Simulated players");
  await expect(agents.getByText("Random (random v2)")).toHaveCount(4);
  await expect(agents).toContainText("E2ESEED:3");
  await primary().click();

  // 08 labels
  await current(fac, "labels");
  await fac
    .locator(".acc-step.current")
    .getByRole("button", { name: /Shuffle K across seats/ })
    .click();
  await expect(primary()).toBeEnabled();
  await primary().click();

  // 09 key sheet: not needed (– glyph); 10 start simulation → LIVE
  await current(fac, "keysheet");
  await expect(fac.locator(".acc-step.current")).toContainText("Not needed");
  await primary().click();
  await current(fac, "start");
  // 01–06 are locked (■) now; 09 stays skipped (–)
  await expect(fac.locator(".wayfinder-strip button.skipped")).toHaveText(/– 09 Key sheet/);
  await expect(primary()).toHaveText(/Start simulation/);
  await primary().click();
  await expect(fac.locator(".live-indicator")).toContainText("SIM-");
  await expect(fac.locator(".topbar")).toContainText("SIMULATION");
  await expect(fac.locator(".statusbar")).toContainText("4/4 agents");

  // the agents play round 1 by themselves; the facilitator starts round 2
  await fac.getByRole("button", { name: /Start round 2 of 2/ }).click({ timeout: 30_000 });
  await expect(fac.getByText("Simulation complete")).toBeVisible({ timeout: 30_000 });
  await fac.screenshot({ path: "test-results/facilitator-simulation-live.png", fullPage: true });

  // wrap-up without takedown cards: export → close
  await fac.getByRole("button", { name: /Wrap up session/ }).click();
  await expect(fac.locator(".popup")).toContainText("STEP 01/02");
  await fac
    .locator(".popup")
    .getByRole("button", { name: /Export session/ })
    .click();
  await expect(fac.locator(".popup").getByText(/exports\/simulations\/SIM-/)).toBeVisible();
  await fac.locator(".popup-foot").getByRole("button", { name: /Next/ }).click();
  await fac
    .locator(".popup-foot")
    .getByRole("button", { name: /Close session/ })
    .click();
  await expect(fac.locator(".live-indicator")).toHaveCount(0);

  // DATABASE opens on the simulation database; no erasure tools there
  await fac.keyboard.press("3");
  await expect(fac.locator("nav.subtabs .tab.active")).toContainText("Simulations");
  const row = fac.locator("table tr", { hasText: /SIM-\d{8}/ }).first();
  await expect(row).toBeVisible();
  await expect(row.getByRole("button", { name: /Key sheet/ })).toHaveCount(0);
  await expect(fac.getByText("nothing to look up or erase")).toBeVisible();
  await fac.screenshot({ path: "test-results/facilitator-database-simulations.png", fullPage: true });
  await fac
    .locator("nav.subtabs")
    .getByRole("button", { name: /Participants/ })
    .click();
  await expect(fac.locator("table tr", { hasText: /SIM-\d{8}/ })).toHaveCount(0);
  await expect(fac.getByRole("button", { name: /Look up/ })).toBeVisible();
});

test("fake players: one real browser + three server-created fake players → round → wrap-up → marked in DATABASE", async ({
  page: fac,
  browser,
}) => {
  fac.on("pageerror", (e) => console.log("facilitator page error:", e.message));
  await fac.goto("/facilitator");
  await current(fac, "scenario");
  await fac.getByRole("radio", { name: /^Demo grid/ }).check();
  await next(fac).click();
  await current(fac, "rounds");
  await fac.getByRole("spinbutton", { name: "Number of rounds" }).fill("1");
  await fac.getByRole("spinbutton", { name: "Proposals per player" }).fill("1");
  await fac.getByRole("spinbutton", { name: "Decisions per player" }).fill("1");
  for (const key of ["rounds", "players", "onboarding", "tags", "review"]) {
    await current(fac, key);
    await next(fac).click();
  }

  // 07: one real browser on seat 4, then fake players fill seats 1–3
  await current(fac, "connect");
  const real = await newPlayer(browser);
  await fac
    .getByRole("combobox", { name: "Bind a client to seat 4" })
    .selectOption({ label: `Client ${real.terminal}` });
  await expect(real.page.getByText("Seat 4")).toBeVisible();
  await fac.getByRole("combobox", { name: "Fake player pace" }).selectOption("fast");
  await fac.getByRole("button", { name: /Fill empty seats with fake players/ }).click();
  const step7 = fac.locator(".acc-step.current");
  await expect(step7.getByText("4/4 seats bound")).toBeVisible();
  await expect(step7.getByText("3 fake players")).toBeVisible();
  await expect(step7.getByText("none (fake player)")).toHaveCount(3);
  await next(fac).click();

  await current(fac, "labels");
  await fac
    .locator(".acc-step.current")
    .getByRole("button", { name: /Shuffle K across seats/ })
    .click();
  await expect(next(fac)).toBeEnabled();
  await next(fac).click();
  await current(fac, "keysheet");
  await expect(fac.locator(".acc-step.current")).toContainText("Seat 1, 2, 3 are fake players");
  await fac.getByRole("checkbox", { name: /key sheet is printed/ }).check();
  await next(fac).click();
  await current(fac, "start");
  await expect(fac.locator(".acc-step.current")).toContainText("Fake players (test clients");
  await next(fac).click();
  await expect(fac.locator(".topbar")).toContainText("FAKE PLAYERS ×3");

  // only the real player goes through onboarding; the fake players are ready at once
  await onboard(real.page);
  await fac.getByRole("button", { name: /Start round 1 of 1/ }).click();
  await expect(real.page.getByText(/Round 1\/1/)).toBeVisible();
  await act(real.page, "Propose", "C3");
  await act(real.page, "Decide", "D4");
  await expect(real.page.getByText(/WK-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]/)).toBeVisible({ timeout: 20_000 });
  await fac.screenshot({ path: "test-results/facilitator-fake-live.png", fullPage: true });

  // wrap-up: a takedown card only for the real participant
  await fac.getByRole("button", { name: /Wrap up session/ }).click();
  const popup = fac.locator(".popup");
  await expect(popup.getByRole("button", { name: /Card PDF/ })).toHaveCount(1);
  await fac.getByRole("checkbox", { name: /Cards are handed out/ }).check();
  await fac.locator(".popup-foot").getByRole("button", { name: /Next/ }).click();
  await popup.getByRole("button", { name: /Export session/ }).click();
  await expect(popup.getByText(/Written to/)).toBeVisible();
  await fac.locator(".popup-foot").getByRole("button", { name: /Next/ }).click();
  await fac
    .locator(".popup-foot")
    .getByRole("button", { name: /Close session/ })
    .click();

  await expect(fac.locator(".live-indicator")).toHaveCount(0);

  // DATABASE (participants): the session is marked as having fake players
  await fac.keyboard.press("3");
  await expect(fac.locator("nav.subtabs .tab.active")).toContainText("Participants");
  await expect(fac.locator("table tr", { hasText: "fake ×3" })).toHaveCount(1);
  await fac.screenshot({ path: "test-results/facilitator-database-fake.png", fullPage: true });
});
