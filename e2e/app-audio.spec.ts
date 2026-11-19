import { expect, type Page, test } from "@playwright/test";
import type { AudioTrackSummary } from "@wkwa/shared";
import {
  aboutYou,
  act,
  bind,
  briefing,
  consent,
  fillWithFakePlayers,
  liveSessionId,
  micCheck,
  newPlayer,
  PARTICIPANT_CODE,
  type Player,
  pauseRecording,
  recTag,
  resumeRecording,
  setupSession,
  startRound,
  tab,
  wrapUp,
} from "./flows";

/**
 * Audio end to end through the real UI: "Record audio" on in setup; two real player browsers
 * (Chromium's fake microphone plays a synthetic voice, see playwright.config.ts) and two fake
 * players take the seats; consent with the audio item, the consent hold, each player's own mic
 * check, the facilitator-led calibration, round 1 with the recording indicator, a pause and
 * resume from TOOLS, game complete; then the server holds audio tracks for the two real seats
 * only, and DATABASE marks the fake players.
 */
test.setTimeout(240_000);

test("audio: consent hold → mic check → calibration → recorded round with pause → tracks for real seats only", async ({
  page: fac,
  browser,
}) => {
  fac.on("pageerror", (e) => console.log("facilitator page error:", e.message));
  const players: Player[] = [];
  await setupSession(fac, {
    audio: true,
    labels: "shuffle",
    connect: async () => {
      for (const seat of [1, 2]) {
        const p = await newPlayer(browser);
        await bind(fac, seat, p);
        players.push(p);
      }
      await fillWithFakePlayers(fac);
      await expect(fac.getByText("4/4 seats bound")).toBeVisible();
    },
  });
  const [p1, p2] = players.map((p) => p.page) as [Page, Page];
  const sessionId = await liveSessionId(fac);

  // consent hold: seat 1 is done, seat 2 still reads the form → no microphone opens yet
  await consent(p1);
  await expect(p1.getByText("Waiting for the other players to finish the consent form")).toBeVisible();
  await expect(p1.getByRole("button", { name: /Start mic check/ })).toHaveCount(0);
  await expect(fac.getByText(/Mic checks are held until seat 2/)).toBeVisible();
  await consent(p2);

  // each player's own mic check (the real detector, fed by the synthetic voice)
  await Promise.all([micCheck(p1), micCheck(p2)]);
  await expect(recTag(p1, "recording")).toBeVisible();
  await Promise.all(
    [p1, p2].map(async (p) => {
      await aboutYou(p);
      await briefing(p);
    }),
  );

  // calibration from the NEXT panel: seat 1 reads while seat 2 stays quiet, then the other way round
  await expect(fac.getByRole("button", { name: /Start round 1/ })).toHaveCount(0);
  await fac.getByRole("button", { name: "Start calibration" }).click();
  await expect(p1.getByText("Your turn: read this sentence aloud")).toBeVisible({ timeout: 20_000 });
  await expect(p2.getByText(/Stay quiet: .*seat 1 is reading/)).toBeVisible();
  await expect(p2.getByText("Your turn: read this sentence aloud")).toBeVisible({ timeout: 20_000 });
  await expect(fac.getByText(/done · (separation ok|weak separation|checking)/)).toBeVisible({
    timeout: 30_000,
  });

  // round 1 with the recording indicator; the facilitator pauses recording for everyone, then resumes
  await startRound(fac, 1, 1);
  for (const p of [p1, p2]) await expect(recTag(p, "recording")).toBeVisible();
  await pauseRecording(fac, "e2e pause");
  for (const p of [p1, p2]) await expect(recTag(p, "paused")).toBeVisible();
  await resumeRecording(fac);
  for (const p of [p1, p2]) await expect(recTag(p, "recording")).toBeVisible();

  await Promise.all([
    act(p1, "Propose", "B2").then(() => act(p1, "Decide", "G7")),
    act(p2, "Propose", "E5").then(() => act(p2, "Decide", "J10")),
  ]);
  for (const p of [p1, p2]) await expect(p.getByText(PARTICIPANT_CODE)).toBeVisible({ timeout: 30_000 });

  // server side: tracks for the two real seats, none for the fake ones; each was paused once
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
  expect([...new Set(tracks.map((t) => t.seat))].sort()).toEqual([1, 2]);
  for (const seat of [1, 2]) {
    const mine = tracks.filter((t) => t.seat === seat);
    expect(mine.some((t) => t.stopReason === "paused")).toBe(true);
    expect(mine.at(-1)?.stopReason).toBe("game_complete");
    expect(mine.reduce((n, t) => n + t.samples, 0)).toBeGreaterThan(16_000);
  }

  // takedown cards only for the real participants; DATABASE marks the session's fake players
  await fac.getByRole("button", { name: /Wrap up session/ }).click();
  await expect(fac.locator(".popup").getByRole("button", { name: /Card PDF/ })).toHaveCount(2);
  await fac.keyboard.press("Escape");
  await wrapUp(fac, true);
  await tab(fac, 3);
  await expect(fac.locator("table tr", { hasText: "fake ×2" })).toHaveCount(1);
});
