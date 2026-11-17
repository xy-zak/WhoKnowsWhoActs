import { describe, expect, it } from "vitest";
import { emptyDraft, finalConfig } from "../src/facilitator/setup/draft";

describe("setup draft", () => {
  it("keeps the facilitator's onboarding choices for a simulated session", () => {
    const d = emptyDraft();
    const sim = finalConfig({ ...d, config: { ...d.config, players: "simulated" } });
    if (!("config" in sim)) throw new Error(sim.error);
    // the server switches onboarding off for agents; the draft must not
    expect(sim.config.onboarding).toEqual({ consent: true, demographics: true, briefing: true });
  });

  it("does not carry 'no consent' from a simulated session into the next real one", () => {
    const d = emptyDraft();
    const sim = finalConfig({ ...d, config: { ...d.config, players: "simulated" } });
    if (!("config" in sim)) throw new Error(sim.error);
    // after creating a session, the next draft starts from its config
    const next = emptyDraft(sim.config);
    const real = finalConfig({ ...next, config: { ...next.config, players: "real" } });
    if (!("config" in real)) throw new Error(real.error);
    expect(real.config.onboarding.consent).toBe(true);
    expect(real.config.pauseOnDisconnect).toBe(true);
  });
});
