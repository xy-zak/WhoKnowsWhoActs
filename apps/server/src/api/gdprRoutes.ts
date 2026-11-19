import type { AppContext } from "../app";
import { loadOnboardingContent } from "../content";
import { PersonalDataMap, parseCodeOrThrow } from "../db/personalData";
import { exportsDirFor } from "../db/stores";
import { exportSession } from "../gdpr/exporter";
import { cardSeats, keySheetHtml, takedownCardPdf } from "../gdpr/print";
import type { SessionGuard } from "../session/sessionGuard";
import { type Guard, HttpError, orThrow, requireSession, rethrowAs } from "./http";

/**
 * Export, erasure, anonymisation and print routes (facilitator-only).
 * Session routes work on whichever database holds the session; participant
 * look-up and erasure, key sheets and takedown cards exist only for the
 * participant database (simulated sessions have no participants).
 */
export function registerGdprApi(ctx: AppContext, guard: Guard, sessionGuard: SessionGuard) {
  const { app, store, stores, scenarios, runtime } = ctx;
  const opts = { preHandler: guard };
  /** Participant look-up and erasure: the participant database only. */
  const participants = new PersonalDataMap(store);

  const exportDeps = (f: ReturnType<typeof requireSession>) => ({
    store: f.store,
    scenarios,
    exportsDir: exportsDirFor(runtime.exportsDir, f.players),
  });
  /** Key sheets and takedown cards only exist for sessions with participants. */
  const participantSession = (id: string) =>
    requireSession(stores, id, {
      participants: "Simulated sessions have no participants: no key sheet or takedown cards.",
    });

  app.post<{ Params: { id: string } }>("/api/sessions/:id/export", opts, async (req) =>
    exportSession(exportDeps(requireSession(stores, req.params.id)), req.params.id, "standard"),
  );

  app.post<{ Params: { id: string } }>("/api/sessions/:id/anonymise", opts, async (req) =>
    exportSession(exportDeps(requireSession(stores, req.params.id)), req.params.id, "anonymised"),
  );

  app.get<{ Params: { id: string } }>("/api/sessions/:id/print/keysheet", opts, async (req, reply) => {
    participantSession(req.params.id);
    const study = loadOnboardingContent(runtime.configDir).study;
    reply.type("text/html").send(keySheetHtml(store, req.params.id, study));
  });

  /** Seats that have a takedown card (i.e. a participant code). */
  app.get<{ Params: { id: string } }>("/api/sessions/:id/cards", opts, async (req) => {
    participantSession(req.params.id);
    return { seats: cardSeats(store, req.params.id) };
  });

  /** One takedown card as a PDF (A6, JetBrains Mono). */
  app.get<{ Params: { id: string; seat: string } }>(
    "/api/sessions/:id/cards/:seat",
    opts,
    async (req, reply) => {
      participantSession(req.params.id);
      const seat = Number(req.params.seat);
      const study = loadOnboardingContent(runtime.configDir).study;
      const pdf = await rethrowAs(404, () => takedownCardPdf(store, req.params.id, seat, study));
      reply
        .type("application/pdf")
        .header(
          "Content-Disposition",
          `attachment; filename="takedown-card-${req.params.id}-seat${seat}.pdf"`,
        )
        .send(pdf);
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
    async (req) => {
      const id = req.params.id;
      const found = requireSession(stores, id);
      if ((req.body?.confirm ?? "").trim() !== id)
        throw new HttpError(400, "Confirmation does not match the session id");
      const r = orThrow(
        sessionGuard.deleteSession(id, () =>
          new PersonalDataMap(found.store).deleteSession(id, {
            exportsDir: exportsDirFor(runtime.exportsDir, found.players),
            deleteExports: req.body?.deleteExports === true,
            note: req.body?.note ?? "",
          }),
        ),
      );
      ctx.log.info({ rows: r.rows, exportsDeleted: r.exportsDeleted }, "session deleted");
      return r;
    },
  );

  app.get("/api/session-deletions", opts, async () =>
    stores.collect((s) => new PersonalDataMap(s).sessionDeletions()),
  );

  app.get<{ Params: { code: string } }>("/api/participants/:code", opts, async (req) =>
    rethrowAs(400, () => participants.lookup(req.params.code)),
  );

  /**
   * Erase a participant. The body must repeat the code (typed again by the facilitator).
   * Refused while the code is in the running attached session, or while a session it occurs in is busy.
   */
  app.post<{ Params: { code: string }; Body: { confirm?: string; note?: string } }>(
    "/api/participants/:code/erase",
    opts,
    async (req) => {
      const code = await rethrowAs(400, () => parseCodeOrThrow(req.params.code));
      let confirm: string | null = null;
      try {
        confirm = parseCodeOrThrow(req.body?.confirm ?? "");
      } catch {}
      if (confirm !== code) throw new HttpError(400, "Confirmation does not match the code");
      const r = orThrow(
        sessionGuard.eraseParticipant(
          code,
          () => participants.lookup(code).occurrences.map((o) => o.sessionId),
          () => participants.erase(code, req.body?.note ?? ""),
        ),
      );
      ctx.log.info({ sessions: r.occurrences.length, rows: r.rows }, "participant erased");
      return r;
    },
  );

  app.get("/api/erasures", opts, async () => participants.erasures());
  app.get("/api/exports", opts, async () =>
    stores.collect((s) => s.listExports()).sort((a, b) => b.createdWall.localeCompare(a.createdWall)),
  );
}
