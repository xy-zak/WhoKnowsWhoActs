import { expect, type Page, test } from "@playwright/test";

/**
 * CRT = animations only (docs/AESTHETIC-RULES.md § 9): no scanlines or glow,
 * animated screen switches and popups, nothing at all with reduced motion.
 */
const scanlines = (page: Page) => page.evaluate(() => getComputedStyle(document.body, "::after").content);
const animation = (page: Page, sel: string) =>
  page
    .locator(sel)
    .first()
    .evaluate((el) => getComputedStyle(el).animationName);

test("with motion allowed: screens switch with an animation, no static CRT effects", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/facilitator");
  await page.waitForSelector(".acc-step.current");
  expect(await page.evaluate(() => document.documentElement.dataset.crt)).toBe("on");
  expect(await scanlines(page)).toBe("none");
  expect(await animation(page, "main.screen-switch")).toBe("crt-switch");
  const glow = await page.locator(".tab.active").evaluate((el) => getComputedStyle(el).textShadow);
  expect(glow).toBe("none");
  await page.keyboard.press("?");
  await page.waitForSelector(".popup");
  expect(await animation(page, ".popup")).toBe("crt-on");
});

test("reduced motion disables every CRT animation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/facilitator");
  await page.waitForSelector(".acc-step.current");
  expect(await animation(page, "main.screen-switch")).toBe("none");
  expect(await animation(page, ".acc-body")).toBe("none");
  await page.keyboard.press("?");
  await page.waitForSelector(".popup");
  expect(await animation(page, ".popup")).toBe("none");
});
