import { afterEach, describe, expect, it } from "vitest";
import { consent, type Direct, direct, finishOnboarding, onboard } from "./direct";

let d: Direct;
afterEach(() => d?.close());

describe("seat events", () => {
  it("carry the seat's participant code, and the browser's clientTs/clientSeq on player events", () => {
    d = direct({});
    onboard(d.m);
    for (const s of Object.keys(d.m.state.seats).map(Number)) {
      consent(d.m, s);
      finishOnboarding(d.m, s);
    }
    if (d.m.state.phase !== "round_active") d.m.startRound();
    const region = (seat: number, sq: string) => `${sq}-${d.m.state.seats[seat]!.k}`;
    d.m.intent(1, { clientSeq: 1, kind: "propose", regionId: region(1, "A1"), clientTs: 111 });
    d.m.intent(1, { clientSeq: 2, kind: "propose", regionId: region(1, "A2"), clientTs: 222 }); // over quota: rejected
    d.m.intent(2, { clientSeq: 1, kind: "decide", regionId: region(2, "A1"), clientTs: 333 });
    d.m.withdraw(2);

    const codes = Object.fromEntries(Object.entries(d.m.state.seats).map(([k, s]) => [k, s.participantCode]));
    const seatEvents = d.events.filter((e) => e.seat !== null);
    for (const e of seatEvents) expect(e.participantCode, e.type).toBe(codes[e.seat!]);
    for (const e of seatEvents.filter((x) => x.actorKind === "player"))
      expect(e.clientTs, e.type).not.toBeNull();
    const intents = seatEvents.filter((e) =>
      ["ProposalMade", "IntentRejected", "DecisionMade"].includes(e.type),
    );
    expect(intents.map((e) => [e.type, e.seat, e.clientSeq, e.clientTs])).toEqual([
      ["ProposalMade", 1, 1, 111],
      ["IntentRejected", 1, 2, 222],
      ["DecisionMade", 2, 1, 333],
    ]);
    expect(seatEvents.map((e) => e.type)).toEqual(
      expect.arrayContaining(["SeatBound", "ConsentRecorded", "ParticipantWithdrawn"]),
    );
  });
});
