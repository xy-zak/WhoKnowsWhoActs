import { existsSync } from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import { JOINABLE_PHASES, type LandingStatus, type TlsInfo } from "@wkwa/shared";
import Fastify, { type FastifyInstance } from "fastify";
import type { Hub } from "./net/hub";
import { baseUrl } from "./tls";

/**
 * The welcome page (LANDING_PORT, plain HTTP): the address participants open first, before any
 * session and before their browser has accepted the certificate. It shows the title and a welcome
 * text, and, while a session with real participants is open, a "Join live session" button to the
 * game page (HTTPS), with a line on the browser warning they will see there.
 *
 * Plain HTTP on purpose: it is the one page that must open without a certificate warning, so it
 * can explain the warning before it appears. It serves only that page, its scripts and styles
 * (`/assets/`), and its status (`GET /api/landing`), which says only whether a session takes
 * players: no session id, no names, nothing a participant typed. Every other path goes to `/`.
 */

/** The headers every response of the game server and the welcome page carries. */
export function secureHeaders(app: FastifyInstance) {
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Cache-Control", "no-store");
    return payload;
  });
}

/** What the welcome page shows, for a browser that will join at `joinUrl`. */
export function landingStatus(hub: Hub, tls: TlsInfo, joinUrl: string): LandingStatus {
  const s = hub.session;
  return {
    live: s !== null && !s.simulated && JOINABLE_PHASES.has(s.state.phase),
    joinUrl,
    certificate: !tls.enabled ? "none" : tls.mode === "auto" ? "self-signed" : "own",
    fingerprintSha256: tls.fingerprintSha256,
  };
}

const HOST_NAME = /^[A-Za-z0-9.-]+$/;
const IPV6_HOST = /^\[[0-9A-Fa-f:.]+\]$/;

/** The host of a Host header (port dropped); null if missing or not a plain host name or address. */
function hostOf(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  const h = hostHeader.trim();
  const host = h.startsWith("[") ? h.slice(0, h.indexOf("]") + 1) : h.split(":")[0]!;
  return host && (HOST_NAME.test(host) || IPV6_HOST.test(host)) ? host : null;
}

/**
 * Where "Join live session" goes: the game page on the host the browser used for the welcome page
 * (its Host header, port dropped), on the game server's port and scheme. Falls back to `fallback`
 * (e.g. the LAN address) when the Host header is missing or not a plain host name or address.
 */
export function joinUrlFor(
  hostHeader: string | undefined,
  gamePort: number,
  tlsEnabled: boolean,
  fallback: string,
): string {
  const host = hostOf(hostHeader);
  return host ? `${baseUrl(host, gamePort, tlsEnabled)}/` : fallback;
}

export async function startLandingServer(opts: {
  host: string;
  port: number;
  /** The game server's port (HTTPS, or HTTP with WKWA_TLS=off). */
  gamePort: number;
  tls: TlsInfo;
  hub: Hub;
  /** The built client (apps/client/dist): landing.html and its assets. */
  clientDist: string;
  /** Join URL when the Host header cannot be used (the first LAN address). */
  fallbackJoinUrl: string;
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, trustProxy: false });
  secureHeaders(app);
  const built = existsSync(path.join(opts.clientDist, "landing.html"));
  if (built) {
    await app.register(fastifyStatic, {
      root: path.join(opts.clientDist, "assets"),
      prefix: "/assets/",
      index: false,
      wildcard: true,
    });
    // the page itself, from the client's root (sendFile resolves against the assets root otherwise)
    app.get("/", (_req, reply) => reply.sendFile("landing.html", opts.clientDist));
  } else {
    app.get("/", (_req, reply) =>
      reply
        .type("text/plain; charset=utf-8")
        .send(
          "Who Knows, Who Acts?\n\nThe welcome page is not built yet: run `npm run build`, then restart.",
        ),
    );
  }
  app.get(
    "/api/landing",
    async (req): Promise<LandingStatus> =>
      landingStatus(
        opts.hub,
        opts.tls,
        joinUrlFor(req.headers.host, opts.gamePort, opts.tls.enabled, opts.fallbackJoinUrl),
      ),
  );
  app.setNotFoundHandler((_req, reply) => reply.redirect("/", 302));
  await app.listen({ host: opts.host, port: opts.port });
  return app;
}
