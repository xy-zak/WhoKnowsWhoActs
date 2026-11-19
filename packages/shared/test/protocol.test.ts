import { describe, expect, it } from "vitest";
import { FACILITATOR_SCHEMAS, MESSAGES, PLAYER_SCHEMAS } from "../src/protocol";

/*
 * The type of MESSAGES already makes the catalogue match the schema tables and the event maps
 * (socket.ts) at compile time; this checks the same at run time. docs/NETWORKING.md takes each
 * client→server payload from the schema tables, the ones the server validates with.
 */
describe("socket protocol tables", () => {
  it("documents every /player message", () => {
    expect(Object.keys(MESSAGES["/player"]["client→server"]).sort()).toEqual(
      Object.keys(PLAYER_SCHEMAS).sort(),
    );
  });

  it("documents every /facilitator command", () => {
    expect(Object.keys(MESSAGES["/facilitator"]["client→server"]).sort()).toEqual(
      Object.keys(FACILITATOR_SCHEMAS).sort(),
    );
  });

  it("uses each message name once across both namespaces", () => {
    const names = [...Object.keys(PLAYER_SCHEMAS), ...Object.keys(FACILITATOR_SCHEMAS)];
    expect(new Set(names).size).toBe(names.length);
  });
});
