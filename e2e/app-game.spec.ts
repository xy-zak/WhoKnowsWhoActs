import { expect, test } from "@playwright/test";
import {
  act,
  type Bot,
  bind,
  bindBots,
  newPlayer,
  onboard,
  PARTICIPANT_CODE,
  type Player,
  setupSession,
  startRound,
  tab,
  wrapUp,
} from "./flows";

/**
 * The game end to end through the real UI. What the server already proves over sockets
 * (apps/server/test: quotas, filtered views, reconnects, exports) is not repeated here: these
 * tests prove that the screens drive it.
 */
test.setTimeout(180_000);
test.beforeEach(({ page }) => {
  page.on("pageerror", (e) => console.log("facilitator page error:", e.message));
});

test("full session: setup → one player browser + three bots → round → wrap-up → DATABASE → REPLAY", async ({
  page: fac,
  browser,
}) => {
  let player: Player | undefined;
  const bots: Bot[] = [];
  try {
    await setupSession(fac, {
      tags: "e2e, pilot",
      labels: { dissociated: 6 },
      connect: async () => {
        player = await newPlayer(browser);
        await bind(fac, 1, player);
        bots.push(...(await bindBots(fac, [2, 3, 4])));
      },
    });
    const p = player!.page;

    await onboard(p);
    await startRound(fac, 1, 1);
    await expect(p.getByText(/Round 1\/1/)).toBeVisible();
    await act(p, "Propose", "B2");
    await act(p, "Decide", "E5");
    await expect(p.getByText(PARTICIPANT_CODE)).toBeVisible({ timeout: 20_000 });

    await wrapUp(fac, true);

    // DATABASE lists it with its tags; REPLAY reproduces the end state
    await tab(fac, 3);
    await expect(fac.locator(".chip", { hasText: "pilot" }).first()).toBeVisible();
    await fac
      .locator("table")
      .getByRole("button", { name: /Replay/ })
      .first()
      .click();
    const slider = fac.getByRole("slider", { name: "Replay position" });
    await slider.fill((await slider.getAttribute("max")) ?? "0");
    await expect(fac.locator(".panel").getByText("SessionClosed").first()).toBeVisible(); // its last event
  } finally {
    for (const b of bots) b.stop();
  }
});

test("simulated players: agents play LIVE → export → simulation database", async ({ page: fac }) => {
  await setupSession(fac, {
    rounds: { rounds: 2, propose: 2, decide: 1 },
    simulated: { pace: "quick", seed: "E2ESEED" },
    labels: "shuffle",
    // agents need no onboarding and no key sheet: the wayfinder shows them skipped (–); once the
    // session exists, steps 01–06 are locked (■) instead
    onStep: async (key) => {
      const skipped = fac.locator(".wayfinder-strip button.skipped");
      if (key === "tags") await expect(skipped).toHaveText(/– .*Onboarding/);
      if (key === "start") await expect(skipped).toHaveText(/– .*Key sheet/);
    },
  });
  await expect(fac.locator(".live-indicator")).toContainText("SIM-");

  // the agents play round 1 by themselves; the facilitator starts round 2
  await startRound(fac, 2, 2);
  await expect(fac.getByText("Simulation complete")).toBeVisible({ timeout: 30_000 });
  await wrapUp(fac, false);

  // DATABASE opens on the simulation database: no key sheet, nothing to erase; not among participants
  await tab(fac, 3);
  await expect(fac.locator("nav.subtabs .tab.active")).toContainText("Simulations");
  const row = fac.locator("table tr", { hasText: /SIM-\d{8}/ }).first();
  await expect(row).toBeVisible();
  await expect(row.getByRole("button", { name: /Key sheet/ })).toHaveCount(0);
  await fac
    .locator("nav.subtabs")
    .getByRole("button", { name: /Participants/ })
    .click();
  await expect(fac.locator("table tr", { hasText: /SIM-\d{8}/ })).toHaveCount(0);
});
