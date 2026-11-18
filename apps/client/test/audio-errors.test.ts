import { describe, expect, it } from "vitest";
import { classifyMicError, detectBrowser, detectOs, MicError, micHelp } from "../src/audio/errors";

const UA = {
  chrome:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0",
  firefox: "Mozilla/5.0 (X11; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0",
  safari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15",
  opera:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 OPR/120.0.0.0",
  chromeLinux:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  chromeMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  android:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36",
};

const dom = (name: string, message = "") => Object.assign(new Error(message), { name });
const env = { secureContext: true, hasGetUserMedia: true, userAgent: UA.chrome };

describe("browser and OS detection", () => {
  it("detects the browser family", () => {
    expect(detectBrowser(UA.chrome)).toBe("chrome");
    expect(detectBrowser(UA.edge)).toBe("edge");
    expect(detectBrowser(UA.firefox)).toBe("firefox");
    expect(detectBrowser(UA.safari)).toBe("safari");
    expect(detectBrowser(UA.opera)).toBe("other");
    expect(detectBrowser("")).toBe("other");
  });

  it("detects the OS family; phones are other", () => {
    expect(detectOs(UA.chrome)).toBe("windows");
    expect(detectOs(UA.safari)).toBe("macos");
    expect(detectOs(UA.firefox)).toBe("linux");
    expect(detectOs(UA.chromeLinux)).toBe("linux");
    expect(detectOs(UA.android)).toBe("other");
  });
});

describe("classifyMicError", () => {
  it("maps DOMException names to kinds", () => {
    expect(classifyMicError(dom("NotAllowedError", "Permission denied"), env).kind).toBe("denied");
    expect(classifyMicError(dom("PermissionDeniedError"), env).kind).toBe("denied");
    expect(classifyMicError(dom("SecurityError"), env).kind).toBe("denied");
    expect(classifyMicError(dom("NotFoundError"), env).kind).toBe("not_found");
    expect(classifyMicError(dom("DevicesNotFoundError"), env).kind).toBe("not_found");
    expect(classifyMicError(dom("NotReadableError", "Could not start audio source"), env).kind).toBe(
      "in_use",
    );
    expect(classifyMicError(dom("AbortError"), env).kind).toBe("in_use");
    expect(classifyMicError(dom("OverconstrainedError"), env).kind).toBe("overconstrained");
    expect(classifyMicError(dom("NotSupportedError"), env).kind).toBe("unsupported");
    expect(classifyMicError(dom("WeirdError"), env).kind).toBe("unknown");
    expect(classifyMicError(undefined, env).kind).toBe("unknown");
    expect(classifyMicError("boom", env)).toMatchObject({ kind: "unknown", detail: "boom" });
  });

  it("reports an insecure context or a missing API whatever the error", () => {
    expect(classifyMicError(new TypeError("x is undefined"), { ...env, secureContext: false }).kind).toBe(
      "insecure",
    );
    expect(classifyMicError(dom("SecurityError"), { secureContext: false }).kind).toBe("insecure");
    expect(classifyMicError(dom("NotAllowedError"), { ...env, hasGetUserMedia: false }).kind).toBe(
      "unsupported",
    );
    expect(
      classifyMicError(new TypeError("Cannot read properties of undefined (reading 'getUserMedia')"), env)
        .kind,
    ).toBe("unsupported");
    expect(classifyMicError(new MicError("unsupported"), env).kind).toBe("unsupported");
    expect(classifyMicError(new MicError("ended"), env)).toMatchObject({ kind: "ended", name: "" });
  });

  it("returns per-browser help to re-allow the microphone", () => {
    const chrome = classifyMicError(dom("NotAllowedError"), env);
    expect(chrome).toMatchObject({ browser: "chrome", os: "windows", name: "NotAllowedError" });
    expect(chrome.title).toMatch(/blocked/i);
    expect(chrome.steps[0]).toMatch(/address bar/);
    expect(chrome.steps[1]).toMatch(/Privacy & security ▸ Microphone/);

    const firefox = classifyMicError(dom("NotAllowedError"), { ...env, userAgent: UA.firefox });
    expect(firefox.steps[0]).toMatch(/Blocked/);
    const safari = classifyMicError(dom("NotAllowedError"), { ...env, userAgent: UA.safari });
    expect(safari.steps[0]).toMatch(/Settings for This Website/);
    expect(safari.steps[1]).toMatch(/System Settings ▸ Privacy & Security ▸ Microphone/);
    const edge = classifyMicError(dom("NotAllowedError"), { ...env, userAgent: UA.edge });
    expect(edge.steps[0]).toMatch(/Permissions for this site/);
    expect(new Set([chrome.steps[0], firefox.steps[0], safari.steps[0], edge.steps[0]]).size).toBe(4);
  });

  it("has a title and steps for every kind, browser and OS", () => {
    const kinds = [
      "denied",
      "not_found",
      "in_use",
      "insecure",
      "unsupported",
      "overconstrained",
      "ended",
      "unknown",
    ] as const;
    for (const kind of kinds) {
      for (const browser of ["chrome", "edge", "firefox", "safari", "other"] as const) {
        for (const os of ["windows", "macos", "linux", "other"] as const) {
          const h = micHelp(kind, browser, os);
          expect(h.title.length, `${kind}/${browser}/${os}`).toBeGreaterThan(5);
          expect(h.steps.length, `${kind}/${browser}/${os}`).toBeGreaterThan(0);
          for (const s of h.steps) expect(s).not.toMatch(/undefined/);
        }
      }
    }
    expect(micHelp("insecure", "chrome", "windows").steps.join(" ")).toMatch(/https:\/\//);
  });
});
