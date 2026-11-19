import { X509Certificate } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runtimeFromEnv } from "../src/runtime";
import {
  CERT_FILE,
  ensureSelfSignedCert,
  type HostFacts,
  KEY_FILE,
  META_FILE,
  RENEW_WITHIN_DAYS,
  redirectLocation,
  resolveTls,
  startHttpRedirect,
  TLS_DIR,
  TLS_OFF,
  VALIDITY_DAYS,
  wantedSans,
} from "../src/tls";
import { FacilitatorClient } from "../src/tools/botClient";
import { cleanup, startTestServer, type TestServer } from "./harness";

const DAY = 24 * 3600_000;

const v4 = (address: string, internal = false): os.NetworkInterfaceInfo => ({
  address,
  netmask: "255.255.255.0",
  family: "IPv4",
  mac: "00:00:00:00:00:00",
  internal,
  cidr: `${address}/24`,
});
const v6 = (address: string): os.NetworkInterfaceInfo => ({
  address,
  netmask: "ffff:ffff:ffff:ffff::",
  family: "IPv6",
  mac: "00:00:00:00:00:00",
  internal: false,
  cidr: `${address}/64`,
  scopeid: 2,
});

/** A laptop on two networks (the tests never use the real interfaces). */
const HOST: HostFacts = {
  hostname: "Research-Laptop",
  interfaces: {
    lo: [v4("127.0.0.1", true)],
    eth0: [v4("192.168.1.10"), v6("fe80::1")],
    wlan0: [v4("10.0.0.7")],
  },
};

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "wkwa-tls-"));

/** GET over HTTPS, trusting only `ca` (or nothing, when it is not given). */
function get(url: string, ca?: string | Buffer): Promise<{ status: number; body: string; headers: object }> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https:") ? https : http;
    const req = mod.get(url, { agent: false, ...(ca ? { ca } : {}) }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        body += c;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on("error", reject);
  });
}

describe("self-signed certificate (WKWA_TLS=auto)", () => {
  const dir = tmp();
  afterAll(() => cleanup(dir));
  let first: Awaited<ReturnType<typeof ensureSelfSignedCert>>;

  it("names localhost, the host name (and .local), loopback and every LAN IPv4 address", async () => {
    expect(wantedSans(HOST)).toEqual([
      "DNS:localhost",
      "DNS:research-laptop",
      "DNS:research-laptop.local",
      "IP:127.0.0.1",
      "IP:::1",
      "IP:192.168.1.10",
      "IP:10.0.0.7",
    ]);
    first = await ensureSelfSignedCert(dir, { host: HOST });
    expect(first.outcome).toEqual({ action: "created" });
    const x = new X509Certificate(first.cert);
    expect(x.subjectAltName).toBe(
      "DNS:localhost, DNS:research-laptop, DNS:research-laptop.local, IP Address:127.0.0.1, IP Address:0:0:0:0:0:0:0:1, IP Address:192.168.1.10, IP Address:10.0.0.7",
    );
    expect(first.meta.sans).toEqual(wantedSans(HOST));
  });

  it("is an ECDSA P-256 server certificate, not a CA, valid for 397 days", () => {
    const x = new X509Certificate(first.cert);
    expect(x.ca).toBe(false);
    expect(x.keyUsage).toEqual(["1.3.6.1.5.5.7.3.1"]); // Node lists the extended key usage: serverAuth
    expect(x.publicKey.asymmetricKeyType).toBe("ec");
    expect(x.publicKey.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    expect(x.verify(x.publicKey) && x.issuer === x.subject).toBe(true); // self-signed
    const days = (Date.parse(x.validTo) - Date.parse(x.validFrom)) / DAY;
    expect(days).toBe(VALIDITY_DAYS);
    expect(Date.parse(x.validFrom)).toBeLessThan(Date.now() - 12 * 3600_000); // a slow clock still accepts it
  });

  it("stores the key (mode 0600), the certificate and meta.json with the SHA-256 fingerprint", () => {
    const x = new X509Certificate(readFileSync(path.join(dir, CERT_FILE)));
    expect(x.fingerprint256).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(first.meta.fingerprintSha256).toBe(x.fingerprint256);
    expect(readFileSync(path.join(dir, KEY_FILE), "utf8")).toContain("BEGIN PRIVATE KEY");
    if (process.platform !== "win32") expect(statSync(path.join(dir, KEY_FILE)).mode & 0o777).toBe(0o600);
    const meta = JSON.parse(readFileSync(path.join(dir, META_FILE), "utf8"));
    expect(meta).toEqual({
      sans: wantedSans(HOST),
      created: expect.any(String),
      expires: new Date(x.validTo).toISOString(),
      fingerprintSha256: x.fingerprint256,
    });
  });

  it("is reused across restarts, so accepted browser exceptions stay valid", async () => {
    const again = await ensureSelfSignedCert(dir, { host: HOST });
    expect(again.outcome).toEqual({ action: "reused" });
    expect(again.meta).toEqual(first.meta);
    expect(again.cert).toBe(first.cert);
  });

  it("is reused when an address goes away: it still covers every current one", async () => {
    const offline = { ...HOST, interfaces: { lo: HOST.interfaces.lo, eth0: HOST.interfaces.eth0 } };
    const r = await ensureSelfSignedCert(dir, { host: offline });
    expect(r.outcome.action).toBe("reused");
    expect(r.meta.fingerprintSha256).toBe(first.meta.fingerprintSha256);
  });

  it("is made again when a new LAN address appears, and then names it", async () => {
    const moved = { ...HOST, interfaces: { ...HOST.interfaces, eth1: [v4("172.20.5.3")] } };
    const r = await ensureSelfSignedCert(dir, { host: moved });
    expect(r.outcome).toEqual({ action: "regenerated", reason: "names", missing: ["IP:172.20.5.3"] });
    expect(r.meta.fingerprintSha256).not.toBe(first.meta.fingerprintSha256);
    expect(r.meta.sans).toContain("IP:172.20.5.3");
    expect(new X509Certificate(readFileSync(path.join(dir, CERT_FILE))).fingerprint256).toBe(
      r.meta.fingerprintSha256,
    );
    // and that one is kept from now on
    expect((await ensureSelfSignedCert(dir, { host: moved })).outcome.action).toBe("reused");
  });

  it("keeps the old names in a new certificate, so moving between two networks settles on one", async () => {
    const d = tmp();
    try {
      const lab: HostFacts = { ...HOST, interfaces: { eth0: [v4("10.0.0.7")] } };
      const home: HostFacts = { ...HOST, interfaces: { eth0: [v4("192.168.0.5")] } };
      await ensureSelfSignedCert(d, { host: lab });
      const both = await ensureSelfSignedCert(d, { host: home });
      expect(both.outcome).toMatchObject({ reason: "names", missing: ["IP:192.168.0.5"] });
      expect(both.meta.sans).toEqual(expect.arrayContaining(["IP:10.0.0.7", "IP:192.168.0.5"]));
      expect((await ensureSelfSignedCert(d, { host: lab })).outcome.action).toBe("reused");
      expect((await ensureSelfSignedCert(d, { host: home })).outcome.action).toBe("reused");
    } finally {
      cleanup(d);
    }
  });

  it("is made again when the host name changes", async () => {
    const renamed: HostFacts = {
      hostname: "lab-pc.example.org",
      interfaces: { ...HOST.interfaces, eth1: [v4("172.20.5.3")] },
    };
    const r = await ensureSelfSignedCert(dir, { host: renamed });
    expect(r.outcome).toMatchObject({ action: "regenerated", reason: "names" });
    expect(r.meta.sans).toEqual(
      expect.arrayContaining(["DNS:lab-pc.example.org", "DNS:lab-pc", "DNS:lab-pc.local"]),
    );
  });

  it("is made again within 30 days of expiry, not before", async () => {
    const d = tmp();
    try {
      const made = await ensureSelfSignedCert(d, { host: HOST });
      const expires = Date.parse(made.meta.expires);
      const early = new Date(expires - (RENEW_WITHIN_DAYS + 1) * DAY);
      expect((await ensureSelfSignedCert(d, { host: HOST, now: early })).outcome.action).toBe("reused");
      const late = new Date(expires - (RENEW_WITHIN_DAYS - 1) * DAY);
      const r = await ensureSelfSignedCert(d, { host: HOST, now: late });
      expect(r.outcome).toEqual({ action: "regenerated", reason: "expiry", expires: made.meta.expires });
      expect(Date.parse(r.meta.expires)).toBeGreaterThan(late.getTime() + (VALIDITY_DAYS - 2) * DAY);
      // an expired one, too
      const after = new Date(Date.parse(r.meta.expires) + DAY);
      const expired = await ensureSelfSignedCert(d, { host: HOST, now: after });
      expect(expired.outcome).toMatchObject({ reason: "expiry" });
      // and one that is not valid yet (the clock was set back)
      const before = new Date(Date.parse(expired.meta.created) - 3 * DAY);
      expect((await ensureSelfSignedCert(d, { host: HOST, now: before })).outcome).toMatchObject({
        reason: "not-yet-valid",
      });
    } finally {
      cleanup(d);
    }
  });

  it("is made again when its files are damaged or do not belong together", async () => {
    const d = tmp();
    const other = tmp();
    try {
      await ensureSelfSignedCert(d, { host: HOST });
      writeFileSync(path.join(d, CERT_FILE), "not a certificate");
      expect((await ensureSelfSignedCert(d, { host: HOST })).outcome).toMatchObject({ reason: "unreadable" });
      await ensureSelfSignedCert(other, { host: HOST });
      writeFileSync(path.join(d, KEY_FILE), readFileSync(path.join(other, KEY_FILE)));
      expect((await ensureSelfSignedCert(d, { host: HOST })).outcome).toEqual({
        action: "regenerated",
        reason: "unreadable",
        detail: "the key does not belong to the certificate",
      });
      expect((await ensureSelfSignedCert(d, { host: HOST })).outcome.action).toBe("reused");
    } finally {
      cleanup(d);
      cleanup(other);
    }
  });
});

describe("resolveTls: provided, auto, off", () => {
  const dir = tmp();
  afterAll(() => cleanup(dir));
  const base = { dataDir: path.join(dir, "data"), tlsCert: null, tlsKey: null };

  it("off: plain HTTP, and no certificate is made", async () => {
    const t = await resolveTls({ ...base, tlsMode: "off" });
    expect(t).toEqual({ info: TLS_OFF, https: null, certFile: null, outcome: null });
    expect(existsSync(path.join(base.dataDir, TLS_DIR))).toBe(false);
  });

  it("TLS_CERT + TLS_KEY take precedence over auto and off", async () => {
    const own = await ensureSelfSignedCert(path.join(dir, "own"), { host: HOST });
    for (const tlsMode of ["auto", "off"] as const) {
      const t = await resolveTls({ ...base, tlsMode, tlsCert: own.certFile, tlsKey: own.keyFile });
      expect(t.info).toEqual({
        enabled: true,
        mode: "provided",
        fingerprintSha256: own.meta.fingerprintSha256,
        sans: own.meta.sans,
        expires: own.meta.expires,
      });
      expect(t.outcome).toBeNull();
    }
    expect(existsSync(path.join(base.dataDir, TLS_DIR))).toBe(false);
  });

  it("refuses only one of TLS_CERT and TLS_KEY, or a key of another certificate", async () => {
    const a = await ensureSelfSignedCert(path.join(dir, "a"), { host: HOST });
    const b = await ensureSelfSignedCert(path.join(dir, "b"), { host: HOST });
    await expect(resolveTls({ ...base, tlsMode: "auto", tlsCert: a.certFile })).rejects.toThrow(
      /both TLS_CERT and TLS_KEY.*only TLS_CERT/,
    );
    await expect(resolveTls({ ...base, tlsMode: "off", tlsKey: a.keyFile })).rejects.toThrow(/only TLS_KEY/);
    await expect(
      resolveTls({ ...base, tlsMode: "auto", tlsCert: a.certFile, tlsKey: b.keyFile }),
    ).rejects.toThrow(/does not belong/);
  });

  it("reads WKWA_TLS (default auto) and HTTP_REDIRECT_PORT from the environment", () => {
    expect(runtimeFromEnv({}).tlsMode).toBe("auto");
    expect(runtimeFromEnv({}).configErrors).toEqual([]);
    expect(runtimeFromEnv({ WKWA_TLS: "off" }).tlsMode).toBe("off");
    expect(runtimeFromEnv({ WKWA_TLS: " OFF " }).tlsMode).toBe("off");
    expect(runtimeFromEnv({}).httpRedirectPort).toBeNull();
    expect(runtimeFromEnv({ HTTP_REDIRECT_PORT: "8080" }).httpRedirectPort).toBe(8080);
    // bad values stop the server (index.ts), but never the data CLI (an erasure must always work)
    const bad = runtimeFromEnv({ WKWA_TLS: "on", HTTP_REDIRECT_PORT: "http" });
    expect(bad.configErrors).toEqual([
      expect.stringMatching(/WKWA_TLS must be "auto" or "off"/),
      expect.stringMatching(/HTTP_REDIRECT_PORT must be a TCP port/),
    ]);
    expect(runtimeFromEnv({ TLS_CERT: "" }).tlsCert).toBeNull();
    expect(path.isAbsolute(runtimeFromEnv({ TLS_CERT: "data/own.pem" }).tlsCert!)).toBe(true);
  });
});

describe("HTTP → HTTPS redirect (HTTP_REDIRECT_PORT)", () => {
  it("keeps host, path and query, and swaps in the HTTPS port", () => {
    expect(redirectLocation("192.168.1.10:8080", "/facilitator?token=x", 3000)).toBe(
      "https://192.168.1.10:3000/facilitator?token=x",
    );
    expect(redirectLocation("research-laptop.local", "/", 3000)).toBe("https://research-laptop.local:3000/");
    expect(redirectLocation("[::1]:80", "/api/health", 3443)).toBe("https://[::1]:3443/api/health");
    expect(redirectLocation("10.0.0.7", "http://elsewhere.example/x", 3000)).toBe("https://10.0.0.7:3000/x");
    expect(redirectLocation(undefined, "/", 3000)).toBeNull();
    expect(redirectLocation("evil.example/path", "/", 3000)).toBeNull();
    expect(redirectLocation("a b", "/", 3000)).toBeNull();
  });

  it("answers plain HTTP with 301 to the HTTPS address", async () => {
    const server = await startHttpRedirect({ host: "127.0.0.1", port: 0, httpsPort: 3443 });
    try {
      const port = (server.address() as AddressInfo).port;
      const r = await get(`http://127.0.0.1:${port}/play?x=1`);
      expect(r.status).toBe(301);
      expect(r.headers).toMatchObject({ location: "https://127.0.0.1:3443/play?x=1" });
    } finally {
      server.close();
    }
  });
});

describe("server with TLS on", () => {
  let srv: TestServer;
  let cert: string;

  beforeAll(async () => {
    srv = await startTestServer({ tlsMode: "auto" });
    cert = readFileSync(path.join(srv.runtime.dataDir, TLS_DIR, CERT_FILE), "utf8");
  });
  afterAll(async () => {
    if (!srv) return;
    await srv.close();
    cleanup(srv.dir);
  });

  it("serves /api/health over HTTPS with a certificate valid for 127.0.0.1", async () => {
    expect(srv.url).toMatch(/^https:\/\/127\.0\.0\.1:\d+$/);
    // trusting only this certificate: the chain and the IP name both check out
    const r = await get(`${srv.url}/api/health`, cert);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toMatchObject({ ok: true });
    // without trusting it, a client refuses (as a browser warns)
    await expect(get(`${srv.url}/api/health`)).rejects.toThrow(/self[- ]signed/i);
  });

  it("reports TLS in /api/server-info (facilitator-only, so the loopback check works over TLS)", async () => {
    const r = await get(`${srv.url}/api/server-info`, cert);
    expect(r.status).toBe(200);
    const info = JSON.parse(r.body);
    expect(info.tls).toEqual({
      enabled: true,
      mode: "auto",
      fingerprintSha256: new X509Certificate(cert).fingerprint256,
      sans: expect.arrayContaining(["DNS:localhost", "IP:127.0.0.1", "IP:::1"]),
      expires: new Date(new X509Certificate(cert).validTo).toISOString(),
    });
    expect(info.playerUrls).toEqual([{ url: `${srv.url}/`, iface: "configured host" }]);
  });

  it("lets fake players (loopback clients of the server itself) play a game over TLS", async () => {
    const fac = new FacilitatorClient(srv.url);
    try {
      await fac.connected();
      const { sessionId } = await fac.cmd("session:create", {
        scenarioId: "demo",
        config: {
          seatCount: 2,
          roundCount: 1,
          defaultRound: { rule: "quota", quota: { propose: 2, decide: 1 }, timeLimitSec: null },
        },
      });
      expect((await fac.cmd("fake:add", { pace: "fast" })).seats).toEqual([1, 2]);
      await fac.cmd("labels:randomise");
      await fac.cmd("onboarding:start");
      await fac.cmd("round:start");
      await fac.waitForDashboard((d) => d.state?.phase === "game_complete", 20_000);
      const events = srv.ctx.store.listEvents(sessionId);
      for (const seat of [1, 2]) {
        expect(events.some((e) => e.type === "PlayerConnected" && e.seat === seat)).toBe(true);
        expect(events.filter((e) => e.type === "ProposalMade" && e.seat === seat)).toHaveLength(2);
      }
    } finally {
      fac.close();
    }
  }, 30_000);

  it("logs that HTTPS is on, without host names or addresses", async () => {
    const read = () =>
      readFileSync(path.join(srv.runtime.dataDir, "logs", "server.log"), "utf8")
        .split("\n")
        .filter((l) => l && !l.includes("Server listening at"));
    // pino writes asynchronously
    for (let i = 0; i < 50 && !read().some((l) => l.includes("HTTPS on")); i++)
      await new Promise((r) => setTimeout(r, 100));
    const lines = read();
    const on = lines.find((l) => l.includes("HTTPS on"));
    expect(JSON.parse(on!)).toMatchObject({ tls: "auto", certificate: "created" });
    expect(lines.join("\n")).not.toMatch(/127\.0\.0\.1|::1|hostname|localhost|DNS:|IP:/i);
  });

  it("keeps its certificate across a restart", async () => {
    const before = new X509Certificate(cert).fingerprint256;
    await srv.close();
    srv = await startTestServer({ tlsMode: "auto" }, srv.dir);
    expect(srv.ctx.tls.outcome).toEqual({ action: "reused" });
    expect(srv.ctx.tls.info.fingerprintSha256).toBe(before);
    const r = await get(`${srv.url}/api/health`, cert);
    expect(r.status).toBe(200);
  });
});
