import { existsSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { reduceEvents, SessionConfigSchema } from "@wkwa/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../app";
import { redactEvent } from "../net/hub";
import { harnessVersion } from "../runtime";
import { playerUrls, type TlsInfo } from "../tls";
import { registerGdprApi } from "./gdprRoutes";
import { sessionOr404 } from "./sessionLookup";

type Guard = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** GET /api/server-info */
export interface ServerInfo {
  /** One URL per LAN interface (or the configured HOST), with the right scheme. */
  playerUrls: Array<{ url: string; iface: string }>;
  port: number;
  tls: TlsInfo;
}

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

  /** Full scenario (board, all views, starting scores) for the setup preview. */
  app.get<{ Params: { id: string } }>("/api/scenarios/:id", opts, async (req, reply) => {
    try {
      return scenarios.load(req.params.id);
    } catch (e) {
      return reply.code(404).send({ error: (e as Error).message });
    }
  });

  /** Where players should point their browsers (setup step "Connect & bind"), and the HTTPS set-up. */
  app.get("/api/server-info", opts, async (): Promise<ServerInfo> => {
    const addr = app.server.address() as AddressInfo | null;
    const port = addr?.port ?? ctx.runtime.port;
    return { playerUrls: playerUrls(ctx.runtime.host, port, ctx.tls.info.enabled), port, tls: ctx.tls.info };
  });

  /** Default session configuration for the setup form (config/session.default.json, validated). */
  app.get("/api/config/session-defaults", opts, async () => {
    const file = path.join(ctx.runtime.configDir, "session.default.json");
    const raw = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    return SessionConfigSchema.parse(raw);
  });

  /** Sessions of both databases, newest first; `players` says which database each one is in. */
  app.get("/api/sessions", opts, async () => stores.listSessions());

  app.get<{ Params: { id: string } }>("/api/sessions/:id", opts, async (req, reply) => {
    const found = sessionOr404(stores, req.params.id, reply);
    if (!found) return;
    const events = found.store.listEvents(found.row.id);
    return {
      session: found.row,
      players: found.players,
      state: reduceEvents(events),
      eventCount: events.length,
      attached: hub.session?.sessionId === found.row.id,
    };
  });

  /** Event log of a session (demographic answers redacted), for replay and inspection. */
  app.get<{ Params: { id: string } }>("/api/sessions/:id/events", opts, async (req, reply) => {
    const found = sessionOr404(stores, req.params.id, reply);
    if (!found) return;
    return found.store.listEvents(req.params.id).map(redactEvent);
  });

  app.get<{ Params: { id: string }; Querystring: { afterId?: string; limit?: string } }>(
    "/api/sessions/:id/telemetry",
    opts,
    async (req, reply) => {
      const found = sessionOr404(stores, req.params.id, reply);
      if (!found) return;
      return found.store.listTelemetry(req.params.id, {
        afterId: Number(req.query.afterId ?? 0),
        limit: Math.min(Number(req.query.limit ?? 100_000), 1_000_000),
      });
    },
  );

  app.get<{ Params: { id: string } }>("/api/sessions/:id/scenario", opts, async (req, reply) => {
    const found = sessionOr404(stores, req.params.id, reply);
    if (!found) return;
    const row = found.row;
    const scenario = scenarios.load(row.scenario_id);
    return { scenario, hashMatches: scenario.hash === row.scenario_hash };
  });

  registerGdprApi(ctx, guard);
}
