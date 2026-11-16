import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppContext } from "../app";

type Guard = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** Export, erasure, anonymisation and print routes (filled in by the GDPR tooling milestone). */
export function registerGdprApi(_ctx: AppContext, _guard: Guard) {}
