import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { insertBareSession } from "./audioFixtures";
import { cleanup, startTestServer, type TestServer } from "./harness";

/** Every REST refusal answers with its status code and an `{error}` body. */
describe("REST error replies", () => {
  let srv: TestServer;
  const SIM = "S-20990101-SIMU";
  const NONE = "S-20990101-NONE";

  const api = async (method: "GET" | "POST", url: string, payload?: object) => {
    const r = await srv.ctx.app.inject({ method, url, ...(payload ? { payload } : {}) });
    return { status: r.statusCode, body: r.json() };
  };

  beforeAll(async () => {
    srv = await startTestServer();
    insertBareSession(srv.ctx.stores.simulated, SIM, undefined, { scenario_id: "no-such-scenario" });
  });

  afterAll(async () => {
    await srv?.close();
    cleanup(srv.dir);
  });

  it("answers 404 Unknown session on every session route", async () => {
    const routes: ["GET" | "POST", string][] = [
      ["GET", ""],
      ["GET", "/events"],
      ["GET", "/telemetry"],
      ["GET", "/scenario"],
      ["POST", "/export"],
      ["POST", "/anonymise"],
      ["GET", "/print/keysheet"],
      ["GET", "/cards"],
      ["GET", "/cards/1"],
      ["POST", "/delete"],
      ["GET", "/audio"],
      ["POST", "/audio/attribution"],
      ["GET", "/audio/segments"],
      ["POST", "/audio/export"],
      ["POST", "/audio/delete"],
    ];
    for (const [method, suffix] of routes) {
      expect(await api(method, `/api/sessions/${NONE}${suffix}`, {}), `${method} ${suffix}`).toEqual({
        status: 404,
        body: { error: "Unknown session" },
      });
    }
  });

  it("answers 400 for simulated sessions on participant and audio routes", async () => {
    const noParticipants = {
      status: 400,
      body: { error: "Simulated sessions have no participants: no key sheet or takedown cards." },
    };
    for (const suffix of ["/print/keysheet", "/cards", "/cards/1"])
      expect(await api("GET", `/api/sessions/${SIM}${suffix}`)).toEqual(noParticipants);
    const noAudio = { status: 400, body: { error: "Simulated sessions have no audio." } };
    expect(await api("POST", `/api/sessions/${SIM}/audio/attribution`, {})).toEqual(noAudio);
    expect(await api("GET", `/api/sessions/${SIM}/audio/segments`)).toEqual(noAudio);
    expect(await api("POST", `/api/sessions/${SIM}/audio/export`, {})).toEqual(noAudio);
    expect(await api("POST", `/api/sessions/${SIM}/audio/delete`, {})).toEqual(noAudio);
    expect((await api("GET", `/api/sessions/${SIM}/audio`)).body).toMatchObject({
      tracks: [],
      running: false,
    });
  });

  it("answers 400 / 404 for bad input", async () => {
    expect(await api("POST", `/api/sessions/${SIM}/delete`, { confirm: "nope" })).toEqual({
      status: 400,
      body: { error: "Confirmation does not match the session id" },
    });
    expect((await api("GET", "/api/scenarios/no-such-scenario")).status).toBe(404);
    expect((await api("GET", "/api/scenarios/no-such-scenario")).body.error).toEqual(expect.any(String));
    const badCode = await api("GET", "/api/participants/nope");
    expect(badCode.status).toBe(400);
    expect(badCode.body.error).toEqual(expect.any(String));
    const badErase = await api("POST", "/api/participants/nope/erase", { confirm: "nope" });
    expect(badErase).toEqual({ status: 400, body: badCode.body });
    expect(await api("POST", "/api/participants/WK-0000-0000-0/erase", { confirm: "x" })).toMatchObject({
      status: 400,
    });
    // other errors keep Fastify's default reply (the simulated session has no scenario file)
    expect(await api("GET", `/api/sessions/${SIM}/scenario`)).toMatchObject({
      status: 500,
      body: { statusCode: 500, error: "Internal Server Error" },
    });
    expect(await api("GET", "/api/audio/jobs/not-a-job")).toEqual({
      status: 404,
      body: { error: "Unknown job" },
    });
  });
});
