import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { createApp } from "./app";
import { WrongPassphraseError } from "./db/database";
import { DB_FILES, dbFile as dbFileOf } from "./db/stores";
import { obtainPassphrase } from "./passphrase";
import { harnessVersion, REPO_ROOT, runtimeFromEnv } from "./runtime";
import { describeOutcome, playerUrls, resolveTls, startHttpRedirect } from "./tls";

async function main() {
  const runtime = runtimeFromEnv();
  if (runtime.configErrors?.length) throw new Error(runtime.configErrors.join("\n"));
  const hv = harnessVersion();
  console.log(`\nWho Knows, Who Acts? harness v${hv.version} (${hv.gitCommit})\n`);
  // once, before the passphrase: a bad TLS_CERT/TLS_KEY stops here, and the banner reports what really happened
  const tls = await resolveTls(runtime);
  // the participant database decides the passphrase prompt; the simulation database shares it
  const dbFile = dbFileOf(runtime.dataDir, "real");
  let ctx: Awaited<ReturnType<typeof createApp>> | undefined;
  for (let attempt = 1; !ctx; attempt++) {
    const pass = await obtainPassphrase(dbFile);
    try {
      ctx = await createApp(runtime, pass, { tls });
    } catch (e) {
      if (e instanceof WrongPassphraseError && attempt < 3 && !process.env.WKWA_DB_PASSPHRASE) {
        console.log("Wrong passphrase, try again.");
        continue;
      }
      throw e;
    }
  }
  await ctx.app.listen({ host: runtime.host, port: runtime.port });
  const port = (ctx.app.server.address() as AddressInfo).port;
  let redirect: Server | null = null;
  if (runtime.httpRedirectPort !== null && tls.info.enabled) {
    try {
      redirect = await startHttpRedirect({
        host: runtime.host,
        port: runtime.httpRedirectPort,
        httpsPort: port,
      });
    } catch (e) {
      console.log(`HTTP_REDIRECT_PORT ${runtime.httpRedirectPort}: not started (${(e as Error).message})`);
    }
  }

  const proto = tls.info.enabled ? "https" : "http";
  console.log("\n────────────────────────────────────────────────────────");
  console.log(` Facilitator dashboard: ${proto}://localhost:${port}/facilitator`);
  console.log(" Players open one of:");
  const addrs = playerUrls(runtime.host, port, tls.info.enabled);
  for (const a of addrs) console.log(`   ${a.url}   (${a.iface})`);
  if (addrs.length === 0) console.log("   (no LAN interface found — check your network connection)");
  if (tls.info.enabled) {
    const file = tls.certFile ?? "";
    const rel = path.relative(REPO_ROOT, file);
    const where = rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : file;
    console.log(
      ` HTTPS: ${tls.info.mode === "provided" ? "your certificate (TLS_CERT/TLS_KEY)" : "self-signed certificate"} ${where}`,
    );
    if (tls.outcome) console.log(`   ${describeOutcome(tls.outcome)}`);
    const left = Date.parse(tls.info.expires ?? "") - Date.now();
    if (tls.info.mode === "provided" && !(left > 30 * 24 * 3600_000))
      console.log(
        `   ⚠  TLS_CERT ${left > 0 ? "expires within 30 days" : "has EXPIRED"}: browsers will refuse or warn. Renew it, or unset TLS_CERT/TLS_KEY to use the self-signed certificate.`,
      );
    console.log(`   SHA-256 fingerprint: ${tls.info.fingerprintSha256}`);
    console.log(`   valid until ${tls.info.expires?.slice(0, 10)}`);
    if (tls.info.mode === "auto")
      console.log("   Each browser shows a certificate warning once: see docs/SESSION-RUNBOOK.md § 10");
    if (redirect) console.log(`   http://…:${runtime.httpRedirectPort}/ redirects to https://…:${port}/`);
  } else {
    console.log(
      " HTTPS: off (WKWA_TLS=off). Browsers on other PCs cannot use the microphone over plain HTTP.",
    );
    if (runtime.httpRedirectPort !== null)
      console.log(" HTTP_REDIRECT_PORT ignored: there is no HTTPS to redirect to.");
  }
  console.log(` Data directory: ${runtime.dataDir}`);
  console.log(`   ${DB_FILES.real} (participants) · ${DB_FILES.simulated} (simulations)`);
  if (ctx.hub.session)
    console.log(
      ` Resumed ${ctx.hub.session.simulated ? "simulated " : ""}session: ${ctx.hub.session.sessionId} (${ctx.hub.session.state.phase})`,
    );
  console.log("────────────────────────────────────────────────────────\n");

  const shutdown = async () => {
    console.log("\nShutting down…");
    redirect?.close();
    await ctx?.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
