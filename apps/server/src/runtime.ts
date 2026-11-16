import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root (…/WhoKnowsWhoActs). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export interface RuntimeOptions {
  host: string;
  port: number;
  dataDir: string;
  exportsDir: string;
  configDir: string;
  scenariosDir: string;
  clientDist: string;
  adminToken: string | null;
  tlsCert: string | null;
  tlsKey: string | null;
  /** Log to stdout as well as to data/logs/server.log. */
  logToStdout: boolean;
  logLevel: string;
}

export function runtimeFromEnv(env: NodeJS.ProcessEnv = process.env): RuntimeOptions {
  const r = (p: string) => path.resolve(REPO_ROOT, p);
  return {
    host: env.HOST ?? "0.0.0.0",
    port: Number(env.PORT ?? 3000),
    dataDir: r(env.WKWA_DATA_DIR ?? "data"),
    exportsDir: r(env.WKWA_EXPORTS_DIR ?? "exports"),
    configDir: r(env.WKWA_CONFIG_DIR ?? "config"),
    scenariosDir: r(env.WKWA_SCENARIOS_DIR ?? "scenarios"),
    clientDist: r(env.WKWA_CLIENT_DIST ?? "apps/client/dist"),
    adminToken: env.ADMIN_TOKEN && env.ADMIN_TOKEN.length > 0 ? env.ADMIN_TOKEN : null,
    tlsCert: env.TLS_CERT ?? null,
    tlsKey: env.TLS_KEY ?? null,
    logToStdout: env.WKWA_LOG_STDOUT !== "0",
    logLevel: env.LOG_LEVEL ?? "info",
  };
}

let cachedVersion: { version: string; gitCommit: string } | null = null;

/** Harness version + git commit, recorded in every SessionCreated event for reproducibility. */
export function harnessVersion(): { version: string; gitCommit: string } {
  if (cachedVersion) return cachedVersion;
  let version = "0.0.0";
  try {
    version = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")).version ?? version;
  } catch {}
  let gitCommit = "unknown";
  try {
    gitCommit = execSync("git rev-parse --short HEAD", {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    const dirty = execSync("git status --porcelain --untracked-files=no", {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    if (dirty) gitCommit += "-dirty";
  } catch {}
  cachedVersion = { version, gitCommit };
  return cachedVersion;
}

/** Server clock: epoch milliseconds with sub-ms precision, monotonic within one process run. */
export function nowTs(): number {
  return performance.timeOrigin + performance.now();
}

export function wall(ts: number): string {
  return new Date(Math.floor(ts)).toISOString();
}
