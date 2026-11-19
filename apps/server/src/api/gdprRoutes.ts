import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../app";
import { loadOnboardingContent } from "../content";
import { PersonalDataMap, parseCodeOrThrow } from "../db/personalData";
import { exportsDirFor } from "../db/stores";
import { exportSession } from "../gdpr/exporter";
import { cardSeats, keySheetHtml, takedownCardPdf } from "../gdpr/print";
import type { SessionGuard, Verdict } from "../session/sessionGuard";
import { sessionOr404 } from "./sessionLookup";

type Guard = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

/**
 * Export, erasure, anonymisation and print routes (facilitator-only).
 * Session routes work on whichever database holds the session; participant
 * look-up and erasure, key sheets and takedown cards exist only for the
 * participant database (simulated sessions have no participants).
 */
export function registerGdprApi(ctx: AppContext, guard: Guard, sessionGuard: SessionGuard) {
  const { app, store, stores, scenarios, runtime } = ctx;
  const opts = { preHandler: guard };
  /** The guard's answer: the value, or its refusal (409 and why). */
  const render = <T>(reply: FastifyReply, v: Verdict<T>) =>
    v.ok ? v.value : reply.code(v.status).send({ error: v.message });
  /** Participant look-up and erasure: the participant database only. */
  const participants = new PersonalDataMap(store);

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
   * Refused while the session is attached and still running (lobby, onboarding or rounds), or busy
   * (an attribution queued or running, an audio export being written); see SessionGuard.
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
      const v = sessionGuard.deleteSession(id, () =>
        new PersonalDataMap(found.store).deleteSession(id, {
          exportsDir: exportsDirFor(runtime.exportsDir, found.players),
          deleteExports: req.body?.deleteExports === true,
          note: req.body?.note ?? "",
        }),
      );
      if (v.ok)
        ctx.log.info({ rows: v.value.rows, exportsDeleted: v.value.exportsDeleted }, "session deleted");
      return render(reply, v);
    },
  );

  app.get("/api/session-deletions", opts, async () =>
    stores.collect((s) => new PersonalDataMap(s).sessionDeletions()),
  );

  app.get<{ Params: { code: string } }>("/api/participants/:code", opts, async (req, reply) => {
    try {
      return participants.lookup(req.params.code);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  /**
   * Erase a participant. The body must repeat the code (typed again by the facilitator).
   * Refused while the code is in the running attached session, or while a session it occurs in is busy.
   */
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
      const v = sessionGuard.eraseParticipant(
        code,
        () => participants.lookup(code).occurrences.map((o) => o.sessionId),
        () => participants.erase(code, req.body?.note ?? ""),
      );
      if (v.ok)
        ctx.log.info({ sessions: v.value.occurrences.length, rows: v.value.rows }, "participant erased");
      return render(reply, v);
    },
  );

  app.get("/api/erasures", opts, async () => participants.erasures());
  app.get("/api/exports", opts, async () =>
    stores.collect((s) => s.listExports()).sort((a, b) => b.createdWall.localeCompare(a.createdWall)),
  );
}
