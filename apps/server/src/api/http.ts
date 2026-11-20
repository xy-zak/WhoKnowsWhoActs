import type { FastifyInstance } from "fastify";
import type { SessionStores } from "../db/stores";
import type { Verdict } from "../session/sessionGuard";

/** A refused request: the API answers `statusCode` with `{ error: message }`. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

/** Answer HttpErrors with `{ error }`; anything else goes to Fastify's default handler. */
export function replyHttpErrors(app: FastifyInstance) {
  app.setErrorHandler((e, _req, reply) => {
    if (e instanceof HttpError) return reply.code(e.statusCode).send({ error: e.message });
    throw e;
  });
}

/** A guard refusal as an HttpError; the value otherwise. */
export function orThrow<T>(v: Verdict<T>): T {
  if (!v.ok) throw new HttpError(v.status, v.message);
  return v.value;
}

/** The result of `fn`, or its error's message with `status`. */
export async function rethrowAs<T>(status: number, fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw new HttpError(status, (e as Error).message);
  }
}

/** The session `id` in whichever database holds it (404 if none); `participants` refuses simulated ones (400). */
export function requireSession(stores: SessionStores, id: string, opts: { participants?: string } = {}) {
  const found = stores.find(id);
  if (!found) throw new HttpError(404, "Unknown session");
  if (opts.participants && found.players === "simulated") throw new HttpError(400, opts.participants);
  return found;
}
