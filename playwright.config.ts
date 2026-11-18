import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

/**
 * Playwright projects:
 *  - "docs": validates every Mermaid diagram in docs/*.md and README.md (no server needed).
 *  - "app": end-to-end tests of the game through the real UI (with a webServer).
 *  - "screenshots": documentation screenshots into .screenshots/, run by
 *    `npm run screenshots -- capture` (scripts/screenshots.ts). Only defined
 *    when asked for, so a plain `playwright test` never takes them.
 *
 * Uses the system Chromium when available (Playwright's bundled browsers are not
 * needed): set CHROMIUM_PATH to override, or unset to use Playwright's own.
 */
const systemChromium =
  process.env.CHROMIUM_PATH ?? (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);

const E2E_PORT = process.env.E2E_PORT ?? "3999";
// decided in the main process; workers inherit it through the environment
if (process.argv.some((a) => a.includes("screenshots"))) process.env.WKWA_SCREENSHOTS = "1";
const screenshots = process.env.WKWA_SCREENSHOTS === "1";

export default defineConfig({
  testDir: "e2e",
  reporter: [["list"]],
  use: {
    launchOptions: systemChromium ? { executablePath: systemChromium } : {},
  },
  projects: [
    {
      name: "docs",
      testMatch: /docs-.*\.spec\.ts/,
    },
    {
      name: "app",
      testMatch: /app-.*\.spec\.ts/,
      use: { baseURL: `http://127.0.0.1:${E2E_PORT}`, viewport: { width: 1500, height: 950 } },
    },
    ...(screenshots
      ? [
          {
            name: "screenshots",
            testMatch: /screenshots\.spec\.ts/,
            use: { baseURL: `http://127.0.0.1:${E2E_PORT}` },
          },
        ]
      : []),
  ],
  // Only the "app" project needs the server; it gets a fresh temporary database each run.
  webServer: process.argv.some((a) => a.includes("docs"))
    ? undefined
    : {
        command: "npm run build && node scripts/e2e-server.mjs",
        url: `http://127.0.0.1:${E2E_PORT}/api/health`,
        reuseExistingServer: false,
        timeout: 120_000,
        env: { E2E_PORT },
      },
});
