import { SeatSchema } from "@wkwa/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../app";
import { AudioJobRunner, runInWorker, type TaskRunner } from "../audio/jobs";
import { AudioRequestError, AudioService } from "../audio/service";
import { exportsDirFor } from "../db/stores";
import { isLoopback } from "../net/hub";
import { sessionOr404 } from "./sessionLookup";

type Guard = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

const Note = z
  .string()
  .max(500)
  .describe("Researcher's note, e.g. the retention rule applied (no personal data)");

export const AttributionRequestSchema = z
  .object({
    options: z
      .record(z.string(), z.number())
      .optional()
      .describe(
        "Engine parameter overrides (AttributionOptions in audio/attribution/types.ts); omit for the defaults",
      ),
  })
  .strict()
  .describe("Start a speaker attribution of the session");

export const AudioExportRequestSchema = z
  .object({
    sessionId: z
      .string()
      .optional()
      .describe("The session being exported; must match the URL when given (guards against a wrong tab)"),
    seats: z
      .array(SeatSchema)
      .min(1)
      .max(16)
      .optional()
      .describe("Seats to export (default: every seat with audio); one seat for a single download"),
    kind: z
      .enum(["raw", "clean", "both"])
      .describe("'raw' = the seat's microphone as recorded, 'clean' = other seats attenuated, 'both'"),
    note: Note.optional(),
  })
  .strict()
  .describe("Export audio: write per-seat WAV files to the exports folder (registered)");

export const AudioDeleteRequestSchema = z
  .object({
    confirm: z.string().max(100).describe("The session id, typed again by the facilitator"),
    scope: z
      .enum(["raw", "all"])
      .describe(
        "'raw' = delete the raw and cleaned audio, keep speech segments and metadata; 'all' = every audio row and file",
      ),
    note: Note.optional(),
  })
  .strict()
  .describe("Delete a session's audio (irreversible)");

function badRequest(reply: FastifyReply, error: z.ZodError) {
  return reply.code(400).send({
    error: "Invalid request",
    issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
  });
}

/**
 * Audio routes of the DATABASE tab (facilitator-only, like the GDPR routes).
 * Audio lives only in the participant database; simulated sessions have none.
 * Audio content leaves the server only through POST …/audio/export.
 */
export function registerAudioApi(ctx: AppContext, guard: Guard, opts: { runTask?: TaskRunner } = {}) {
  const { app, store, stores, runtime, hub } = ctx;
  const runner = new AudioJobRunner(store, ctx.log);
  runner.recoverStale();
  const service = new AudioService({
    store,
    hub,
    exportsDir: exportsDirFor(runtime.exportsDir, "real"),
    runner,
    runTask: opts.runTask ?? runInWorker,
    log: ctx.log,
  });
  app.addHook("onClose", async () => {
    await runner.close();
  });
  const route = { preHandler: guard };

  /** Run `fn`, mapping refusals to their status codes. */
  const handle = async <T>(reply: FastifyReply, fn: () => T | Promise<T>) => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof AudioRequestError) return reply.code(e.statusCode).send({ error: e.message });
      throw e;
    }
  };
  /** The session in the participant database, or 404 / 400 (simulated sessions have no audio). */
  const participantSession = (id: string, reply: FastifyReply) => {
    const found = sessionOr404(stores, id, reply);
    if (!found) return null;
    if (found.players === "simulated") {
      reply.code(400).send({ error: "Simulated sessions have no audio." });
      return null;
    }
    return found;
  };

  /** Tracks (no keys, no file names), cleaned tracks, jobs, deletion register, audio exports, per-seat totals. */
  app.get<{ Params: { id: string } }>("/api/sessions/:id/audio", route, async (req, reply) => {
    const found = sessionOr404(stores, req.params.id, reply);
    if (!found) return;
    if (found.players === "simulated")
      return {
        sessionId: req.params.id,
        tracks: [],
        derivatives: [],
        jobs: [],
        deletions: [],
        seats: [],
        attribution: null,
        audioExports: [],
        running: false,
      };
    return handle(reply, () => service.summary(req.params.id));
  });

  /** Queue a speaker attribution (post-session). 202 + the job; poll GET /api/audio/jobs/:jobId. */
  app.post<{ Params: { id: string } }>("/api/sessions/:id/audio/attribution", route, async (req, reply) => {
    if (!participantSession(req.params.id, reply)) return;
    const body = AttributionRequestSchema.safeParse(req.body ?? {});
    if (!body.success) return badRequest(reply, body.error);
    return handle(reply, () => {
      const job = service.startAttribution(
        req.params.id,
        body.data.options ? { options: body.data.options } : {},
      );
      return reply.code(202).send(job);
    });
  });

  /** Job status: progress while running, the attribution summary once done, the error if failed. */
  app.get<{ Params: { jobId: string } }>("/api/audio/jobs/:jobId", route, async (req, reply) =>
    handle(reply, () => service.job(req.params.jobId)),
  );

  /** Who spoke when (JSON, timing only). Empty until an attribution has been run. */
  app.get<{ Params: { id: string } }>("/api/sessions/:id/audio/segments", route, async (req, reply) => {
    if (!participantSession(req.params.id, reply)) return;
    return handle(reply, () => service.speechSegments(req.params.id));
  });

  /** Export audio: the only way audio content leaves the encrypted store. Writes WAVs + manifest, registered. */
  app.post<{ Params: { id: string } }>("/api/sessions/:id/audio/export", route, async (req, reply) => {
    if (!participantSession(req.params.id, reply)) return;
    const body = AudioExportRequestSchema.safeParse(req.body ?? {});
    if (!body.success) return badRequest(reply, body.error);
    if (body.data.sessionId !== undefined && body.data.sessionId !== req.params.id)
      return reply.code(400).send({ error: "sessionId in the body does not match the URL" });
    const requestedBy = isLoopback(req.socket.remoteAddress)
      ? "facilitator (this computer)"
      : "facilitator (ADMIN_TOKEN)";
    return handle(reply, () =>
      service.exportAudio(req.params.id, {
        kind: body.data.kind,
        ...(body.data.seats ? { seats: body.data.seats } : {}),
        ...(body.data.note !== undefined ? { note: body.data.note } : {}),
        requestedBy,
      }),
    );
  });

  /** Delete raw audio (scope raw) or every audio row and file (scope all). The body must repeat the session id. */
  app.post<{ Params: { id: string } }>("/api/sessions/:id/audio/delete", route, async (req, reply) => {
    if (!participantSession(req.params.id, reply)) return;
    const body = AudioDeleteRequestSchema.safeParse(req.body ?? {});
    if (!body.success) return badRequest(reply, body.error);
    return handle(reply, () => {
      const r = service.deleteAudio(req.params.id, body.data);
      ctx.log.info({ scope: r.scope, counts: r.counts }, "session audio deleted");
      return r;
    });
  });
}
