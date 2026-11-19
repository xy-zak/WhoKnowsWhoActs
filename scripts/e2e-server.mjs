// Starts a throwaway server for Playwright end-to-end tests: fresh temp database, fixed test passphrase.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(os.tmpdir(), "wkwa-e2e-"));
const child = spawn("npx", ["tsx", "apps/server/src/index.ts"], {
  stdio: "inherit",
  env: {
    ...process.env,
    WKWA_DATA_DIR: path.join(dir, "data"),
    WKWA_EXPORTS_DIR: path.join(dir, "exports"),
    WKWA_DB_PASSPHRASE: "e2e-test-passphrase",
    WKWA_LOG_STDOUT: "0",
    HOST: "127.0.0.1",
    PORT: process.env.E2E_PORT ?? "3999",
    // plain HTTP: the browsers open http://127.0.0.1, which is a secure context (microphone allowed)
    WKWA_TLS: "off",
    // the bots send synthetic, voice-less audio: detect speech by energy, not with the speech model
    WKWA_SPEECH_MODEL: "off",
    TLS_CERT: "",
    TLS_KEY: "",
  },
});
const stop = () => child.kill("SIGTERM");
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.on("exit", (code) => process.exit(code ?? 0));
