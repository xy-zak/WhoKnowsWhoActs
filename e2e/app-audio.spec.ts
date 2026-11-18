import { type Browser, expect, type Page, test } from "@playwright/test";
import type { AudioTrackSummary } from "@wkwa/shared";
import { io, type Socket } from "socket.io-client";
import {
  aboutYou,
  act,
  bind,
  briefing,
  chooseScenario,
  confirmKeySheet,
  consent,
  current,
  enableAudio,
  fillRounds,
  micCheck,
  next,
  shuffleLabels,
  wrapUp,
} from "./screenshots/flows";

/**
 * Audio end to end through the real UI: the facilitator switches "Record audio" on in setup
 * step 04; two real player browsers (Chromium's fake microphone plays a synthetic voice, see
 * playwright.config.ts) and two fake players take the seats; consent with the audio item, the
 * consent hold, each player's own mic check, the facilitator-led calibration, round 1 with the
 * recording indicator, a facilitator pause and resume, game complete; then the server holds
 * audio tracks for the two real seats and none for the fake ones.
 */
test.setTimeout(240_000);

const BASE = `http://127.0.0.1:${process.env.E2E_PORT ?? "3999"}`;

async function newPlayer(browser: Browser): Promise<{ page: Page; terminal: number }> {
  const ctx = await browser.newContext({ viewport: { width: 1300, height: 850 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("player page error:", e.message));
  await page.goto("/");
  await expect(page.getByText("Waiting for the facilitator to assign a seat")).toBeVisible();
  return { page, terminal: Number(await page.locator(".client-number").textContent()) };
}

/** A second facilitator connection for the commands the UI does not offer here (pause / resume recording). */
function facilitatorSocket() {
  const sock: Socket = io(`${BASE}/facilitator`, { transports: ["websocket"] });
  let sessionId: string | null = null;
  sock.on("dashboard", (m: { state: { sessionId: string | null } | null }) => {
    sessionId = m.state?.sessionId ?? sessionId;
  });
  return {
    sessionId: () => sessionId,
    cmd: (name: string, payload: unknown = {}) =>
      new Promise<{ ok: boolean; error?: string }>((resolve) => sock.emit(name, payload, resolve)),
    close: () => sock.close(),
  };
}

const recTag = (page: Page, state: string) => page.locator(`.rec-tag.rec-${state}`).first();

test("audio: setup → consent hold → mic check → calibration → recorded round with pause → tracks for real seats only", async ({
  page: fac,
  browser,
}) => {
  fac.on("pageerror", (e) => console.log("facilitator page error:", e.message));
  const facSock = facilitatorSocket();
  try {
    await fac.goto("/facilitator");
    await chooseScenario(fac, "Demo grid");
    await next(fac).click();
    await fillRounds(fac, { rounds: 1, propose: 1, decide: 1 });
    await next(fac).click();
    await current(fac, "players");
    await next(fac).click();

    // 04: Record audio (needs consent); the e2e server runs plain HTTP, so the HTTPS warning shows
    await enableAudio(fac);
    const step4 = fac.locator(".acc-step.current");
    await expect(step4.getByText(/players' browsers will block the microphone/)).toBeVisible();
    await expect(step4.getByText("WKWA_TLS=auto")).toBeVisible();
    await next(fac).click();
    await current(fac, "tags");
    await next(fac).click();
    await current(fac, "review");
    const review = fac.locator(".acc-step.current");
    await expect(review).toContainText("consent → mic check → demographics → briefing");
    await expect(review).toContainText(
      /on · each microphone recorded .* calibration required before round 1/,
    );
    await next(fac).click();

    // 07: two real browsers on seats 1–2, fake players on 3–4
    await current(fac, "connect");
    const p1 = await newPlayer(browser);
    const p2 = await newPlayer(browser);
    await bind(fac, 1, p1.terminal);
    await expect(p1.page.getByText("Seat 1")).toBeVisible();
    await bind(fac, 2, p2.terminal);
    await expect(p2.page.getByText("Seat 2")).toBeVisible();
    await fac.getByRole("combobox", { name: "Fake player pace" }).selectOption("fast");
    await fac.getByRole("button", { name: /Fill empty seats with fake players/ }).click();
    await expect(fac.locator(".acc-step.current").getByText("4/4 seats bound")).toBeVisible();
    await next(fac).click();
    await shuffleLabels(fac);
    await next(fac).click();
    await confirmKeySheet(fac);
    await next(fac).click();
    await current(fac, "start");
    await expect(fac.locator(".acc-step.current")).toContainText("the mic check");
    await next(fac).click();
    await expect(fac.locator(".live-indicator")).toBeVisible();

    // consent hold: seat 1 is done, seat 2 still reads the form → no microphone opens yet
    await consent(p1.page);
    await expect(p1.page.getByText("Waiting for the other players to finish the consent form")).toBeVisible();
    await expect(p1.page.getByRole("button", { name: /Start mic check/ })).toHaveCount(0);
    await expect(fac.getByText(/Mic checks are held until seat 2/)).toBeVisible();
    await consent(p2.page);

    // each player's own mic check (the real detector, fed by the synthetic voice)
    await Promise.all([micCheck(p1.page), micCheck(p2.page)]);
    // onboarding chrome: the recording line
    await expect(recTag(p1.page, "recording")).toBeVisible();
    await Promise.all(
      [p1, p2].map(async (p) => {
        await aboutYou(p.page);
        await briefing(p.page);
        await expect(p.page.getByText(/sound calibration/)).toBeVisible();
      }),
    );

    // calibration from the NEXT panel: seat 1 reads while seat 2 stays quiet, then the other way round
    await expect(fac.getByRole("button", { name: /Start round 1/ })).toHaveCount(0);
    await fac.getByRole("button", { name: "Start calibration" }).click();
    await expect(p1.page.getByText("Your turn: read this sentence aloud")).toBeVisible({ timeout: 20_000 });
    await expect(p2.page.getByText(/Stay quiet: .*seat 1 is reading/)).toBeVisible();
    await expect(p2.page.getByText("Your turn: read this sentence aloud")).toBeVisible({ timeout: 20_000 });
    await expect(p1.page.getByText(/Stay quiet: .*seat 2 is reading/)).toBeVisible();
    await expect(fac.getByText(/done · (separation ok|weak separation|checking)/)).toBeVisible({
      timeout: 30_000,
    });

    // round 1 with the recording indicator in the game's status line
    const start = fac.getByRole("button", { name: /Start round 1 of 1/ });
    await expect(start).toBeEnabled();
    await start.click();
    for (const p of [p1, p2]) {
      await expect(p.page.getByText(/Round 1\/1/)).toBeVisible();
      await expect(recTag(p.page, "recording")).toBeVisible();
    }

    // the facilitator pauses recording for everyone (players cannot mute), then resumes it
    expect(await facSock.cmd("recording:pause", { reason: "e2e pause" })).toMatchObject({ ok: true });
    for (const p of [p1, p2]) await expect(recTag(p.page, "paused")).toBeVisible();
    expect(await facSock.cmd("recording:resume")).toMatchObject({ ok: true });
    for (const p of [p1, p2]) await expect(recTag(p.page, "recording")).toBeVisible();

    await Promise.all(
      [p1, p2].map(async (p, i) => {
        await act(p.page, "Propose", ["B2", "E5"][i]!);
        await act(p.page, "Decide", ["G7", "J10"][i]!);
      }),
    );
    for (const p of [p1, p2])
      await expect(p.page.getByText(/WK-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]/)).toBeVisible({ timeout: 30_000 });

    // server side: tracks for the two real seats, none for the fake ones; resume and game end logged
    const sessionId = facSock.sessionId();
    expect(sessionId).toBeTruthy();
    let tracks: AudioTrackSummary[] = [];
    await expect
      .poll(
        async () => {
          const res = await fac.request.get(`/api/sessions/${sessionId}/audio`);
          tracks = ((await res.json()) as { tracks: AudioTrackSummary[] }).tracks;
          return tracks.filter((t) => t.status === "open").length;
        },
        { timeout: 20_000 },
      )
      .toBe(0);
    const seats = new Set(tracks.map((t) => t.seat));
    expect([...seats].sort()).toEqual([1, 2]);
    for (const seat of [1, 2]) {
      const mine = tracks.filter((t) => t.seat === seat);
      expect(mine.some((t) => t.stopReason === "paused")).toBe(true);
      expect(mine.at(-1)?.stopReason).toBe("game_complete");
      expect(mine.reduce((n, t) => n + t.samples, 0)).toBeGreaterThan(16_000);
    }
    await p1.page.screenshot({ path: "test-results/audio-player-end.png" });
    await fac.screenshot({ path: "test-results/audio-facilitator-live.png", fullPage: true });

    await wrapUp(fac, true);
  } finally {
    facSock.close();
  }
});
