import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

/**
 * Playwright projects:
 *  - "docs": validates every Mermaid diagram in docs/*.md and README.md (no server needed).
 *  - add an "app" project (with a webServer) for end-to-end tests of the game.
 *
 * Uses the system Chromium when available (Playwright's bundled browsers are not
 * needed): set CHROMIUM_PATH to override, or unset to use Playwright's own.
 */
const systemChromium =
  process.env.CHROMIUM_PATH ?? (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);

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
  ],
});
