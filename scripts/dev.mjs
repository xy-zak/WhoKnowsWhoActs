// Development mode: server (auto-restart on change) + Vite dev server with hot reload.
// Uses a SEPARATE dev database (data/dev) with a fixed dev passphrase — never use it for real sessions.
import { spawn } from "node:child_process";

const env = {
  ...process.env,
  WKWA_DATA_DIR: process.env.WKWA_DATA_DIR ?? "data/dev",
  WKWA_DB_PASSPHRASE: process.env.WKWA_DB_PASSPHRASE ?? "dev-only-passphrase",
  HOST: process.env.HOST ?? "127.0.0.1",
  // plain HTTP, always: Vite proxies to http://localhost:PORT, and localhost is a secure
  // context (microphone allowed). A TLS_CERT/TLS_KEY left in the shell would break the proxy.
  WKWA_TLS: "off",
  TLS_CERT: "",
  TLS_KEY: "",
};

const procs = [
  spawn("npx", ["tsx", "watch", "--clear-screen=false", "apps/server/src/index.ts"], {
    stdio: "inherit",
    env,
  }),
  spawn("npm", ["run", "dev", "-w", "@wkwa/client"], { stdio: "inherit", env }),
];
console.log("\n  Dev mode: open http://localhost:5173 (player) and http://localhost:5173/facilitator\n");
const stop = () => {
  for (const p of procs) p.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const p of procs) p.on("exit", (code) => code && code !== 0 && stop());
