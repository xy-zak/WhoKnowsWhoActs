import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import type { LandingStatus } from "@wkwa/shared";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Logger } from "pino";
import { Server } from "socket.io";
import { registerApi } from "./api/routes";
import { AudioFileStore, audioDirOf } from "./audio/fileStore";
import { ScenarioLibrary } from "./content";
import { type DB, openDatabase, WrongPassphraseError } from "./db/database";
import { Store } from "./db/store";
import { DB_FILES, dbFile, SessionStores } from "./db/stores";
import { landingStatus, secureHeaders } from "./landing";
import { createLogger } from "./logger";
import { Hub, isLoopback, tokenMatches } from "./net/hub";
import type { RuntimeOptions } from "./runtime";
import { baseUrl, isWildcardHost, outcomeLogFields, resolveTls, type TlsState } from "./tls";

export interface AppContext {
  app: FastifyInstance;
  hub: Hub;
  /** The participant database (data/wkwa.db). */
  store: Store;
  db: DB;
  /** Encrypted audio files of the participant database (data/audio; keys in its audio tables). Same as store.audioFiles. */
  audioFiles: AudioFileStore;
  /** Both databases (`stores.simulated` = data/wkwa-sim.db); `stores.find(id)` says which one holds a session. */
  stores: SessionStores;
  log: Logger;
  runtime: RuntimeOptions;
  /** HTTPS of this run: off, a self-signed certificate (auto) or TLS_CERT/TLS_KEY (provided). */
  tls: TlsState;
  scenarios: ScenarioLibrary;
  close(): Promise<void>;
}

export async function createApp(
  runtime: RuntimeOptions,
  passphrase: string,
  opts: { logger?: Logger; autoResume?: boolean; tls?: TlsState } = {},
): Promise<AppContext> {
  // first: a bad TLS_CERT/TLS_KEY fails start-up with nothing opened yet
  const tls = opts.tls ?? (await resolveTls(runtime));
  const log =
    opts.logger ?? createLogger(runtime.dataDir, { stdout: runtime.logToStdout, level: runtime.logLevel });
  const db = openDatabase(dbFile(runtime.dataDir, "real"), passphrase);
  let simDb: DB;
  try {
    // same passphrase: one secret to manage; created on first start next to the participant database
    simDb = openDatabase(dbFile(runtime.dataDir, "simulated"), passphrase);
  } catch (e) {
    db.close();
    if (e instanceof WrongPassphraseError) {
      throw new Error(
        `The simulation database (${DB_FILES.simulated}) does not open with this passphrase, although ${DB_FILES.real} does. ` +
          "Both use the same passphrase: if only one was rekeyed, rekey the other with `npm run cli -- rekey --sim` (or without --sim).",
      );
    }
    throw e;
  }
  // after the databases opened: once per start, not once per passphrase attempt
  if (tls.info.enabled)
    // no names or addresses here: the server log never holds them
    log.info(
      {
        tls: tls.info.mode,
        fingerprintSha256: tls.info.fingerprintSha256,
        expires: tls.info.expires,
        ...(tls.outcome ? outcomeLogFields(tls.outcome) : {}),
      },
      "HTTPS on",
    );
  else log.info({ tls: "off" }, "HTTPS off: plain HTTP (WKWA_TLS=off)");
  // only the participant database has audio: simulated sessions never record
  const audioFiles = new AudioFileStore(audioDirOf(runtime.dataDir));
  const store = new Store(db, audioFiles);
  const stores = new SessionStores(store, new Store(simDb));
  const scenarios = new ScenarioLibrary(runtime.scenariosDir);

  const https = tls.https;

  const app = Fastify({
    loggerInstance: log,
    // never trust X-Forwarded-For: the real socket address decides "is this localhost?"
    trustProxy: false,
    ...(https ? { https } : {}),
  }) as unknown as FastifyInstance;

  const io = new Server(app.server, { serveClient: false, maxHttpBufferSize: 1e6 });
  /** Where fake players (test clients the server creates) connect: this server, over loopback when possible. */
  const selfUrl = () =>
    new Promise<string>((resolve) => {
      const make = () => {
        const port = (app.server.address() as AddressInfo).port;
        resolve(baseUrl(isWildcardHost(runtime.host) ? "127.0.0.1" : runtime.host, port, https !== null));
      };
      if (app.server.listening) make();
      else app.server.once("listening", make);
    });
  const hub = new Hub({
    io,
    stores,
    scenarios,
    configDir: runtime.configDir,
    log,
    adminToken: runtime.adminToken,
    selfUrl,
  });

  /** True if the request may use facilitator functions (loopback or valid ADMIN_TOKEN). */
  const isFacilitator = (req: FastifyRequest) => {
    if (isLoopback(req.socket.remoteAddress)) return true;
    const h = req.headers.authorization;
    return typeof h === "string" && h.startsWith("Bearer ") && tokenMatches(h.slice(7), runtime.adminToken);
  };
  const requireFacilitator = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!isFacilitator(req)) {
      reply
        .code(403)
        .type("text/plain")
        .send("Facilitator access is limited to this computer (or set ADMIN_TOKEN).");
    }
  };

  const ctx: AppContext = {
    app,
    hub,
    store,
    db,
    audioFiles,
    stores,
    log,
    runtime,
    tls,
    scenarios,
    async close() {
      hub.close();
      io.close();
      await app.close();
      db.close();
      simDb.close();
    },
  };

  secureHeaders(app);
  registerApi(ctx, requireFacilitator);
  // the welcome page's status on this server: its join link is this server's own game page
  app.get("/api/landing", async (): Promise<LandingStatus> => landingStatus(hub, tls.info, "/"));

  // ── Static client (built with `npm run build`) ──
  const dist = runtime.clientDist;
  if (existsSync(path.join(dist, "index.html"))) {
    await app.register(fastifyStatic, { root: dist, prefix: "/", index: false, wildcard: true });
    app.get("/", (_req, reply) => reply.sendFile("index.html"));
    // the welcome page here too (e.g. https://…/landing); participants normally open it on LANDING_PORT
    app.get("/landing", (_req, reply) => reply.sendFile("landing.html"));
    app.get("/facilitator", { preHandler: requireFacilitator }, (_req, reply) =>
      reply.sendFile("facilitator.html"),
    );
  } else {
    const msg =
      "Client not built. Run `npm run build` (then restart), or use `npm run dev` and open http://localhost:5173";
    app.get("/", (_req, reply) => reply.type("text/plain").send(msg));
    app.get("/facilitator", (_req, reply) => reply.type("text/plain").send(msg));
  }

  if (opts.autoResume !== false) hub.autoResume();
  return ctx;
}
