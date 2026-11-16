import { existsSync, readFileSync } from "node:fs";
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
  const { app, store, scenarios, hub } = ctx;
  const opts = { preHandler: guard };

  app.get("/api/health", async () => ({
    ok: true,
    harness: harnessVersion(),
    session: hub.session?.sessionId ?? null,
  }));

  app.get("/api/scenarios", opts, async () => scenarios.list());

  /** Default session configuration for the setup form (config/session.default.json, validated). */
  app.get("/api/config/session-defaults", opts, async () => {
    const file = path.join(ctx.runtime.configDir, "session.default.json");
    const raw = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    return SessionConfigSchema.parse(raw);
  });

  app.get("/api/sessions", opts, async () => store.listSessions());

  app.get<{ Params: { id: string } }>("/api/sessions/:id", opts, async (req, reply) => {
    const row = store.getSession(req.params.id);
    if (!row) return reply.code(404).send({ error: "Unknown session" });
    const events = store.listEvents(row.id);
    return {
      session: row,
      state: reduceEvents(events),
      eventCount: events.length,
      attached: hub.session?.sessionId === row.id,
    };
  });

  /** Event log of a session (demographic answers redacted), for replay and inspection. */
  app.get<{ Params: { id: string } }>("/api/sessions/:id/events", opts, async (req, reply) => {
    if (!store.getSession(req.params.id)) return reply.code(404).send({ error: "Unknown session" });
    return store.listEvents(req.params.id).map(redactEvent);
  });

  app.get<{ Params: { id: string }; Querystring: { afterId?: string; limit?: string } }>(
    "/api/sessions/:id/telemetry",
    opts,
    async (req, reply) => {
      if (!store.getSession(req.params.id)) return reply.code(404).send({ error: "Unknown session" });
      return store.listTelemetry(req.params.id, {
        afterId: Number(req.query.afterId ?? 0),
        limit: Math.min(Number(req.query.limit ?? 100_000), 1_000_000),
      });
    },
  );

  app.get<{ Params: { id: string } }>("/api/sessions/:id/scenario", opts, async (req, reply) => {
    const row = store.getSession(req.params.id);
    if (!row) return reply.code(404).send({ error: "Unknown session" });
    const scenario = scenarios.load(row.scenario_id);
    return { scenario, hashMatches: scenario.hash === row.scenario_hash };
  });

  registerGdprApi(ctx, guard);
}
