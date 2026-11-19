import { describe, expect, it } from "vitest";
import { FACILITATOR_SCHEMAS, MESSAGES, PLAYER_SCHEMAS } from "../src/protocol";

/*
 * The type of MESSAGES already makes the catalogue match the schema tables and the event maps
 * (socket.ts) at compile time; this checks the same at run time, so docs/NETWORKING.md (generated
 * from MESSAGES) can never describe a schema other than the one the server validates with.
 */
describe("socket protocol tables", () => {
  const inbound = (ns: string) =>
    Object.entries(MESSAGES).filter(([, m]) => m.namespace === ns && m.direction === "client→server");

  it("documents every /player message with the schema the server validates it with", () => {
    const docs = inbound("/player");
    expect(docs.map(([k]) => k).sort()).toEqual(Object.keys(PLAYER_SCHEMAS).sort());
    for (const [name, m] of docs) expect(m.schema).toBe(PLAYER_SCHEMAS[name as keyof typeof PLAYER_SCHEMAS]);
  });

  it("documents every /facilitator command with the schema the server validates it with", () => {
    const docs = inbound("/facilitator");
    expect(docs.map(([k]) => k).sort()).toEqual(Object.keys(FACILITATOR_SCHEMAS).sort());
    for (const [name, m] of docs)
      expect(m.schema).toBe(FACILITATOR_SCHEMAS[name as keyof typeof FACILITATOR_SCHEMAS]);
  });

  it("uses each message name once across both namespaces", () => {
    const names = [...Object.keys(PLAYER_SCHEMAS), ...Object.keys(FACILITATOR_SCHEMAS)];
    expect(new Set(names).size).toBe(names.length);
  });
});
