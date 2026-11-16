import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../app";
import { loadOnboardingContent } from "../content";
import { eraseParticipant, listErasures, lookupParticipant, parseCodeOrThrow } from "../gdpr/erase";
import { exportSession, listExports } from "../gdpr/exporter";
import { keySheetHtml, takedownCardsHtml } from "../gdpr/print";

type Guard = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** Export, erasure, anonymisation and print routes (facilitator-only). */
export function registerGdprApi(ctx: AppContext, guard: Guard) {
  const { app, store, scenarios, runtime, hub } = ctx;
  const opts = { preHandler: guard };
  const deps = { store, scenarios, exportsDir: runtime.exportsDir };

  const sessionOr404 = (id: string, reply: FastifyReply) => {
    if (!store.getSession(id)) {
      reply.code(404).send({ error: "Unknown session" });
      return false;
    }
    return true;
  };

  app.post<{ Params: { id: string } }>("/api/sessions/:id/export", opts, async (req, reply) => {
    if (!sessionOr404(req.params.id, reply)) return;
    return exportSession(deps, req.params.id, "standard");
  });

  app.post<{ Params: { id: string } }>("/api/sessions/:id/anonymise", opts, async (req, reply) => {
    if (!sessionOr404(req.params.id, reply)) return;
    return exportSession(deps, req.params.id, "anonymised");
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id/print/keysheet", opts, async (req, reply) => {
    if (!sessionOr404(req.params.id, reply)) return;
    const study = loadOnboardingContent(runtime.configDir).study;
    reply.type("text/html").send(keySheetHtml(store, req.params.id, study));
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id/print/cards", opts, async (req, reply) => {
    if (!sessionOr404(req.params.id, reply)) return;
    const study = loadOnboardingContent(runtime.configDir).study;
    reply.type("text/html").send(takedownCardsHtml(store, req.params.id, study));
  });

  app.get<{ Params: { code: string } }>("/api/participants/:code", opts, async (req, reply) => {
    try {
      return lookupParticipant(store, req.params.code);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  /** Erase a participant. The body must repeat the code (typed again by the facilitator). */
  app.post<{ Params: { code: string }; Body: { confirm?: string; note?: string } }>(
    "/api/participants/:code/erase",
    opts,
    async (req, reply) => {
      let code: string;
      try {
        code = parseCodeOrThrow(req.params.code);
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
      let confirm: string | null = null;
      try {
        confirm = parseCodeOrThrow(req.body?.confirm ?? "");
      } catch {}
      if (confirm !== code) return reply.code(400).send({ error: "Confirmation does not match the code" });
      const active = hub.session;
      const attached =
        active?.state.seats && Object.values(active.state.seats).some((s) => s.participantCode === code);
      if (attached && !active!.isFinal && active!.state.phase !== "game_complete") {
        return reply
          .code(409)
          .send({
            error: "This participant is in the running session. Withdraw them, end the session, then erase.",
          });
      }
      const result = eraseParticipant(store, code, req.body?.note ?? "");
      if (attached) hub.reloadActiveSession();
      ctx.log.info({ sessions: result.occurrences.length, rows: result.rows }, "participant erased");
      return result;
    },
  );

  app.get("/api/erasures", opts, async () => listErasures(store));
  app.get("/api/exports", opts, async () => listExports(store));
}
