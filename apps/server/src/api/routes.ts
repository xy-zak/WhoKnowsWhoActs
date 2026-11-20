import { existsSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { reduceEvents, type ServerInfo, SessionConfigSchema } from "@wkwa/shared";
import type { preHandlerAsyncHookHandler } from "fastify";
import type { AppContext } from "../app";
import { redactEvent } from "../net/hub";
import { harnessVersion } from "../runtime";
import { playerUrls } from "../tls";
import { createAudioService, registerAudioApi } from "./audioRoutes";
import { registerGdprApi } from "./gdprRoutes";
import { replyHttpErrors, requireSession, rethrowAs } from "./http";

/** REST API for the facilitator dashboard (every route but /api/health facilitator-only). */
export function registerApi(ctx: AppContext, requireFacilitator: preHandlerAsyncHookHandler) {
  const { app, stores, scenarios, hub } = ctx;
  replyHttpErrors(app);

  app.get("/api/health", async () => ({
    ok: true,
    harness: harnessVersion(),
    session: hub.session?.sessionId ?? null,
  }));

  const audio = createAudioService(ctx);
  // the facilitator check runs first on every route registered in here
  app.register(async (api) => {
    api.addHook("preHandler", requireFacilitator);

    api.get("/api/scenarios", async () => scenarios.list());

    /** Full scenario (board, all views, starting scores) for the setup preview. */
    api.get<{ Params: { id: string } }>("/api/scenarios/:id", async (req) =>
      rethrowAs(404, () => scenarios.load(req.params.id)),
    );

    /** Where players should point their browsers (setup step "Connect & bind"), and the HTTPS set-up. */
    api.get("/api/server-info", async (): Promise<ServerInfo> => {
      const addr = app.server.address() as AddressInfo | null;
      const port = addr?.port ?? ctx.runtime.port;
      const landing = ctx.runtime.landingPort;
      return {
        playerUrls: playerUrls(ctx.runtime.host, port, ctx.tls.info.enabled),
        landingUrls: landing === null ? [] : playerUrls(ctx.runtime.host, landing, false),
        port,
        tls: ctx.tls.info,
      };
    });

    /** Default session configuration for the setup form (config/session.default.json, validated). */
    api.get("/api/config/session-defaults", async () => {
      const file = path.join(ctx.runtime.configDir, "session.default.json");
      const raw = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
      return SessionConfigSchema.parse(raw);
    });

    /** Sessions of both databases, newest first; `players` says which database each one is in. */
    api.get("/api/sessions", async () => stores.listSessions());

    api.get<{ Params: { id: string } }>("/api/sessions/:id", async (req) => {
      const found = requireSession(stores, req.params.id);
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
    api.get<{ Params: { id: string } }>("/api/sessions/:id/events", async (req) => {
      const found = requireSession(stores, req.params.id);
      return found.store.listEvents(req.params.id).map(redactEvent);
    });

    api.get<{ Params: { id: string }; Querystring: { afterId?: string; limit?: string } }>(
      "/api/sessions/:id/telemetry",
      async (req) => {
        const found = requireSession(stores, req.params.id);
        return found.store.listTelemetry(req.params.id, {
          afterId: Number(req.query.afterId ?? 0),
          limit: Math.min(Number(req.query.limit ?? 100_000), 1_000_000),
        });
      },
    );

    api.get<{ Params: { id: string } }>("/api/sessions/:id/scenario", async (req) => {
      const found = requireSession(stores, req.params.id);
      const row = found.row;
      const scenario = scenarios.load(row.scenario_id);
      return { scenario, hashMatches: scenario.hash === row.scenario_hash };
    });

    registerGdprApi(api, ctx, audio.sessionGuard);
    registerAudioApi(api, ctx, audio.service);
  });
}
