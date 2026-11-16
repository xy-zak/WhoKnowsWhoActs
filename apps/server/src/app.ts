import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Logger } from "pino";
import { Server } from "socket.io";
import { registerApi } from "./api/routes";
import { ScenarioLibrary } from "./content";
import { type DB, openDatabase } from "./db/database";
import { Store } from "./db/store";
import { createLogger } from "./logger";
import { Hub, isLoopback, tokenMatches } from "./net/hub";
import type { RuntimeOptions } from "./runtime";

export interface AppContext {
  app: FastifyInstance;
  io: Server;
  hub: Hub;
  store: Store;
  db: DB;
  log: Logger;
  runtime: RuntimeOptions;
  scenarios: ScenarioLibrary;
  /** True if the request may use facilitator functions (loopback or valid ADMIN_TOKEN). */
  isFacilitator(req: FastifyRequest): boolean;
  close(): Promise<void>;
}

export async function createApp(
  runtime: RuntimeOptions,
  passphrase: string,
  opts: { logger?: Logger; autoResume?: boolean } = {},
): Promise<AppContext> {
  const log =
    opts.logger ?? createLogger(runtime.dataDir, { stdout: runtime.logToStdout, level: runtime.logLevel });
  const db = openDatabase(path.join(runtime.dataDir, "wkwa.db"), passphrase);
  const store = new Store(db);
  const scenarios = new ScenarioLibrary(runtime.scenariosDir);

  const https =
    runtime.tlsCert && runtime.tlsKey
      ? { cert: readFileSync(runtime.tlsCert), key: readFileSync(runtime.tlsKey) }
      : null;

  const app = Fastify({
    loggerInstance: log,
    // never trust X-Forwarded-For: the real socket address decides "is this localhost?"
    trustProxy: false,
    ...(https ? { https } : {}),
  }) as unknown as FastifyInstance;

  const io = new Server(app.server, { serveClient: false, maxHttpBufferSize: 1e6 });
  const hub = new Hub({
    io,
    store,
    scenarios,
    configDir: runtime.configDir,
    log,
    adminToken: runtime.adminToken,
  });

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
    io,
    hub,
    store,
    db,
    log,
    runtime,
    scenarios,
    isFacilitator,
    async close() {
      hub.close();
      io.close();
      await app.close();
      db.close();
    },
  };

  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Cache-Control", "no-store");
    return payload;
  });

  registerApi(ctx, requireFacilitator);

  // ── Static client (built with `npm run build`) ──
  const dist = runtime.clientDist;
  if (existsSync(path.join(dist, "index.html"))) {
    await app.register(fastifyStatic, { root: dist, prefix: "/", index: false, wildcard: true });
    app.get("/", (_req, reply) => reply.sendFile("index.html"));
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
