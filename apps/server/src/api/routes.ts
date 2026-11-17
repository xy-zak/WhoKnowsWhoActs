import { existsSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { reduceEvents, SessionConfigSchema } from "@wkwa/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../app";
import { redactEvent } from "../net/hub";
import { harnessVersion } from "../runtime";
import { registerGdprApi } from "./gdprRoutes";

type Guard = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** REST API for the facilitator dashboard (all routes facilitator-only). */
export function registerApi(ctx: AppContext, guard: Guard) {
  const { app, stores, scenarios, hub } = ctx;
  const opts = { preHandler: guard };

  app.get("/api/health", async () => ({
    ok: true,
    harness: harnessVersion(),
    session: hub.session?.sessionId ?? null,
  }));

  app.get("/api/scenarios", opts, async () => scenarios.list());

  /** Full scenario (outline + all views) for the setup preview. */
  app.get<{ Params: { id: string } }>("/api/scenarios/:id", opts, async (req, reply) => {
    try {
      return scenarios.load(req.params.id);
    } catch (e) {
      return reply.code(404).send({ error: (e as Error).message });
    }
  });

  /** Where players should point their browsers (setup step "Connect & bind"). */
  app.get("/api/server-info", opts, async () => {
    const addr = app.server.address() as AddressInfo | null;
    const port = addr?.port ?? ctx.runtime.port;
    const proto = ctx.runtime.tlsCert ? "https" : "http";
    const lan: Array<{ url: string; iface: string }> = [];
    if (ctx.runtime.host === "0.0.0.0" || ctx.runtime.host === "::") {
      for (const [iface, list] of Object.entries(os.networkInterfaces())) {
        for (const a of list ?? []) {
          if (a.family === "IPv4" && !a.internal)
            lan.push({ url: `${proto}://${a.address}:${port}/`, iface });
        }
      }
    } else lan.push({ url: `${proto}://${ctx.runtime.host}:${port}/`, iface: "configured host" });
    return { playerUrls: lan, port, tls: Boolean(ctx.runtime.tlsCert) };
  });

  /** Default session configuration for the setup form (config/session.default.json, validated). */
  app.get("/api/config/session-defaults", opts, async () => {
    const file = path.join(ctx.runtime.configDir, "session.default.json");
    const raw = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    return SessionConfigSchema.parse(raw);
  });

  /** Sessions of both databases, newest first; `players` says which database each one is in. */
  app.get("/api/sessions", opts, async () =>
    stores
      .all()
      .flatMap(({ players, store }) => store.listSessions().map((s) => ({ ...s, players })))
      .sort((a, b) => b.createdWall.localeCompare(a.createdWall)),
  );

  app.get<{ Params: { id: string } }>("/api/sessions/:id", opts, async (req, reply) => {
    const found = stores.find(req.params.id);
    if (!found) return reply.code(404).send({ error: "Unknown session" });
    const row = found.store.getSession(req.params.id)!;
    const events = found.store.listEvents(row.id);
    return {
      session: row,
      players: found.players,
      state: reduceEvents(events),
      eventCount: events.length,
      attached: hub.session?.sessionId === row.id,
    };
  });

  /** Event log of a session (demographic answers redacted), for replay and inspection. */
  app.get<{ Params: { id: string } }>("/api/sessions/:id/events", opts, async (req, reply) => {
    const found = stores.find(req.params.id);
    if (!found) return reply.code(404).send({ error: "Unknown session" });
    return found.store.listEvents(req.params.id).map(redactEvent);
  });

  app.get<{ Params: { id: string }; Querystring: { afterId?: string; limit?: string } }>(
    "/api/sessions/:id/telemetry",
    opts,
    async (req, reply) => {
      const found = stores.find(req.params.id);
      if (!found) return reply.code(404).send({ error: "Unknown session" });
      return found.store.listTelemetry(req.params.id, {
        afterId: Number(req.query.afterId ?? 0),
        limit: Math.min(Number(req.query.limit ?? 100_000), 1_000_000),
      });
    },
  );

  app.get<{ Params: { id: string } }>("/api/sessions/:id/scenario", opts, async (req, reply) => {
    const row = stores.find(req.params.id)?.store.getSession(req.params.id);
    if (!row) return reply.code(404).send({ error: "Unknown session" });
    const scenario = scenarios.load(row.scenario_id);
    return { scenario, hashMatches: scenario.hash === row.scenario_hash };
  });

  registerGdprApi(ctx, guard);
}
