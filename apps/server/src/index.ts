import os from "node:os";
import path from "node:path";
import { createApp } from "./app";
import { WrongPassphraseError } from "./db/database";
import { obtainPassphrase } from "./passphrase";
import { harnessVersion, runtimeFromEnv } from "./runtime";

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) out.push(`${a.address}  (${name})`);
    }
  }
  return out;
}

async function main() {
  const runtime = runtimeFromEnv();
  const hv = harnessVersion();
  console.log(`\nWho Knows, Who Acts? harness v${hv.version} (${hv.gitCommit})\n`);
  const dbFile = path.join(runtime.dataDir, "wkwa.db");
  let ctx: Awaited<ReturnType<typeof createApp>> | undefined;
  for (let attempt = 1; !ctx; attempt++) {
    const pass = await obtainPassphrase(dbFile);
    try {
      ctx = await createApp(runtime, pass, {});
    } catch (e) {
      if (e instanceof WrongPassphraseError && attempt < 3 && !process.env.WKWA_DB_PASSPHRASE) {
        console.log("Wrong passphrase, try again.");
        continue;
      }
      throw e;
    }
  }
  await ctx.app.listen({ host: runtime.host, port: runtime.port });
  const proto = runtime.tlsCert ? "https" : "http";
  console.log("\n────────────────────────────────────────────────────────");
  console.log(` Facilitator dashboard: ${proto}://localhost:${runtime.port}/facilitator`);
  console.log(" Players open one of:");
  const addrs = runtime.host === "0.0.0.0" ? lanAddresses() : [runtime.host];
  for (const a of addrs) {
    const [ip, iface] = a.split("  ");
    console.log(`   ${proto}://${ip}:${runtime.port}/   ${iface ?? ""}`);
  }
  if (addrs.length === 0) console.log("   (no LAN interface found — check your network connection)");
  console.log(` Data directory: ${runtime.dataDir}`);
  if (ctx.hub.session)
    console.log(` Resumed session: ${ctx.hub.session.sessionId} (${ctx.hub.session.state.phase})`);
  console.log("────────────────────────────────────────────────────────\n");

  const shutdown = async () => {
    console.log("\nShutting down…");
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
