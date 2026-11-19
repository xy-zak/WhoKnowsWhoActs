import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../app";
import type { AudioService } from "../audio/service";
import { loadOnboardingContent } from "../content";
import { exportsDirFor } from "../db/stores";
import { deleteSession, listSessionDeletions } from "../gdpr/deleteSession";
import { eraseParticipant, listErasures, lookupParticipant, parseCodeOrThrow } from "../gdpr/erase";
import { exportSession, listExports } from "../gdpr/exporter";
import { cardSeats, keySheetHtml, takedownCardPdf } from "../gdpr/print";
import { sessionOr404 } from "./sessionLookup";

type Guard = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

/**
 * Export, erasure, anonymisation and print routes (facilitator-only).
 * Session routes work on whichever database holds the session; participant
 * look-up and erasure, key sheets and takedown cards exist only for the
 * participant database (simulated sessions have no participants).
 */
export function registerGdprApi(ctx: AppContext, guard: Guard, audio: Pick<AudioService, "busyReason">) {
  const { app, store, stores, scenarios, runtime, hub } = ctx;
  const opts = { preHandler: guard };

  type Found = NonNullable<ReturnType<typeof sessionOr404>>;
  const exportDeps = (f: Found) => ({
    store: f.store,
    scenarios,
    exportsDir: exportsDirFor(runtime.exportsDir, f.players),
  });
  /** Key sheets and takedown cards only exist for sessions with participants. */
  const participantSessionOr4xx = (id: string, reply: FastifyReply): Found | null => {
    const found = sessionOr404(stores, id, reply);
    if (found?.players === "simulated") {
      reply
        .code(400)
        .send({ error: "Simulated sessions have no participants: no key sheet or takedown cards." });
      return null;
    }
    return found;
  };

  app.post<{ Params: { id: string } }>("/api/sessions/:id/export", opts, async (req, reply) => {
    const found = sessionOr404(stores, req.params.id, reply);
    if (!found) return;
    return exportSession(exportDeps(found), req.params.id, "standard");
  });

  app.post<{ Params: { id: string } }>("/api/sessions/:id/anonymise", opts, async (req, reply) => {
    const found = sessionOr404(stores, req.params.id, reply);
    if (!found) return;
    return exportSession(exportDeps(found), req.params.id, "anonymised");
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id/print/keysheet", opts, async (req, reply) => {
    if (!participantSessionOr4xx(req.params.id, reply)) return;
    const study = loadOnboardingContent(runtime.configDir).study;
    reply.type("text/html").send(keySheetHtml(store, req.params.id, study));
  });

  /** Seats that have a takedown card (i.e. a participant code). */
  app.get<{ Params: { id: string } }>("/api/sessions/:id/cards", opts, async (req, reply) => {
    if (!participantSessionOr4xx(req.params.id, reply)) return;
    return { seats: cardSeats(store, req.params.id) };
  });

  /** One takedown card as a PDF (A6, JetBrains Mono). */
  app.get<{ Params: { id: string; seat: string } }>(
    "/api/sessions/:id/cards/:seat",
    opts,
    async (req, reply) => {
      if (!participantSessionOr4xx(req.params.id, reply)) return;
      const seat = Number(req.params.seat);
      const study = loadOnboardingContent(runtime.configDir).study;
      try {
        const pdf = await takedownCardPdf(store, req.params.id, seat, study);
        reply
          .type("application/pdf")
          .header(
            "Content-Disposition",
            `attachment; filename="takedown-card-${req.params.id}-seat${seat}.pdf"`,
          )
          .send(pdf);
      } catch (e) {
        reply.code(404).send({ error: (e as Error).message });
      }
    },
  );

  /**
   * Delete an entire session (irreversible). The body must repeat the session id.
   * Refused while the session is attached and still running (lobby, onboarding or rounds).
   */
  app.post<{ Params: { id: string }; Body: { confirm?: string; deleteExports?: boolean; note?: string } }>(
    "/api/sessions/:id/delete",
    opts,
    async (req, reply) => {
      const id = req.params.id;
      const found = sessionOr404(stores, id, reply);
      if (!found) return;
      if ((req.body?.confirm ?? "").trim() !== id) {
        return reply.code(400).send({ error: "Confirmation does not match the session id" });
      }
      const active = hub.session;
      if (active?.sessionId === id && !active.isFinal && active.state.phase !== "game_complete") {
        return reply
          .code(409)
          .send({ error: "This session is still running. Close or abort it first, then delete it." });
      }
      const busy = audio.busyReason(id);
      if (busy) return reply.code(409).send({ error: `${busy}: delete the session when it is done.` });
      hub.release(id);
      const r = deleteSession(found.store, id, {
        exportsDir: exportsDirFor(runtime.exportsDir, found.players),
        deleteExports: req.body?.deleteExports === true,
        note: req.body?.note ?? "",
      });
      ctx.log.info({ rows: r.rows, exportsDeleted: r.exportsDeleted }, "session deleted");
      return r;
    },
  );

  app.get("/api/session-deletions", opts, async () => stores.collect(listSessionDeletions));

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
        active != null && Object.values(active.state.seats).some((s) => s.participantCode === code);
      if (attached && !active.isFinal && active.state.phase !== "game_complete") {
        return reply.code(409).send({
          error: "This participant is in the running session. Withdraw them, end the session, then erase.",
        });
      }
      for (const occ of lookupParticipant(store, code).occurrences) {
        const busy = audio.busyReason(occ.sessionId);
        if (busy)
          return reply
            .code(409)
            .send({ error: `${busy} (session ${occ.sessionId}): erase when it is done.` });
      }
      const result = eraseParticipant(store, code, req.body?.note ?? "");
      if (attached) hub.reloadActiveSession();
      ctx.log.info({ sessions: result.occurrences.length, rows: result.rows }, "participant erased");
      return result;
    },
  );

  app.get("/api/erasures", opts, async () => listErasures(store));
  app.get("/api/exports", opts, async () =>
    stores.collect(listExports).sort((a, b) => b.createdWall.localeCompare(a.createdWall)),
  );
}
