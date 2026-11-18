import { createPrivateKey, X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { generate } from "selfsigned";
import type { RuntimeOptions } from "./runtime";

/**
 * HTTPS for the LAN.
 *
 * Browsers only allow the microphone (getUserMedia) in a secure context:
 * HTTPS, or http://localhost. Player PCs open the server by its LAN address,
 * so the server speaks HTTPS. Without an internet connection there is no
 * publicly trusted certificate, so the server makes its own self-signed one
 * (WKWA_TLS=auto, the default). Each participant's browser shows a warning
 * once; the facilitator can compare the SHA-256 fingerprint shown in setup
 * step 07 with the one the browser shows.
 *
 * The certificate is kept in data/tls/ and reused across restarts, so the
 * exceptions browsers have accepted stay valid. It is only made again when
 * an address or host name of this laptop is missing from it (the laptop moved
 * to another network), or when it expires within 30 days.
 *
 * TLS_CERT + TLS_KEY (a certificate of your own) take precedence ("provided").
 */

export type TlsMode = "auto" | "provided" | "off";

/** What GET /api/server-info reports under `tls`. */
export interface TlsInfo {
  enabled: boolean;
  mode: TlsMode;
  /** SHA-256 fingerprint of the certificate, as browsers show it (`AB:CD:…`, 32 pairs). */
  fingerprintSha256: string | null;
  /** Names the certificate is valid for, e.g. `DNS:localhost`, `IP:192.168.1.10`. */
  sans: string[];
  /** Expiry of the certificate (ISO 8601). */
  expires: string | null;
}

export interface TlsState {
  info: TlsInfo;
  /** Key material for node:https; null when TLS is off. */
  https: { cert: Buffer; key: Buffer } | null;
  /** The certificate file in use (for the start-up banner); null when off. */
  certFile: string | null;
  /** WKWA_TLS=auto only: whether the self-signed certificate was created, reused or made again. */
  outcome: SelfSignedOutcome | null;
}

export const TLS_DIR = "tls";
export const CERT_FILE = "self-signed-cert.pem";
export const KEY_FILE = "self-signed-key.pem";
export const META_FILE = "meta.json";
/** Validity of a generated certificate (the maximum browsers accept for public certificates is 398). */
export const VALIDITY_DAYS = 397;
/** A certificate that expires sooner than this is made again at start-up. */
export const RENEW_WITHIN_DAYS = 30;
/** notBefore is set this far in the past, so a participant PC whose clock is a little behind accepts it. */
const BACKDATE_MS = 24 * 3600_000;
const DAY_MS = 24 * 3600_000;

export const TLS_OFF: TlsInfo = {
  enabled: false,
  mode: "off",
  fingerprintSha256: null,
  sans: [],
  expires: null,
};

/** The facts about this machine the certificate's names come from (injectable for tests). */
export interface HostFacts {
  hostname: string;
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
}

export function currentHost(): HostFacts {
  return { hostname: os.hostname(), interfaces: os.networkInterfaces() };
}

/** Non-internal IPv4 addresses with their interface names: where player PCs reach this laptop. */
export function lanIPv4(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): Array<{ address: string; iface: string }> {
  const out: Array<{ address: string; iface: string }> = [];
  for (const [iface, list] of Object.entries(interfaces)) {
    for (const a of list ?? []) {
      if (a.family === "IPv4" && !a.internal) out.push({ address: a.address, iface });
    }
  }
  return out;
}

/** `[::1]` for an IPv6 address, the address or name itself otherwise (for URLs). */
export function urlHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/**
 * Where player PCs open the server: one URL per LAN interface when bound to
 * every interface (0.0.0.0 / ::), else the configured HOST. Used by the
 * start-up banner and GET /api/server-info, so both always agree.
 */
export function playerUrls(
  bindHost: string,
  port: number,
  tlsEnabled: boolean,
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): Array<{ url: string; iface: string }> {
  const proto = tlsEnabled ? "https" : "http";
  if (bindHost === "0.0.0.0" || bindHost === "::")
    return lanIPv4(interfaces).map((a) => ({ url: `${proto}://${a.address}:${port}/`, iface: a.iface }));
  return [{ url: `${proto}://${urlHost(bindHost)}:${port}/`, iface: "configured host" }];
}

const DNS_NAME = /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*$/;

/** Canonical text of an IP address (`0:0:0:0:0:0:0:1` → `::1`). */
function canonicalIp(ip: string): string {
  if (!ip.includes(":")) return ip;
  try {
    return new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  } catch {
    return ip.toLowerCase();
  }
}

/**
 * Every name the certificate must cover on this machine: `localhost`, the host
 * name (and `<name>.local` for mDNS), loopback, and every LAN IPv4 address.
 */
export function wantedSans(host: HostFacts): string[] {
  const dns = ["localhost"];
  const name = host.hostname.trim().toLowerCase().replace(/\.$/, "");
  if (name && DNS_NAME.test(name)) {
    const short = name.split(".")[0]!;
    dns.push(name, short, `${short}.local`);
  }
  const ips = ["127.0.0.1", "::1", ...lanIPv4(host.interfaces).map((a) => a.address)];
  return [...new Set([...dns.map((d) => `DNS:${d}`), ...ips.map((ip) => `IP:${canonicalIp(ip)}`)])];
}

/** SANs, expiry and SHA-256 fingerprint of a PEM certificate (the first one, if it holds a chain). */
export function certificateFacts(certPem: string | Buffer): {
  x509: X509Certificate;
  sans: string[];
  validFrom: Date;
  expires: Date;
  fingerprintSha256: string;
} {
  const x509 = new X509Certificate(certPem);
  const sans = (x509.subjectAltName ?? "")
    .split(", ")
    .filter(Boolean)
    .map((s) => {
      if (s.startsWith("DNS:")) return `DNS:${s.slice(4).toLowerCase()}`;
      if (s.startsWith("IP Address:")) return `IP:${canonicalIp(s.slice(11))}`;
      return s;
    });
  return {
    x509,
    sans,
    validFrom: new Date(x509.validFrom),
    expires: new Date(x509.validTo),
    fingerprintSha256: x509.fingerprint256,
  };
}

export interface SelfSignedMeta {
  sans: string[];
  created: string;
  expires: string;
  fingerprintSha256: string;
}

export type SelfSignedOutcome =
  | { action: "created" }
  | { action: "reused" }
  | { action: "regenerated"; reason: "names"; missing: string[] }
  | { action: "regenerated"; reason: "expiry"; expires: string }
  | { action: "regenerated"; reason: "not-yet-valid"; validFrom: string }
  | { action: "regenerated"; reason: "unreadable"; detail: string };

export interface SelfSigned {
  cert: string;
  key: string;
  meta: SelfSignedMeta;
  outcome: SelfSignedOutcome;
  certFile: string;
  keyFile: string;
}

/** Write via a temporary file and a rename, so a crash never leaves half a file. */
function writeAtomic(file: string, content: string, mode: number) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, file);
}

async function generateCertificate(sans: string[], now: Date): Promise<{ cert: string; key: string }> {
  const notBeforeDate = new Date(now.getTime() - BACKDATE_MS);
  const notAfterDate = new Date(notBeforeDate.getTime() + VALIDITY_DAYS * DAY_MS);
  const altNames = sans.map((s) =>
    s.startsWith("IP:") ? { type: 7 as const, ip: s.slice(3) } : { type: 2 as const, value: s.slice(4) },
  );
  const pems = await generate(
    [
      { name: "commonName", value: "Who Knows, Who Acts? LAN server" },
      { name: "organizationName", value: "Who Knows, Who Acts? (self-signed)" },
    ],
    {
      keyType: "ec",
      curve: "P-256",
      algorithm: "sha256",
      notBeforeDate,
      notAfterDate,
      extensions: [
        { name: "basicConstraints", cA: false, critical: true },
        { name: "keyUsage", digitalSignature: true, critical: true },
        { name: "extKeyUsage", serverAuth: true },
        { name: "subjectAltName", altNames },
      ],
    },
  );
  return { cert: pems.cert, key: pems.private };
}

/** Read the stored certificate and key; null if there is none, a string if it cannot be used. */
function readStored(certFile: string, keyFile: string) {
  const haveCert = existsSync(certFile);
  const haveKey = existsSync(keyFile);
  if (!haveCert && !haveKey) return null;
  if (!haveCert || !haveKey) return `${haveCert ? "the key" : "the certificate"} file is missing`;
  try {
    const cert = readFileSync(certFile, "utf8");
    const key = readFileSync(keyFile, "utf8");
    const facts = certificateFacts(cert);
    if (!facts.x509.checkPrivateKey(createPrivateKey(key)))
      return "the key does not belong to the certificate";
    return { cert, key, facts };
  } catch (e) {
    return `it cannot be read (${(e as Error).message})`;
  }
}

/**
 * The self-signed certificate in `dir` (data/tls/): reused when it still covers
 * every current name of this machine and does not expire within 30 days;
 * otherwise (or when there is none) a new one is made and stored.
 */
export async function ensureSelfSignedCert(
  dir: string,
  opts: { host?: HostFacts; now?: Date } = {},
): Promise<SelfSigned> {
  const now = opts.now ?? new Date();
  const wanted = wantedSans(opts.host ?? currentHost());
  const certFile = path.join(dir, CERT_FILE);
  const keyFile = path.join(dir, KEY_FILE);
  const metaFile = path.join(dir, META_FILE);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const stored = readStored(certFile, keyFile);
  let outcome: SelfSignedOutcome;
  // the names of the new certificate: the current ones, plus those of a still-usable old one,
  // so a laptop that moves between two networks settles on one certificate covering both
  let sans = wanted;
  if (stored === null) outcome = { action: "created" };
  else if (typeof stored === "string")
    outcome = { action: "regenerated", reason: "unreadable", detail: stored };
  else {
    const have = new Set(stored.facts.sans);
    const missing = wanted.filter((s) => !have.has(s));
    const { expires, validFrom } = stored.facts;
    const expiring = expires.getTime() - now.getTime() < RENEW_WITHIN_DAYS * DAY_MS;
    if (validFrom > now)
      outcome = { action: "regenerated", reason: "not-yet-valid", validFrom: validFrom.toISOString() };
    else if (expiring) outcome = { action: "regenerated", reason: "expiry", expires: expires.toISOString() };
    else if (missing.length > 0) {
      outcome = { action: "regenerated", reason: "names", missing };
      sans = [...new Set([...wanted, ...stored.facts.sans])];
    } else {
      const meta: SelfSignedMeta = {
        sans: stored.facts.sans,
        created: new Date(validFrom.getTime() + BACKDATE_MS).toISOString(),
        expires: expires.toISOString(),
        fingerprintSha256: stored.facts.fingerprintSha256,
      };
      // keep meta.json in step with the certificate (e.g. if it was deleted)
      let old: Partial<SelfSignedMeta> = {};
      try {
        old = JSON.parse(readFileSync(metaFile, "utf8")) ?? {};
      } catch {}
      if (old.fingerprintSha256 === meta.fingerprintSha256 && typeof old.created === "string")
        meta.created = old.created;
      else writeAtomic(metaFile, `${JSON.stringify(meta, null, 2)}\n`, 0o644);
      return { cert: stored.cert, key: stored.key, meta, outcome: { action: "reused" }, certFile, keyFile };
    }
  }

  const { cert, key } = await generateCertificate(sans, now);
  const facts = certificateFacts(cert);
  const meta: SelfSignedMeta = {
    sans: facts.sans,
    created: now.toISOString(),
    expires: facts.expires.toISOString(),
    fingerprintSha256: facts.fingerprintSha256,
  };
  // key first: a crash between the two writes leaves a mismatched pair, which is detected and made again
  writeAtomic(keyFile, key, 0o600);
  writeAtomic(certFile, cert, 0o644);
  writeAtomic(metaFile, `${JSON.stringify(meta, null, 2)}\n`, 0o644);
  return { cert, key, meta, outcome, certFile, keyFile };
}

/**
 * The TLS set-up of this run: TLS_CERT + TLS_KEY when both are set ("provided"),
 * else the self-signed certificate (WKWA_TLS=auto), else plain HTTP (WKWA_TLS=off).
 */
export async function resolveTls(
  runtime: Pick<RuntimeOptions, "tlsMode" | "tlsCert" | "tlsKey" | "dataDir">,
  opts: { host?: HostFacts; now?: Date } = {},
): Promise<TlsState> {
  if (runtime.tlsCert || runtime.tlsKey) {
    if (!runtime.tlsCert || !runtime.tlsKey)
      throw new Error(
        `Set both TLS_CERT and TLS_KEY, or neither: only ${runtime.tlsCert ? "TLS_CERT" : "TLS_KEY"} is set.`,
      );
    const cert = readFileSync(runtime.tlsCert);
    const key = readFileSync(runtime.tlsKey);
    const facts = certificateFacts(cert);
    let matches = false;
    try {
      matches = facts.x509.checkPrivateKey(createPrivateKey(key));
    } catch (e) {
      throw new Error(`TLS_KEY cannot be read (it must be an unencrypted PEM key): ${(e as Error).message}`);
    }
    if (!matches) throw new Error("TLS_KEY does not belong to the certificate in TLS_CERT.");
    return {
      info: {
        enabled: true,
        mode: "provided",
        fingerprintSha256: facts.fingerprintSha256,
        sans: facts.sans,
        expires: facts.expires.toISOString(),
      },
      https: { cert, key },
      certFile: runtime.tlsCert,
      outcome: null,
    };
  }
  if (runtime.tlsMode === "off") return { info: TLS_OFF, https: null, certFile: null, outcome: null };
  const ss = await ensureSelfSignedCert(path.join(runtime.dataDir, TLS_DIR), opts);
  return {
    info: {
      enabled: true,
      mode: "auto",
      fingerprintSha256: ss.meta.fingerprintSha256,
      sans: ss.meta.sans,
      expires: ss.meta.expires,
    },
    https: { cert: Buffer.from(ss.cert), key: Buffer.from(ss.key) },
    certFile: ss.certFile,
    outcome: ss.outcome,
  };
}

/** One line for the start-up banner on what happened to the self-signed certificate (may name addresses). */
export function describeOutcome(o: SelfSignedOutcome): string {
  switch (o.action) {
    case "created":
      return "created a new self-signed certificate (participants accept it once per browser)";
    case "reused":
      return "reusing the self-signed certificate (browsers that accepted it before still do)";
    case "regenerated":
      if (o.reason === "names")
        return `made a new self-signed certificate: the old one did not cover ${o.missing.map((s) => s.replace(/^\w+:/, "")).join(", ")}. Participants accept the warning again`;
      if (o.reason === "expiry")
        return `made a new self-signed certificate: the old one expires ${o.expires.slice(0, 10)}. Participants accept the warning again`;
      if (o.reason === "not-yet-valid")
        return `made a new self-signed certificate: the old one is only valid from ${o.validFrom.slice(0, 10)} (was this laptop's clock changed?). Participants accept the warning again`;
      return `made a new self-signed certificate: ${o.detail}`;
  }
}

/**
 * For the server log, which never names addresses or host names: what happened,
 * without the names that were missing.
 */
export function outcomeLogFields(o: SelfSignedOutcome): { certificate: string; reason?: string } {
  return o.action === "regenerated" ? { certificate: o.action, reason: o.reason } : { certificate: o.action };
}

const HOST_NAME = /^[A-Za-z0-9.-]+$/;
const IPV6_HOST = /^\[[0-9A-Fa-f:.]+\]$/;

/**
 * Where a plain-HTTP request should go: the same host (from the Host header,
 * port dropped) on the HTTPS port, same path and query. Null if the Host header
 * is missing or not a plain host name or address.
 */
export function redirectLocation(hostHeader: string | undefined, url: string | undefined, httpsPort: number) {
  if (!hostHeader) return null;
  const h = hostHeader.trim();
  const host = h.startsWith("[") ? h.slice(0, h.indexOf("]") + 1) : h.split(":")[0]!;
  if (!host || !(HOST_NAME.test(host) || IPV6_HOST.test(host))) return null;
  let rest = "/";
  try {
    const u = new URL(url ?? "/", "http://placeholder");
    rest = `${u.pathname}${u.search}`;
  } catch {}
  return `https://${host}:${httpsPort}${rest}`;
}

/** HTTP_REDIRECT_PORT: a plain-HTTP listener that answers every request with 301 → HTTPS. */
export function startHttpRedirect(opts: {
  host: string;
  port: number;
  httpsPort: number;
}): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const location = redirectLocation(req.headers.host, req.url, opts.httpsPort);
    if (!location) {
      res.writeHead(400, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end(`Open https://<laptop address>:${opts.httpsPort}/ instead.\n`);
      return;
    }
    res.writeHead(301, {
      location,
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      connection: "close",
    });
    res.end(`Moved to ${location}\n`);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}
