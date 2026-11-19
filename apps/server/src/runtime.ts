import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TlsMode } from "@wkwa/shared";

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
  /**
   * WKWA_TLS: `auto` (default) serves HTTPS with a self-signed certificate the
   * server makes and keeps in data/tls/; `off` serves plain HTTP (development,
   * tests: localhost is a secure context anyway). TLS_CERT + TLS_KEY win over both.
   */
  tlsMode: TlsSetting;
  /** TLS_CERT / TLS_KEY: your own certificate and key (PEM); both or neither. */
  tlsCert: string | null;
  tlsKey: string | null;
  /**
   * LANDING_PORT: the plain-HTTP welcome page participants open first (default 8080; `off` = none).
   * It links to the game page once a session is open (see landing.ts).
   */
  landingPort: number | null;
  /** Log to stdout as well as to data/logs/server.log. */
  logToStdout: boolean;
  logLevel: string;
  /**
   * Server-only settings (WKWA_TLS, LANDING_PORT) that could not be read.
   * The server refuses to start with any; the data CLI, which never serves, ignores them.
   */
  configErrors?: string[];
}

export function runtimeFromEnv(env: NodeJS.ProcessEnv = process.env): RuntimeOptions {
  const r = (p: string) => path.resolve(REPO_ROOT, p);
  const configErrors: string[] = [];
  const read = <T>(parse: () => T, fallback: T): T => {
    try {
      return parse();
    } catch (e) {
      configErrors.push((e as Error).message);
      return fallback;
    }
  };
  return {
    host: env.HOST ?? "0.0.0.0",
    port: Number(env.PORT ?? 3000),
    dataDir: r(env.WKWA_DATA_DIR ?? "data"),
    exportsDir: r(env.WKWA_EXPORTS_DIR ?? "exports"),
    configDir: r(env.WKWA_CONFIG_DIR ?? "config"),
    scenariosDir: r(env.WKWA_SCENARIOS_DIR ?? "scenarios"),
    clientDist: r(env.WKWA_CLIENT_DIST ?? "apps/client/dist"),
    adminToken: env.ADMIN_TOKEN && env.ADMIN_TOKEN.length > 0 ? env.ADMIN_TOKEN : null,
    tlsMode: read(() => tlsSetting(env.WKWA_TLS), "auto"),
    tlsCert: env.TLS_CERT ? r(env.TLS_CERT) : null,
    tlsKey: env.TLS_KEY ? r(env.TLS_KEY) : null,
    landingPort: read(() => landingPort(env.LANDING_PORT), DEFAULT_LANDING_PORT),
    logToStdout: env.WKWA_LOG_STDOUT !== "0",
    logLevel: env.LOG_LEVEL ?? "info",
    configErrors,
  };
}

/** WKWA_TLS (TLS_CERT + TLS_KEY make it "provided"). */
export type TlsSetting = Exclude<TlsMode, "provided">;

function tlsSetting(value: string | undefined): TlsSetting {
  const v = value?.trim().toLowerCase() || "auto";
  if (v === "auto" || v === "off") return v;
  throw new Error(`WKWA_TLS must be "auto" or "off", not "${value}".`);
}

/** The welcome page's port when LANDING_PORT is not set. */
export const DEFAULT_LANDING_PORT = 8080;

function landingPort(value: string | undefined): number | null {
  const v = value?.trim().toLowerCase();
  if (v === undefined || v === "") return DEFAULT_LANDING_PORT;
  if (v === "off") return null;
  return optionalPort("LANDING_PORT", v);
}

function optionalPort(name: string, value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65_535)
    throw new Error(`${name} must be a TCP port (1–65535) or "off", not "${value}".`);
  return n;
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
