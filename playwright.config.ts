import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";
import { fakeVoiceFile } from "./e2e/fakeVoice";

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
 *
 * Microphone: Chromium gets a fake microphone that plays a synthetic voice (e2e/fakeVoice.ts:
 * room noise with speech-like bursts, so the real mic check passes) and grants the permission
 * without a prompt; audio may start without a click (a reload resumes recording by itself).
 */
const systemChromium =
  process.env.CHROMIUM_PATH ?? (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);

const E2E_PORT = process.env.E2E_PORT ?? "3999";
// decided in the main process; workers inherit it through the environment
if (process.argv.some((a) => a.includes("screenshots"))) process.env.WKWA_SCREENSHOTS = "1";
const screenshots = process.env.WKWA_SCREENSHOTS === "1";

/** Only the "docs" project (or only docs specs) asked for: no server needed. */
function docsOnly(): boolean {
  const args = process.argv.slice(2);
  const projects = args.flatMap((a, i) =>
    a.startsWith("--project=") ? [a.slice(10)] : a === "--project" ? [args[i + 1] ?? ""] : [],
  );
  if (projects.length) return projects.every((p) => p === "docs");
  const files = args.filter((a) => a.endsWith(".spec.ts"));
  return files.length > 0 && files.every((f) => /docs-[^/]*\.spec\.ts$/.test(f));
}

export default defineConfig({
  testDir: "e2e",
  reporter: [["list"]],
  use: {
    launchOptions: {
      ...(systemChromium ? { executablePath: systemChromium } : {}),
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        `--use-file-for-fake-audio-capture=${fakeVoiceFile()}`,
        "--autoplay-policy=no-user-gesture-required",
      ],
    },
  },
  projects: [
    {
      name: "docs",
      testMatch: /docs-.*\.spec\.ts/,
    },
    {
      name: "app",
      testMatch: /app-.*\.spec\.ts/,
      // one server holds one live session at a time: the spec files that run a session must not overlap
      workers: 1,
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
  webServer: docsOnly()
    ? undefined
    : {
        command: "npm run build && node scripts/e2e-server.mjs",
        url: `http://127.0.0.1:${E2E_PORT}/api/health`,
        reuseExistingServer: false,
        timeout: 120_000,
        env: { E2E_PORT },
      },
});
