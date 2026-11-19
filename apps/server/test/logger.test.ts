import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createLogger } from "../src/logger";
import { cleanup } from "./harness";

it("the request log redacts a participant code in the path", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wkwa-log-"));
  try {
    const log = createLogger(dir, { stdout: false, level: "info" });
    log.info({ req: { method: "POST", url: "/api/participants/WK-7F3K-Q9XM-Z/erase?x=1" } }, "request");
    log.info({ req: { method: "GET", url: "/api/participants/wk%207f3k" } }, "request");
    // the file stream writes asynchronously
    const text = await vi.waitFor(() => {
      const t = readFileSync(path.join(dir, "logs", "server.log"), "utf8");
      expect(t.trim().split("\n")).toHaveLength(2);
      return t;
    });
    expect(text).not.toMatch(/7f3k/i);
    const paths = text
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).req.path);
    expect(paths).toEqual(["/api/participants/:code/erase", "/api/participants/:code"]);
  } finally {
    cleanup(dir);
  }
});
