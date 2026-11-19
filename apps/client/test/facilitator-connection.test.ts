import { describe, expect, it, vi } from "vitest";
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
