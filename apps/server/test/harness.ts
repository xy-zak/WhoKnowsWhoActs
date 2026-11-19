import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { type AppContext, createApp } from "../src/app";
import { REPO_ROOT, type RuntimeOptions } from "../src/runtime";
import { baseUrl } from "../src/tls";
import { Bot, FacilitatorClient } from "../src/tools/botClient";

export const PASSPHRASE = "test passphrase 123";

export interface TestServer {
  ctx: AppContext;
  url: string;
  dir: string;
  runtime: RuntimeOptions;
  /** A request to this server (JSON body when given): status, body text and the parsed JSON. */
  // biome-ignore lint/suspicious/noExplicitAny: test responses are checked field by field
  api(method: string, path: string, body?: unknown): Promise<{ status: number; text: string; json: any }>;
  close(): Promise<void>;
}

export async function startTestServer(
  overrides: Partial<RuntimeOptions> = {},
  dir?: string,
): Promise<TestServer> {
  const tmp = dir ?? mkdtempSync(path.join(os.tmpdir(), "wkwa-test-"));
  const runtime: RuntimeOptions = {
    host: "127.0.0.1",
    port: 0,
    dataDir: path.join(tmp, "data"),
    exportsDir: path.join(tmp, "exports"),
    configDir: path.join(REPO_ROOT, "config"),
    scenariosDir: path.join(REPO_ROOT, "scenarios"),
    clientDist: path.join(tmp, "no-client"),
    adminToken: null,
    // plain HTTP unless a test asks for TLS: 127.0.0.1 is a secure context anyway
    tlsMode: "off",
    tlsCert: null,
    tlsKey: null,
    httpRedirectPort: null,
    logToStdout: false,
    logLevel: "info",
    ...overrides,
  };
  const ctx = await createApp(runtime, PASSPHRASE);
  await ctx.app.listen({ host: "127.0.0.1", port: 0 });
  const port = (ctx.app.server.address() as AddressInfo).port;
  const url = baseUrl("127.0.0.1", port, ctx.tls.info.enabled);
  return {
    ctx,
    url,
    dir: tmp,
    runtime,
    async api(method, urlPath, body) {
      const res = await fetch(`${url}${urlPath}`, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      const isJson = res.headers.get("content-type")?.includes("json");
      return { status: res.status, text, json: isJson && text ? JSON.parse(text) : null };
    },
    async close() {
      await ctx.close();
    },
  };
}

export function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true });
}

/** A CSV file of an export as rows keyed by column (RFC 4180: quoted cells may hold commas, quotes, newlines). */
export function readCsv(dir: string, file: string): Array<Record<string, string>> {
  const text = readFileSync(path.join(dir, file), "utf8");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell || row.length) rows.push([...row, cell]); // no newline after the last row
  const [head, ...body] = rows;
  return body.map((r) => Object.fromEntries(head!.map((h, i) => [h, r[i] ?? ""])));
}

/** Facilitator + N bots: create session, bind, label, onboard. Returns when round 1 can start; `stop()` ends the clients. */
export async function setupSession(
  url: string,
  config: Record<string, unknown> = {},
  n = 4,
  botOpts: Partial<ConstructorParameters<typeof Bot>[0]> = {},
) {
  // a test server with TLS on uses a self-signed certificate: over loopback, it is not checked
  const fac = new FacilitatorClient(url);
  await fac.connected();
  const { sessionId } = await fac.cmd("session:create", {
    scenarioId: "demo",
    config: { seatCount: n, ...config },
    notes: "integration test",
  });
  const bots = Array.from({ length: n }, (_, i) => new Bot({ url, name: `bot${i + 1}`, ...botOpts }));
  const terminals = await Promise.all(bots.map((b) => b.waitForTerminal()));
  for (let i = 0; i < n; i++) await fac.cmd("seat:bind", { terminal: terminals[i]!, seat: i + 1 });
  await Promise.all(bots.map((b) => b.waitFor((v) => v.phase === "lobby")));
  await fac.cmd("labels:randomise");
  await fac.cmd("onboarding:start");
  await fac.waitForDashboard((d) =>
    Object.values(d.state?.seats ?? {}).every((s) => s.consent === "given" && s.demographics && s.briefing),
  );
  const stop = () => {
    for (const b of bots) b.stop();
    fac.close();
  };
  return { fac, bots, sessionId, stop };
}
