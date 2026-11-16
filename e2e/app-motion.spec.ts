import { expect, test } from "@playwright/test";

/** prefers-reduced-motion switches every CRT effect off (docs/AESTHETIC-RULES.md § 9). */
test("reduced motion disables CRT animations and scanlines", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/facilitator");
  await page.waitForSelector(".popup");
  expect(await page.evaluate(() => document.documentElement.dataset.crt)).toBe("on");
  const popupAnimation = await page.locator(".popup").evaluate((el) => getComputedStyle(el).animationName);
  expect(popupAnimation).toBe("none");
  const scanlines = await page.evaluate(() => getComputedStyle(document.body, "::after").display);
  expect(scanlines).toBe("none");
});

test("with CRT on and motion allowed, popups power on and scanlines show", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/facilitator");
  await page.waitForSelector(".popup");
  const popupAnimation = await page.locator(".popup").evaluate((el) => getComputedStyle(el).animationName);
  expect(popupAnimation).toBe("crt-on");
  const scanlines = await page.evaluate(() => getComputedStyle(document.body, "::after").content);
  expect(scanlines).not.toBe("none");
});
