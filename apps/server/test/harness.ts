import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { isOnboardingComplete } from "@wkwa/shared";
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
    landingPort: null,
    logToStdout: false,
    logLevel: "info",
    ...overrides,
  };
  const ctx = await createApp(runtime, PASSPHRASE);
  await ctx.app.listen({ host: "127.0.0.1", port: 0 });
  const port = (ctx.app.server.address() as AddressInfo).port;
  return {
    ctx,
    url: baseUrl("127.0.0.1", port, ctx.tls.info.enabled),
    dir: tmp,
    runtime,
    async close() {
      await ctx.close();
    },
  };
}

export function cleanup(dir: string) {
  rmSync(dir, { recursive: true, force: true });
}

/** Facilitator + N bots: create session, bind, label, onboard. Returns when round 1 can start. */
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
  // through the onboarding: consent, questionnaire, briefing and (audio sessions) the mic check
  await fac.waitForDashboard((d) => {
    const st = d.state;
    return st !== null && Object.values(st.seats).every((s) => isOnboardingComplete(st, s));
  });
  return { fac, bots, sessionId };
}
