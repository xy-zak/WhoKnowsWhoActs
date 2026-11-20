import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeSocket } from "./fakeSocket";

const socket = new FakeSocket();
vi.mock("socket.io-client", () => ({ io: () => socket }));

const { FacilitatorConnection } = await import("../src/facilitator/connection");

describe("FacilitatorConnection.cmd", () => {
  it("refuses a command while disconnected instead of letting Socket.IO buffer it", async () => {
    const conn = new FacilitatorConnection();
    await expect(conn.cmd("round:end", {})).rejects.toThrow("Not connected");
    expect(socket.emitted).toEqual([]);
    expect(conn.store.get().toast?.kind).toBe("error");

    socket.connect();
    const sent = conn.cmd("round:end", {});
    socket.answer("round:end", { ok: true, data: {} });
    await expect(sent).resolves.toEqual({});
  });
});

describe("FacilitatorConnection.api", () => {
  afterEach(() => vi.unstubAllGlobals());
  const reply = (body: string, status: number, statusText: string) =>
    vi.stubGlobal("fetch", async () => new Response(body, { status, statusText }));

  it("shows the server's `error` field, not the raw JSON body", async () => {
    const conn = new FacilitatorConnection();
    reply(JSON.stringify({ error: "Session not found" }), 404, "Not Found");
    await expect(conn.api("/api/x")).rejects.toThrow("Session not found");
    expect(conn.store.get().toast).toEqual({ text: "Session not found", kind: "error" });
  });

  it("falls back to the HTTP status for a body without `error`, and stays quiet when asked", async () => {
    const conn = new FacilitatorConnection();
    reply("<html>oops</html>", 502, "Bad Gateway");
    await expect(conn.api("/api/x", { quiet: true })).rejects.toThrow("502 Bad Gateway");
    expect(conn.store.get().toast).toBeNull();
  });

  it("parses JSON replies and passes other text through", async () => {
    const conn = new FacilitatorConnection();
    reply('{"a":1}', 200, "OK");
    await expect(conn.api("/api/x")).resolves.toEqual({ a: 1 });
    reply("<p>sheet</p>", 200, "OK");
    await expect(conn.api("/api/x")).resolves.toBe("<p>sheet</p>");
  });
});
