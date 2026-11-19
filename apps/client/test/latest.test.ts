import { describe, expect, it } from "vitest";
import { latestGuard } from "../src/net/latest";

describe("latestGuard", () => {
  it("drops an older reply that lands after a newer one", async () => {
    const latest = latestGuard();
    const shown: string[] = [];
    let replyA: (v: string) => void = () => {};
    const a = new Promise<string>((r) => {
      replyA = r;
    });
    // pick scenario A, then B; B answers first, A last
    a.then(latest()((v: string) => shown.push(v)));
    await Promise.resolve("B").then(latest()((v: string) => shown.push(v)));
    replyA("A");
    await a;
    expect(shown).toEqual(["B"]);
  });

  it("lets every callback of the latest request run (reply and error alike)", () => {
    const ifLatest = latestGuard()();
    const calls: string[] = [];
    ifLatest(() => calls.push("ok"))();
    ifLatest(() => calls.push("error"))();
    expect(calls).toEqual(["ok", "error"]);
  });
});
