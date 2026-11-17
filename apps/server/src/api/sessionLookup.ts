import type { FastifyReply } from "fastify";
import type { SessionStores } from "../db/stores";

/** The session `id` in whichever database holds it, or a 404 reply (then null). */
export function sessionOr404(stores: SessionStores, id: string, reply: FastifyReply) {
  const found = stores.find(id);
  if (!found) reply.code(404).send({ error: "Unknown session" });
  return found;
}
