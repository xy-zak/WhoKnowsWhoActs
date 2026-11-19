/**
 * What a SessionManager accepts outside the event log, driven directly (no sockets): telemetry and
 * its consent rule, the seat monitor's live figures and what clears them, and the rule for fake
 * players.
 */
import { AUDIO_SILENCE_DB, type SeatLiveStats } from "@wkwa/shared";
import { afterEach, describe, expect, it } from "vitest";
import { consent, type Direct, direct, onboard } from "./direct";

const focus = (focused: boolean) => ({ type: "focus_change", clientTs: Date.now(), payload: { focused } });
const batch = (...items: unknown[]) => ({ clockOffsetMs: 0, items });
const LEVEL = { state: "recording" as const, rmsDb: -30, peakDb: -10, pendingChunks: 1, pendingBytes: 100 };
const EMPTY = { hoverRegionId: null, focused: null, telemetryCount: 0, lastTelemetryTs: null };

let d: Direct;
afterEach(() => d?.close());

const stats = (seat: number): SeatLiveStats => d.m.monitor.dashboardStats()[seat]!;
const meter = (seat: number) => stats(seat).mic?.state;

describe("telemetry", () => {
  it("stores nothing before consent; after consent it is stored, counted and shown live", () => {
    d = direct({});
    onboard(d.m);
    expect(d.m.submitTelemetry(1, batch(focus(false)))).toEqual({ stored: 0, live: [] });
    expect(d.store.listTelemetry(d.m.sessionId)).toEqual([]);
    expect(stats(1)).toMatchObject(EMPTY);

    consent(d.m, 1);
    const r = d.m.submitTelemetry(1, batch(focus(false), { type: "no_such_type" }));
    expect(r.stored).toBe(1); // an item that does not parse is dropped
    expect(r.live.map((t) => t.type)).toEqual(["focus_change"]);
    expect(d.store.listTelemetry(d.m.sessionId).map((t) => [t.seat, t.type])).toEqual([[1, "focus_change"]]);
    expect(stats(1)).toMatchObject({ focused: false, telemetryCount: 1 });
    expect(d.m.monitor.liveTelemetry).toHaveLength(1);
    // seat 2 has not consented yet
    expect(d.m.submitTelemetry(2, batch(focus(true))).stored).toBe(0);
  });

  it("stores nothing for a declined consent or after the session ended", () => {
    d = direct({});
    onboard(d.m);
    consent(d.m, 1, true, false);
    expect(d.m.state.seats[1]!.consent).toBe("declined");
    expect(d.m.submitTelemetry(1, batch(focus(false))).stored).toBe(0);
    consent(d.m, 2);
    d.m.abort("test");
    expect(d.m.submitTelemetry(2, batch(focus(false))).stored).toBe(0);
    expect(d.store.listTelemetry(d.m.sessionId)).toEqual([]);
  });
});

describe("seat monitor", () => {
  it("unbinding a seat clears that seat's figures", () => {
    d = direct({});
    d.m.bindSeat(1, 1);
    d.m.bindSeat(2, 2);
    d.m.submitPresence(1, "A1-Ka");
    d.m.submitPresence(2, "B1-Ka");
    d.m.unbindSeat(1, "test");
    expect(stats(1)).toMatchObject(EMPTY);
    expect(stats(2).hoverRegionId).toBe("B1-Ka");
  });

  it("keeps mic readings only of a seat that may be recorded", () => {
    d = direct({ audio: { enabled: true } });
    onboard(d.m);
    consent(d.m, 1);
    // seat 2 is still in consent: nobody's microphone records yet
    expect(d.m.submitMicLevel(1, LEVEL)).toBe(false);
    expect(meter(1)).toBe("idle");
    consent(d.m, 2);
    expect(d.m.submitMicLevel(1, LEVEL)).toBe(true);
    expect(stats(1).mic).toMatchObject({ state: "recording", rmsDb: -30, pendingChunks: 1 });
    expect(meter(2)).toBe("idle");
  });

  it("withdrawal and a skipped mic check blank that seat's meter; the end of the session every meter", () => {
    d = direct({ audio: { enabled: true }, seatCount: 3 });
    onboard(d.m);
    for (const seat of [1, 2, 3]) consent(d.m, seat);
    for (const seat of [1, 2, 3]) expect(d.m.submitMicLevel(seat, LEVEL)).toBe(true);
    d.m.withdraw(1);
    expect([meter(1), meter(2), meter(3)]).toEqual(["idle", "recording", "recording"]);
    d.m.skipMicCheck(2, "no microphone");
    expect([meter(1), meter(2), meter(3)]).toEqual(["idle", "idle", "recording"]);
    d.m.abort("test");
    expect(stats(3).mic).toMatchObject({ state: "idle", rmsDb: AUDIO_SILENCE_DB, pendingChunks: 0 });
  });

  it("a disconnect blanks the seat's meter and hover", () => {
    d = direct({ audio: { enabled: true } });
    onboard(d.m);
    consent(d.m, 1);
    consent(d.m, 2);
    d.m.playerConnected(1);
    d.m.submitMicLevel(1, LEVEL);
    d.m.submitPresence(1, "A1-Ka");
    d.m.playerDisconnected(1, "transport close");
    expect(stats(1)).toMatchObject({ hoverRegionId: null, mic: { state: "idle" } });
  });
});

describe("fake player admission", () => {
  it("takes only a seat that exists and is not bound", () => {
    d = direct({ seatCount: 3 });
    d.m.bindSeat(1, 1);
    expect(d.m.fakePlayerRefusal(1)).toMatch(/Seat 1 is already bound/);
    expect(d.m.fakePlayerRefusal(9)).toMatch(/Seat 9 does not exist/);
    expect(d.m.fakePlayerRefusal(2)).toBeNull();
    expect(d.m.fakePlayerSeats(null)).toEqual([2, 3]);
    expect(() => d.m.fakePlayerSeats([2, 1])).toThrow(/Seat 1 is already bound/);
    // a fake player never replaces the client of a bound seat (a real client does)
    expect(() => d.m.bindSeat(5, 1, { fake: true })).toThrow(/already bound/);
    expect(d.m.bindSeat(5, 1).fake).toBe(false);
    d.m.bindSeat(2, 2, { fake: true });
    d.m.bindSeat(3, 3);
    expect(() => d.m.fakePlayerSeats(null)).toThrow(/Every seat is already bound/);
  });

  it("is refused outside the lobby", () => {
    d = direct({});
    d.m.bindSeat(1, 1);
    d.m.unbindSeat(1, "test");
    onboard(d.m);
    expect(d.m.fakePlayerRefusal(1)).toMatch(/only be added in the lobby/);
    expect(() => d.m.fakePlayerSeats([1])).toThrow(/only be added in the lobby/);
  });

  it("is refused in a simulated session", () => {
    d = direct({ players: "simulated" }, { sim: true });
    expect(d.m.fakePlayerRefusal(1)).toMatch(/simulated session/);
    expect(() => d.m.fakePlayerSeats(null)).toThrow(/simulated session/);
  });
});
