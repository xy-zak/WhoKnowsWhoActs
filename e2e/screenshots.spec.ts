import { spawn } from "node:child_process";
import path from "node:path";
import { type Browser, expect, type Page, test } from "@playwright/test";
import {
  aboutYou,
  acts,
  addFake,
  BASE,
  bind,
  blur,
  briefing,
  calibrate,
  consent,
  currentStep,
  endGameEarly,
  liveSessionId,
  micCheck,
  newPlayer,
  onboard,
  onMicCheck,
  openPlayer,
  openSkipMicCheck,
  type Player,
  panel,
  playerDisplay,
  popupFoot,
  readyForCalibration,
  setupSession,
  square,
  tab,
  wrapUp,
} from "./flows";
import { CONTEXT, crop, hoverTip, prime, scenario, shot, writeReport } from "./screenshots/capture";
import { type ShotId, shotById } from "./screenshots/catalogue";

/**
 * Documentation screenshots: three scenarios play whole sessions through the
 * real UI at full-screen size and take every shot in e2e/screenshots/catalogue.ts.
 * Captures go to the staging folder .screenshots/; publishing them as versions
 * in docs/img and the gallery docs/img/SCREENSHOTS.md is done by
 *
 *   npm run screenshots -- capture <ids…>      (runs this spec)
 *   npm run screenshots -- publish <id> --caption "…"
 *
 * Not part of the normal test run. Everything shown is fictional: a fresh
 * temporary database, the demo scenarios and scripted players.
 * Workflow: .claude/skills/screenshot-app/SKILL.md.
 */

test.use(CONTEXT);
test.describe.configure({ mode: "serial" });
test.setTimeout(600_000);
test.afterAll(async ({ browser }) => writeReport(browser));

/** A full-screen player PC, primed for captures. */
const player = (browser: Browser) => newPlayer(browser, { context: CONTEXT, prepare: prime });

/** The catalogued shot of a setup step (server/setup-<data-step>), if there is one. */
async function setupShot(fac: Page, key: string, suffix = "") {
  const id = `server/setup-${key}${suffix}`;
  if (shotById(id)) await shot(fac, id as ShotId);
}

/* ─────────────────────────── 1. a full session ─────────────────────────── */

scenario(
  "session",
  "full session: setup → onboarding → two rounds → wrap-up → database → replay",
  async ({ page: fac, browser }) => {
    /* ── setup: a shot of every step; four player PCs connect ── */
    const players: Player[] = [];
    await setupSession(fac, {
      rounds: { rounds: 2, propose: 3, decide: 2, timeLimitSec: 600 },
      audio: true,
      tags: "pilot, condition-A",
      notes: "Screenshot run with scripted, fictional players.",
      // fully dissociated pairing D6 (Ka–Pd, Kb–Pc, Kc–Pa, Kd–Pb)
      labels: { dissociated: 6 },
      connect: async () => {
        for (let i = 0; i < 4; i++) players.push(await player(browser));
        const p1 = players[0]!.page;
        await shot(p1, "client/01-waiting-for-seat");
        await p1.getByRole("button", { name: /Display settings/ }).click();
        await crop(p1, "client/part-display-panel", p1.locator(".display-menu"), { fixed: true, pad: 16 });
        await p1.keyboard.press("Escape");
        await blur(p1);
        await shot(fac, "server/setup-connect");
        for (const [i, p] of players.entries()) await bind(fac, i + 1, p);
        await expect(currentStep(fac).getByText("4/4 seats bound")).toBeVisible();
        await shot(fac, "server/setup-connect-bound");
        await shot(p1, "client/02-seat-assigned");
      },
      onStep: async (key) => {
        if (key === "connect") return; // taken above, between the bindings
        await setupShot(fac, key);
        if (key === "who") {
          await currentStep(fac).getByRole("radio", { name: "Simulated players" }).check();
          await setupShot(fac, key, "-simulated");
          await currentStep(fac).getByRole("radio", { name: "Real participants" }).check();
        }
      },
    });
    const [p1, p2, p3, p4] = players.map((p) => p.page) as [Page, Page, Page, Page];

    /* ── onboarding: the seats at different steps (audio: consent → about you → briefing → hold → mic checks) ── */
    await consent(p4);
    await aboutYou(p4);
    await briefing(p4); // held: seats 1–3 are not through the briefing, so no microphone opens
    await expect(p4.getByText("Waiting for the other players to finish the briefing")).toBeVisible();
    await shot(p4, "client/audio-01-mic-check-held");
    await crop(fac, "server/audio-next-held", panel(fac, "Next"));
    await consent(p3);
    await aboutYou(p3);
    await consent(p2);
    // the seats at different steps: 4 at the mic check (held), 3 at the briefing, 2 at about you, 1 in consent
    await expect(p1.getByText("Information and consent").first()).toBeVisible({ timeout: 20_000 });
    await shot(fac, "server/live-01-onboarding");
    await crop(fac, "server/live-panel-seats-onboarding", panel(fac, "Seats"));
    await shot(p1, "client/03-consent");
    await consent(p1);
    await shot(p1, "client/04-about-you");
    await aboutYou(p1);
    await shot(p1, "client/05-briefing");
    await briefing(p1);
    await briefing(p3);
    await aboutYou(p2);
    await briefing(p2);
    // everyone is through the briefing: part 1, the mic checks, open
    await expect(p1.getByRole("button", { name: /Start mic check/ })).toBeVisible({ timeout: 30_000 });
    await shot(p1, "client/audio-02-mic-check-ready");
    // seats 2–4 pass their own mic checks (the real detector, fed by the synthetic voice)
    await Promise.all([micCheck(p4), micCheck(p3), micCheck(p2)]);
    // seat 1: listening (the level meter moves), then passed
    await p1.getByRole("button", { name: /Start mic check/ }).click();
    await expect(p1.getByText("Speech heard")).toBeVisible();
    await shot(p1, "client/audio-03-mic-check-listening", { wait: 1500 });
    await expect(p1.getByText("Mic check passed")).toBeVisible({ timeout: 30_000 });
    await shot(p1, "client/audio-04-mic-check-passed");
    await expect(onMicCheck(p1)).toHaveCount(0, { timeout: 10_000 });
    // part 2: ready for the calibration? (it starts once every seat has said so)
    await expect(p1.getByText("Part 2: the calibration")).toBeVisible();
    await shot(p1, "client/audio-06-calibration-waiting");
    await readyForCalibration(p1);
    await readyForCalibration(p4);
    await shot(p1, "client/06-ready");
    await crop(fac, "server/live-panel-next-ready", panel(fac, "Next"));

    // calibration: starts by itself once the last seats are ready; each seat reads in turn
    // while the others stay quiet (~7 s per seat)
    await readyForCalibration(p3);
    await readyForCalibration(p2);
    await expect(p1.getByText("Your turn: read this sentence aloud")).toBeVisible({ timeout: 30_000 });
    await shot(p1, "client/audio-07-calibration-turn", { wait: 800 });
    await expect(p2.getByText(/Stay quiet: .*seat 1 is reading/)).toBeVisible();
    await shot(p2, "client/audio-08-calibration-quiet");
    await crop(fac, "server/audio-next-calibration-running", panel(fac, "Next"));
    await expect(fac.getByText(/done · (separation ok|weak separation)/)).toBeVisible({ timeout: 90_000 });
    await crop(fac, "server/audio-next-calibration-done", panel(fac, "Next"));
    await crop(fac, "server/audio-calibration-card", panel(fac, "Calibration").last());
    // newest first: the calibration turns and its check, after the mic checks and track starts
    await crop(fac, "server/audio-event-log", panel(fac, "Event log"));
    const start1 = fac.getByRole("button", { name: /Start round 1 of 2/ });
    await expect(start1).toBeEnabled();
    await start1.click();

    /* ── round 1 (actions spread out, so the timeline shows them apart) ── */
    for (const p of [p1, p2, p3, p4]) await expect(p.getByText(/Round 1\/2/)).toBeVisible();
    await shot(p1, "client/07-game-round-start");
    await Promise.all([
      acts(
        p2,
        [
          ["Propose", "C3"],
          ["Decide", "F6"],
        ],
        4000,
      ),
      acts(
        p3,
        [
          ["Propose", "D4"],
          ["Propose", "H2"],
          ["Decide", "B7"],
        ],
        2500,
      ),
      (async () => {
        await p4.waitForTimeout(1500);
        await acts(
          p4,
          [
            ["Propose", "E8"],
            ["Decide", "D4"],
            ["Propose", "G3"],
          ],
          3000,
        );
      })(),
    ]);
    await acts(
      p1,
      [
        ["Propose", "C3"],
        ["Decide", "D4"],
      ],
      2000,
    );

    // player: a square's panel, then the inline confirmation
    await square(p1, "D4").click();
    await shot(p1, "client/08-game-square-selected");
    await crop(p1, "client/part-square-panel", panel(p1, "Square D4"));
    await square(p1, "G5").click();
    await p1
      .locator("aside")
      .getByRole("button", { name: /^Propose G5 · K/ })
      .click();
    await shot(p1, "client/09-game-confirm");
    await crop(p1, "client/part-confirm-prompt", panel(p1, "Square G5"));
    await p1.keyboard.press("Enter");
    await expect(p1.locator("aside").getByRole("button", { name: /Confirm/ })).toHaveCount(0);

    // player: the Propose tool, hovering a square previews where it lands
    await p1.keyboard.press("p");
    await square(p1, "E2").hover({ force: true });
    await shot(p1, "client/10-game-propose-tool", { keepMouse: true });
    await crop(p1, "client/part-tool-bar", p1.locator("div.row.panel").nth(1), { keepMouse: true });
    await p1.keyboard.press("Escape");
    await crop(p1, "client/part-status-line", p1.locator("div.row.panel").first());
    await crop(
      p1,
      "client/part-map-detail",
      [p1.locator('g[data-square="B2"]'), p1.locator('g[data-square="E5"]')],
      { pad: 3 },
    );
    // player: hover info on a sub-square someone else proposed
    await hoverTip(p1, p1.locator('g[data-square="C3"] [data-cell="C3-Kc"]'));
    await crop(p1, "client/part-map-tooltip", [p1.locator('g[data-square="C3"]'), p1.locator(".tooltip")], {
      tip: true,
      keepMouse: true,
      pad: 40,
    });

    // facilitator: the live screen and each panel
    await shot(fac, "server/live-02-round");
    await crop(fac, "server/live-panel-session", panel(fac, "Session"));
    await crop(fac, "server/live-panel-next", panel(fac, "Next"));
    await crop(fac, "server/live-panel-seats", panel(fac, "Seats"));
    await square(fac, "D4").click({ force: true });
    await crop(fac, "server/live-panel-composite-map", panel(fac, "Composite map"));
    await crop(fac, "server/live-panel-square", panel(fac, "Square"));
    await crop(fac, "server/live-panel-player-views", panel(fac, "Player views"));
    await crop(fac, "server/live-panel-event-log", panel(fac, "Event log"));
    await crop(fac, "server/live-panel-telemetry", panel(fac, "Live telemetry"));

    // facilitator tools: a broadcast and a note
    const tools = panel(fac, "Tools");
    await fac.getByRole("textbox", { name: "Message to all players" }).fill("Five minutes left in round 1.");
    await fac.getByRole("textbox", { name: "Facilitator note" }).fill("Round 1 is running as planned.");
    await crop(fac, "server/live-panel-tools", tools);
    await tools.getByRole("button", { name: /Broadcast/ }).click();
    await tools.getByRole("button", { name: /Add note/ }).click();
    await expect(p1.getByText("Five minutes left in round 1.")).toBeVisible();
    await crop(p1, "client/part-other-players-and-messages", [
      panel(p1, "Other players"),
      panel(p1, "Messages"),
    ]);
    await shot(p1, "client/11-game-marks");

    // facilitator: revoke asks first (cancelled here)
    await panel(fac, "Event log")
      .getByRole("button", { name: /Revoke/ })
      .first()
      .click();
    await expect(fac.locator(".popup")).toBeVisible();
    await shot(fac, "server/live-popup-revoke");
    await popupFoot(fac)
      .getByRole("button", { name: /Cancel/ })
      .click();

    // colour themes and the accessible font
    await blur(fac);
    await fac.keyboard.press("t"); // Latte → Mocha
    await shot(fac, "server/theme-mocha", { wait: 900 });
    await fac.keyboard.press("t"); // → High contrast
    await shot(fac, "server/theme-high-contrast", { wait: 900 });
    await fac.keyboard.press("t"); // → Latte
    await playerDisplay(p1, (dp) => dp.getByText(/^Mocha/).click());
    await shot(p1, "client/theme-mocha", { wait: 900 });
    await playerDisplay(p1, (dp) => dp.getByText("High contrast").click());
    await shot(p1, "client/theme-high-contrast", { wait: 900 });
    await playerDisplay(p1, async (dp) => {
      await dp.getByText(/^Latte/).click();
      await dp.getByText("OpenDyslexic", { exact: true }).click();
      await dp.getByText("Large", { exact: true }).click();
    });
    await shot(p1, "client/display-dyslexic-large", { wait: 900 });
    await playerDisplay(p1, async (dp) => {
      await dp.getByText("JetBrains Mono", { exact: true }).click();
      await dp.getByText("Small", { exact: true }).click();
    });

    // recording paused for everyone (TOOLS): confirmation, the paused state, what the player sees
    await crop(fac, "server/audio-status-bar", fac.locator(".statusbar"), { fixed: true, pad: 0 });
    await tools.getByRole("button", { name: "Pause recording" }).click();
    await fac
      .locator(".popup")
      .getByRole("textbox", { name: /^Reason/ })
      .fill("break");
    await shot(fac, "server/audio-popup-pause-recording");
    await popupFoot(fac).getByRole("button", { name: "Pause recording" }).click();
    await expect(p1.locator(".rec-tag.rec-paused").first()).toBeVisible();
    await crop(fac, "server/audio-tools-paused", tools);
    await shot(p1, "client/audio-09-game-paused-recording");
    await tools.getByRole("button", { name: "Resume recording" }).click();
    await expect(p1.locator(".rec-tag.rec-recording").first()).toBeVisible();

    // pause
    await panel(fac, "Next").getByRole("button", { name: /Pause/ }).click();
    await expect(p1.locator(".popup", { hasText: "Game paused" })).toBeVisible();
    await shot(p1, "client/12-game-paused");
    await shot(fac, "server/live-03-paused");
    await panel(fac, "Next")
      .getByRole("button", { name: /Resume/ })
      .click();
    await expect(p1.locator(".popup", { hasText: "Game paused" })).toHaveCount(0);

    // end round 1 early (asks first)
    await panel(fac, "Next")
      .getByRole("button", { name: /End round now/ })
      .click();
    await expect(fac.locator(".popup")).toBeVisible();
    await shot(fac, "server/live-popup-end-round");
    await popupFoot(fac)
      .getByRole("button", { name: /End round/ })
      .click();

    /* ── between rounds ── */
    await expect(p1.locator(".popup", { hasText: "Round 1 complete" })).toBeVisible();
    await shot(p1, "client/13-round-complete");
    await shot(fac, "server/live-04-round-complete");
    await tools.getByRole("button", { name: /Edit labels/ }).click();
    await expect(fac.locator(".popup")).toBeVisible();
    await shot(fac, "server/live-popup-edit-labels");
    await popupFoot(fac).getByRole("button", { name: /Done/ }).click();
    await fac.getByRole("button", { name: /Start round 2 of 2/ }).click();

    /* ── round 2: every quota used, so the game completes ── */
    for (const p of [p1, p2, p3, p4]) await expect(p.getByText(/Round 2\/2/)).toBeVisible();
    await Promise.all([
      acts(
        p1,
        [
          ["Propose", "A1"],
          ["Propose", "B5"],
          ["Decide", "C8"],
          ["Propose", "J9"],
          ["Decide", "I4"],
        ],
        1500,
      ),
      acts(
        p2,
        [
          ["Propose", "D9"],
          ["Decide", "C3"],
          ["Propose", "H6"],
          ["Propose", "F2"],
          ["Decide", "A6"],
        ],
        1500,
      ),
      acts(
        p3,
        [
          ["Propose", "I8"],
          ["Decide", "H2"],
          ["Propose", "E3"],
          ["Propose", "B1"],
          ["Decide", "J5"],
        ],
        1500,
      ),
      acts(
        p4,
        [
          ["Propose", "F9"],
          ["Decide", "E8"],
          ["Propose", "C6"],
          ["Decide", "G3"],
          ["Propose", "H10"],
        ],
        1500,
      ),
    ]);

    /* ── game complete ── */
    const codeText = p1.getByText(/WK-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]/).first();
    await expect(codeText).toBeVisible({ timeout: 20_000 });
    const code = (await codeText.textContent())!.trim();
    await shot(p1, "client/14-session-complete");
    await shot(fac, "server/live-05-game-complete");
    const timeline = panel(fac, "Timeline");
    await crop(fac, "server/live-panel-timeline", timeline);
    // a decision in the top lane, so the tooltip (with score changes) stays inside the panel
    await timeline.evaluate((el) => el.scrollIntoView({ block: "center" })); // whole panel in view, so the crop does not scroll
    await fac.waitForTimeout(600);
    // the live timeline redraws now and then, which drops the tooltip: try again until one is captured
    for (let attempt = 1; ; attempt++) {
      try {
        await hoverTip(fac, timeline.locator('[data-tip*="· seat 1 decided"]').last());
        await expect(fac.locator(".tooltip")).toBeVisible({ timeout: 500 });
        await crop(fac, "server/live-panel-timeline-tooltip", [timeline, fac.locator(".tooltip")], {
          tip: true,
          keepMouse: true,
          wait: 0,
        });
        // a redraw during the capture drops the tooltip from the crop without an error: check it
        await expect(fac.locator(".tooltip")).toBeVisible({ timeout: 100 });
        break;
      } catch (e) {
        if (attempt >= 10) throw e;
      }
    }

    /* ── wrap-up popups ── */
    await fac.getByRole("button", { name: /Wrap up session/ }).click();
    const popup = fac.locator(".popup");
    await shot(fac, "server/wrap-up-01-takedown-cards");
    await fac.getByRole("checkbox", { name: /Cards are handed out/ }).check();
    await popupFoot(fac).getByRole("button", { name: /Next/ }).click();
    await popup.getByRole("button", { name: /Export session/ }).click();
    await expect(popup.getByText(/Written to/)).toBeVisible();
    await shot(fac, "server/wrap-up-02-export");
    await popupFoot(fac).getByRole("button", { name: /Next/ }).click();
    await shot(fac, "server/wrap-up-03-close");
    await popupFoot(fac)
      .getByRole("button", { name: /Close session/ })
      .click();
    await expect(fac.locator(".live-indicator")).toHaveCount(0);

    /* ── DATABASE ── */
    await blur(fac);
    await fac.keyboard.press("3");
    await expect(fac.locator("nav.subtabs .tab.active")).toContainText("Participants");
    await shot(fac, "server/database-01-participants");
    await fac.getByRole("textbox", { name: "Participant code" }).fill(code);
    await fac.getByRole("button", { name: /Look up/ }).click();
    await fac.waitForTimeout(800);
    await crop(fac, "server/database-02-erasure-lookup", panel(fac, "Takedown / erasure"));

    /* ── REPLAY ── */
    await blur(fac);
    await fac.keyboard.press("2");
    const choose = panel(fac, "Replay · choose a session");
    await expect(choose).toBeVisible();
    await shot(fac, "server/replay-01-choose");
    await choose
      .getByRole("button", { name: /Replay/ })
      .first()
      .click();
    const slider = fac.getByRole("slider", { name: "Replay position" });
    await expect(slider).toBeVisible();
    const max = Number(await slider.getAttribute("max"));
    await slider.fill(String(Math.round(max * 0.6)));
    await shot(fac, "server/replay-02-session");

    /* ── help and display popups ── */
    await blur(fac);
    await fac.keyboard.press("1");
    await fac.keyboard.press("?");
    await expect(fac.locator(".popup")).toBeVisible();
    await shot(fac, "server/popup-keyboard-shortcuts");
    await fac.keyboard.press("Escape");
    await fac.keyboard.press("d");
    await expect(fac.locator(".popup")).toBeVisible();
    await shot(fac, "server/popup-display-settings");
    await fac.keyboard.press("Escape");
  },
);

/* ─────────────────────────── 2. the 5 × 5 grid with fake players ─────────────────────────── */

scenario("small-grid", "small grid: one player PC and three fake players", async ({ page: fac, browser }) => {
  let real: Player | undefined;
  await setupSession(fac, {
    scenario: "Small demo grid",
    rounds: { rounds: 1, propose: 3, decide: 2 },
    connect: async () => {
      real = await player(browser);
      await bind(fac, 1, real);
      for (const seat of [2, 3, 4]) await addFake(fac, seat);
      await expect(currentStep(fac).getByText("4/4 seats bound")).toBeVisible();
      await shot(fac, "server/setup-connect-fake-players");
    },
    onStep: async (key) => {
      if (key === "scenario") await shot(fac, "server/setup-scenario-small-grid");
    },
  });

  const rp = real!.page;
  await onboard(rp);
  await fac.getByRole("button", { name: /Start round 1 of 1/ }).click();
  await expect(rp.getByText(/Round 1\/1/)).toBeVisible();
  await acts(rp, [
    ["Propose", "B2"],
    ["Decide", "C3"],
    ["Propose", "D4"],
  ]);
  await rp.waitForTimeout(4000); // the fake players act too
  await square(rp, "C3").click();
  await shot(rp, "client/game-small-grid");
  await shot(fac, "server/live-small-grid");

  await endGameEarly(fac);
  await shot(fac, "server/live-popup-end-game");
  await popupFoot(fac)
    .getByRole("button", { name: /End game/ })
    .click();
  await wrapUp(fac, true);
});

/* ─────────────────────────── 3. simulated players ─────────────────────────── */

scenario("simulation", "simulated players: agents play, simulation database", async ({ page: fac }) => {
  await setupSession(fac, {
    rounds: { rounds: 2, propose: 3, decide: 2 },
    simulated: { pace: "quick", seed: "DOCS" },
    onStep: async (key) => {
      if (key === "connect") await shot(fac, "server/simulation-01-agents");
    },
  });
  await expect(fac.locator(".live-indicator")).toContainText("SIM-");

  const start2 = fac.getByRole("button", { name: /Start round 2 of 2/ });
  await expect(start2).toBeVisible({ timeout: 60_000 });
  await shot(fac, "server/simulation-02-live");
  await start2.click();
  await expect(fac.getByText("Simulation complete")).toBeVisible({ timeout: 60_000 });
  await wrapUp(fac, false);

  await tab(fac, 3);
  await expect(fac.locator("nav.subtabs .tab.active")).toContainText("Simulations");
  await shot(fac, "server/database-03-simulations");
});

/* ─────────────────────────── 4. audio: microphone problems ─────────────────────────── */

scenario(
  "audio-edge",
  "audio: blocked microphone, skipping a mic check, a microphone that stops in the game",
  async ({ page: fac, browser }) => {
    // one real PC whose browser can be told to refuse the microphone, and whose track can be ended
    let p1!: Page;
    await setupSession(fac, {
      audio: true,
      connect: async () => {
        const ctx = await browser.newContext(CONTEXT);
        await ctx.addInitScript(() => {
          const w = window as unknown as { __deny: boolean; __streams: MediaStream[] };
          w.__deny = false;
          w.__streams = [];
          const md = navigator.mediaDevices;
          if (!md) return;
          const orig = md.getUserMedia.bind(md);
          md.getUserMedia = async (c) => {
            if (w.__deny) throw new DOMException("Permission denied", "NotAllowedError");
            const stream = await orig(c);
            w.__streams.push(stream);
            return stream;
          };
        });
        p1 = await ctx.newPage();
        await prime(p1);
        await bind(fac, 1, await openPlayer(p1));
        for (const seat of [2, 3, 4]) await addFake(fac, seat);
        await expect(currentStep(fac).getByText("4/4 seats bound")).toBeVisible();
      },
    });

    // permission refused: what the player sees, and the facilitator's way out
    await consent(p1);
    await aboutYou(p1);
    await briefing(p1);
    const start = p1.getByRole("button", { name: /Start mic check/ });
    await expect(start).toBeVisible({ timeout: 30_000 });
    await p1.evaluate(() => {
      (window as unknown as { __deny: boolean }).__deny = true;
    });
    await start.click();
    await expect(p1.getByText("Microphone access is blocked").first()).toBeVisible();
    await shot(p1, "client/audio-05-mic-denied");
    await openSkipMicCheck(fac, 1);
    await shot(fac, "server/audio-popup-skip-mic-check");
    await popupFoot(fac)
      .getByRole("button", { name: /Cancel/ })
      .click();

    // allowed after all: try again, then part 2 (ready → calibration), play
    await p1.evaluate(() => {
      (window as unknown as { __deny: boolean }).__deny = false;
    });
    await p1.getByRole("button", { name: /Try again/ }).click();
    await expect(onMicCheck(p1)).toHaveCount(0, { timeout: 30_000 });
    await calibrate(fac, [p1]);
    const start1 = fac.getByRole("button", { name: /Start round 1 of 1/ });
    await expect(start1).toBeEnabled();
    await start1.click();
    await expect(p1.getByText(/Round 1\/1/)).toBeVisible();
    await expect(p1.locator(".rec-tag.rec-recording").first()).toBeVisible();

    // the microphone stops (unplugged, taken by another app): the game goes on, a banner explains
    await p1.evaluate(() => {
      for (const st of (window as unknown as { __streams: MediaStream[] }).__streams)
        for (const t of st.getAudioTracks()) t.dispatchEvent(new Event("ended"));
    });
    await expect(p1.getByText(/The microphone stopped/).first()).toBeVisible({ timeout: 15_000 });
    await shot(p1, "client/audio-10-game-mic-error", { wait: 800 });
    await fac.waitForTimeout(2000);
    await shot(fac, "server/audio-live-mic-error");

    await endGameEarly(fac);
    await popupFoot(fac)
      .getByRole("button", { name: /End game/ })
      .click();
    await wrapUp(fac, true);
  },
);

/* ─────────────────────────── 5. audio: DATABASE with a session played by bots ─────────────────────────── */

scenario(
  "audio-data",
  "audio: a session played by bots with synthetic audio, then DATABASE: attribution, export, delete",
  async ({ page: fac, browser }) => {
    // player PCs of the earlier scenarios are still connected (unseated): close them, so that
    // `--auto` binds the bots and not those pages
    for (const c of browser.contexts()) if (c !== fac.context()) await c.close();
    // the session is created here (audio on); `--auto` then binds the bots, calibrates and runs the rounds
    await setupSession(fac, {
      rounds: { rounds: 2, propose: 2, decide: 2 },
      audio: true,
      onStep: async (key) => (key === "connect" ? "stop" : undefined),
    });
    // tsx directly (not through npx), so that SIGTERM at the end reaches the bots
    const bots = spawn(
      path.resolve("node_modules/.bin/tsx"),
      [
        "apps/server/src/tools/bots.ts",
        "--url",
        BASE,
        "--count",
        "4",
        "--auto",
        "--audio",
        "--delay",
        "300-800",
        "--round-pause",
        "500",
      ],
      { stdio: "inherit" },
    );
    // a spawn error or an early exit of the bots fails the waits below at once
    const botsDied = new Promise<never>((_, reject) => {
      bots.once("error", reject);
      bots.once("exit", (code) => reject(new Error(`the bots exited early (code ${code})`)));
    });
    botsDied.catch(() => {}); // handled by the races; the exit after kill() below is expected
    const whileBots = <T>(p: Promise<T>) => Promise.race([p, botsDied]);
    try {
      await whileBots(expect(fac.locator(".live-indicator")).toBeVisible({ timeout: 60_000 }));
      const sessionId = await liveSessionId(fac);
      await whileBots(expect(fac.getByText(/Game complete/).first()).toBeVisible({ timeout: 400_000 }));
      await wrapUp(fac, true);

      await tab(fac, 3);
      await expect(fac.locator("nav.subtabs .tab.active")).toContainText("Participants");
      const row = fac.getByRole("row", { name: new RegExp(`^${sessionId}\\b`) });
      await expect(row).toBeVisible();
      await shot(fac, "server/audio-db-01-list");

      await row.getByRole("button", { name: / tr · / }).click();
      const popup = fac.locator(".popup");
      await expect(popup.getByRole("button", { name: /Run speaker attribution/ })).toBeVisible();
      await shot(fac, "server/audio-db-02-popup");

      await popup.getByRole("button", { name: /Run speaker attribution/ }).click();
      await expect(popup.getByText("Talk time", { exact: true })).toBeVisible({ timeout: 180_000 });
      await popup.getByText("Talk time", { exact: true }).scrollIntoViewIfNeeded();
      await shot(fac, "server/audio-db-03-attribution", { keepScroll: true });

      await popup.getByRole("radio", { name: "Clean" }).check();
      await popup.getByRole("button", { name: "WAV", exact: true }).first().click();
      const exported = popup.getByText(/^audio export [A-Z]+-/).first();
      await expect(exported).toBeVisible({ timeout: 30_000 });
      // the whole result (files, timing, warning) in view at the bottom of the popup
      await exported.evaluate((el) => el.closest(".callout")?.scrollIntoView({ block: "end" }));
      await shot(fac, "server/audio-db-04-export", { keepScroll: true });

      await popup.getByRole("button", { name: /Delete audio…/ }).click();
      await expect(
        fac
          .locator(".popup")
          .last()
          .getByText(/to confirm/),
      ).toBeVisible();
      await fac.locator(".popup").last().getByRole("textbox").last().fill(sessionId);
      await shot(fac, "server/audio-db-05-delete", { keepScroll: true });
      await fac.keyboard.press("Escape");
    } finally {
      bots.kill("SIGTERM");
    }
  },
);
