import { expect, type Page, test } from "@playwright/test";

/**
 * Display settings (accessibility): colours, font, text size, animations.
 * Each screen chooses its own; they persist in that browser only.
 */
const root = (page: Page) =>
  page.evaluate(() => ({ ...document.documentElement.dataset }) as Record<string, string>);
const bodyStyle = (page: Page) =>
  page.evaluate(() => {
    const cs = getComputedStyle(document.body);
    return { size: cs.fontSize, family: cs.fontFamily };
  });

test("facilitator: shortcuts and the DISPLAY popup change font, size, colours; kept after reload", async ({
  page,
}) => {
  await page.goto("/facilitator");
  await page.waitForSelector(".acc-step.current");
  expect(await bodyStyle(page)).toMatchObject({ size: "13px" });
  expect((await bodyStyle(page)).family).toContain("JetBrains Mono");

  await page.keyboard.press("s"); // text size → Large
  await page.keyboard.press("f"); // font → OpenDyslexic
  expect(await root(page)).toMatchObject({ scale: "large", font: "dyslexic" });
  expect(await bodyStyle(page)).toMatchObject({ size: "16px" });
  expect((await bodyStyle(page)).family).toContain("OpenDyslexic");

  await page.keyboard.press("d");
  const popup = page.getByRole("dialog", { name: "Display settings" });
  await expect(popup).toBeVisible();
  await popup.getByText("System font", { exact: true }).click();
  await popup.getByText("High contrast").click();
  await popup.locator(".segmented", { hasText: "Animations" }).getByText("Off", { exact: true }).click();
  expect(await root(page)).toMatchObject({ font: "system", theme: "contrast", crt: "off" });
  await popup.getByRole("button", { name: /Done/ }).click();

  await page.reload();
  await page.waitForSelector(".acc-step.current");
  expect(await root(page)).toMatchObject({ font: "system", theme: "contrast", scale: "large", crt: "off" });
  await expect(page.locator(".statusbar")).toContainText("SYSTEM FONT");
});

test("player: the DISPLAY panel sets the participant's own display; kept after reload", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Waiting for the facilitator to assign a seat")).toBeVisible();
  const btn = page.getByRole("button", { name: /Display settings/ });
  await btn.click();
  const panel = page.getByRole("dialog", { name: "Display settings" });
  await expect(panel).toBeVisible();
  await panel.getByText("OpenDyslexic", { exact: true }).click();
  await panel.getByText("Large", { exact: true }).click();
  await panel.getByText(/^Latte/).click();
  expect(await root(page)).toMatchObject({ font: "dyslexic", scale: "large", theme: "latte" });
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);

  await page.reload();
  await expect(page.getByText("Waiting for the facilitator to assign a seat")).toBeVisible();
  expect(await root(page)).toMatchObject({ font: "dyslexic", scale: "large", theme: "latte", crt: "on" });
  expect(await bodyStyle(page)).toMatchObject({ size: "16px" });
});
