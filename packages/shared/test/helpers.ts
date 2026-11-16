import {
  applyEvent,
  type EventType,
  type GameState,
  initialState,
  type PayloadOf,
  type Scenario,
  type SessionConfigInput,
  SessionConfigSchema,
  type StoredEvent,
} from "../src";

/** Builds a sequence of stored events for tests, with increasing seq and timestamps. */
export class EventLog {
  events: StoredEvent[] = [];
  state: GameState = initialState();
  private ts = 1_700_000_000_000;
  constructor(public sessionId = "S-TEST-0001") {}

  push<T extends EventType>(
    type: T,
    payload: PayloadOf<T>,
    opts: { seat?: number | null; code?: string | null; actor?: StoredEvent["actorKind"]; dt?: number } = {},
  ): StoredEvent {
    this.ts += opts.dt ?? 1000;
    const ev = {
      sessionId: this.sessionId,
      seq: this.events.length + 1,
      type,
      actorKind: opts.actor ?? "system",
      seat: opts.seat ?? null,
      participantCode: opts.code ?? null,
      round: this.state.round,
      serverTs: this.ts,
      serverWall: new Date(this.ts).toISOString(),
      clientTs: null,
      clientSeq: null,
      payload,
    } as StoredEvent;
    this.events.push(ev);
    applyEvent(this.state, ev);
    return ev;
  }
}

export const testScenario: Scenario = {
  id: "test",
  title: "Test",
  version: "1",
  description: "",
  viewBox: "0 0 100 100",
  regions: [
    { id: "A", name: "Alpha", path: "M0 0 L50 0 L50 50 L0 50 Z", anchor: [25, 25] },
    { id: "B", name: "Beta", path: "M50 0 L100 0 L100 50 L50 50 Z", anchor: [75, 25] },
    { id: "C", name: "Gamma", path: "M0 50 L100 50 L100 100 L0 100 Z", anchor: [50, 75] },
  ],
  attributes: [{ key: "value", label: "Value", unit: "" }],
  views: {
    Ka: { name: "View A", description: "", regions: { A: { attributes: { value: "ka-secret-A" } } } },
    Kb: { name: "View B", description: "", regions: { A: { attributes: { value: "kb-secret-A" } } } },
    Kc: { name: "View C", description: "", regions: { A: { attributes: { value: "kc-secret-A" } } } },
    Kd: { name: "View D", description: "", regions: { A: { attributes: { value: "kd-secret-A" } } } },
  },
  hash: "test",
};

/** A session with 4 bound, labelled, onboarded seats, ready for round 1. */
export function readySession(configInput: SessionConfigInput = {}): EventLog {
  const log = new EventLog();
  const config = SessionConfigSchema.parse(configInput);
  log.push(
    "SessionCreated",
    {
      config,
      scenario: { id: "test", title: "Test", version: "1", hash: "test" },
      regionIds: testScenario.regions.map((r) => r.id),
      viewIds: ["Ka", "Kb", "Kc", "Kd"],
      harness: { version: "0", gitCommit: "test" },
      notes: "",
    },
    { actor: "facilitator" },
  );
  const K = ["Ka", "Kb", "Kc", "Kd"] as const;
  const P = ["Pa", "Pb", "Pc", "Pd"] as const;
  for (let seat = 1; seat <= config.seatCount; seat++) {
    log.push(
      "SeatBound",
      { seat, terminal: seat, bindingId: `b${seat}` },
      { seat, code: `WK-TEST-000${seat}-X`, actor: "facilitator" },
    );
    log.push("PlayerConnected", { seat, reconnect: false }, { seat, code: `WK-TEST-000${seat}-X` });
  }
  log.push(
    "LabelsAssigned",
    {
      assignments: Array.from({ length: config.seatCount }, (_, i) => ({
        seat: i + 1,
        k: K[i]!,
        p: P[i]!,
        view: K[i]!,
      })),
      method: "manual",
      seed: null,
    },
    { actor: "facilitator" },
  );
  log.push("OnboardingStarted", { steps: ["consent", "demographics", "briefing"] }, { actor: "facilitator" });
  for (let seat = 1; seat <= config.seatCount; seat++) {
    const code = `WK-TEST-000${seat}-X`;
    log.push(
      "ConsentRecorded",
      { formVersion: "1", textSha256: "x", answers: { participate: true }, consented: true, durationMs: 1 },
      { seat, code, actor: "player" },
    );
    log.push(
      "DemographicsSubmitted",
      { formVersion: "1", answers: { age: "25_34" }, durationMs: 1 },
      { seat, code, actor: "player" },
    );
    log.push("BriefingAcknowledged", { textSha256: "y", durationMs: 1 }, { seat, code, actor: "player" });
  }
  return log;
}
