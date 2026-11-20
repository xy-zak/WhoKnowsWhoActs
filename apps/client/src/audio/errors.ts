/**
 * Microphone failures: classification of getUserMedia / Web Audio errors and
 * help text per browser and operating system, for the mic-check screen.
 */

export type MicErrorKind =
  /** the participant or the system blocked access (NotAllowedError) */
  | "denied"
  /** no microphone (NotFoundError) */
  | "not_found"
  /** the device exists but could not be started, usually because another app holds it (NotReadableError) */
  | "in_use"
  /** the page is not a secure context (plain http on a LAN address) */
  | "insecure"
  /** the browser lacks getUserMedia or AudioWorklet */
  | "unsupported"
  /** the device cannot satisfy the constraints */
  | "overconstrained"
  /** a running microphone stopped (unplugged, or access revoked) */
  | "ended"
  | "unknown";

export type BrowserFamily = "chrome" | "edge" | "firefox" | "safari" | "other";
export type OsFamily = "windows" | "macos" | "linux" | "other";

export interface MicHelp {
  title: string;
  /** what the participant can do, in order */
  steps: string[];
}

export interface MicErrorInfo extends MicHelp {
  kind: MicErrorKind;
  /** DOMException name, e.g. "NotAllowedError" ("" when unknown) */
  name: string;
}

/** An error raised by the capture engine itself, with its kind. */
export class MicError extends Error {
  override readonly name = "MicError";
  constructor(
    readonly kind: MicErrorKind,
    message: string = kind,
  ) {
    super(message);
  }
}

const hasWindow = () => typeof window !== "undefined";

export function detectBrowser(ua: string = hasWindow() ? navigator.userAgent : ""): BrowserFamily {
  if (/\bEdg(e|A|iOS)?\//.test(ua)) return "edge";
  if (/\bFirefox\/|\bFxiOS\//.test(ua)) return "firefox";
  if (/\bOPR\/|\bOpera\b/.test(ua)) return "other";
  if (/\bChrome\/|\bChromium\/|\bCriOS\//.test(ua)) return "chrome";
  if (/\bSafari\//.test(ua) && /\bVersion\//.test(ua)) return "safari";
  return "other";
}

export function detectOs(ua: string = hasWindow() ? navigator.userAgent : ""): OsFamily {
  if (/Android|iPhone|iPad|CrOS/.test(ua)) return "other";
  if (/Windows/.test(ua)) return "windows";
  if (/Macintosh|Mac OS X/.test(ua)) return "macos";
  if (/Linux|X11/.test(ua)) return "linux";
  return "other";
}

const ALLOW_STEP: Record<BrowserFamily, string> = {
  chrome:
    "Click the site controls icon at the left of the address bar (a lock or two sliders), switch Microphone on or set it to Allow (under Site settings), then reload the page.",
  edge: "Click the lock icon at the left of the address bar, open Permissions for this site, set Microphone to Allow, then reload the page.",
  firefox:
    "Click the permissions icon at the left of the address bar (a crossed-out microphone or the lock), click the × next to “Use the microphone: Blocked” to clear it, then reload the page and choose Allow.",
  safari:
    "In the menu bar choose Safari ▸ Settings for This Website… (or Safari ▸ Settings ▸ Websites ▸ Microphone), set this website to Allow, then reload the page.",
  other:
    "Open this site's settings from the icon at the left of the address bar, allow the microphone, then reload the page.",
};

const OS_PRIVACY_STEP: Partial<Record<OsFamily, string>> = {
  macos:
    "If it is still blocked: open System Settings ▸ Privacy & Security ▸ Microphone, turn your browser on, then quit and reopen the browser.",
  windows:
    "If it is still blocked: open Settings ▸ Privacy & security ▸ Microphone and turn on Microphone access and Let desktop apps access your microphone.",
  linux:
    "If it is still blocked: check that your desktop's privacy or sandbox settings (for example Flatpak or Snap permissions) let the browser use the microphone.",
};

const OS_INPUT_STEP: Partial<Record<OsFamily, string>> = {
  macos: "Check that it is selected in System Settings ▸ Sound ▸ Input.",
  windows: "Check that it is selected in Settings ▸ System ▸ Sound ▸ Input.",
  linux: "Check that it is selected, and not muted, in your system's sound settings (Input).",
};

const DEVICE_CHOICE_STEP: Partial<Record<BrowserFamily, string>> = {
  chrome:
    "If several microphones are connected, choose one in the site settings (icon at the left of the address bar).",
  edge: "If several microphones are connected, choose one in the site permissions (lock icon at the left of the address bar).",
  firefox: "Firefox asks which microphone to use when you allow access: pick your headset there.",
};

const compact = (xs: Array<string | undefined>): string[] => xs.filter((x): x is string => !!x);

/** Help text for a failure kind in a given browser and OS. */
export function micHelp(
  kind: MicErrorKind,
  browser: BrowserFamily = detectBrowser(),
  os: OsFamily = detectOs(),
): MicHelp {
  switch (kind) {
    case "denied":
      return {
        title: "Microphone access is blocked",
        steps: compact([ALLOW_STEP[browser], OS_PRIVACY_STEP[os]]),
      };
    case "not_found":
      return {
        title: "No microphone found",
        steps: compact([
          "Plug in your headset or microphone (or check that the built-in microphone is switched on).",
          OS_INPUT_STEP[os],
          DEVICE_CHOICE_STEP[browser],
          "Then try again.",
        ]),
      };
    case "in_use":
      return {
        title: "The microphone could not be started",
        steps: compact([
          "Close other apps or browser tabs that may be using it (video calls, recorders).",
          "Unplug and reconnect a USB or Bluetooth headset.",
          os === "windows"
            ? "In the Sound control panel ▸ Recording ▸ your microphone ▸ Properties ▸ Advanced, untick “Allow applications to take exclusive control”."
            : OS_INPUT_STEP[os],
          "Then try again.",
        ]),
      };
    case "insecure":
      return {
        title: "This page cannot use the microphone",
        steps: [
          "Browsers only allow the microphone on secure pages: the address must start with https://.",
          "Ask the facilitator for the https:// address, open it and accept the certificate warning once.",
        ],
      };
    case "unsupported":
      return {
        title: "This browser cannot record audio",
        steps: [
          "Use a current version of Chrome, Edge, Firefox or Safari on a laptop or desktop computer.",
          "Phones and tablets are not supported.",
        ],
      };
    case "overconstrained":
      return {
        title: "The microphone does not support the required settings",
        steps: compact(["Connect another headset or microphone.", OS_INPUT_STEP[os], "Then try again."]),
      };
    case "ended":
      return {
        title: "The microphone stopped",
        steps: compact([
          "It may have been unplugged, or access to it was turned off.",
          "Reconnect it and try again.",
          `If access was turned off: ${ALLOW_STEP[browser].charAt(0).toLowerCase()}${ALLOW_STEP[browser].slice(1)}`,
        ]),
      };
    default:
      return {
        title: "The microphone could not be started",
        steps: ["Reload the page and try again.", "If it keeps failing, tell the facilitator."],
      };
  }
}

export interface MicEnvironment {
  /** window.isSecureContext */
  secureContext?: boolean;
  /** navigator.mediaDevices.getUserMedia exists */
  hasGetUserMedia?: boolean;
  userAgent?: string;
}

function currentEnvironment(): MicEnvironment {
  if (!hasWindow()) return {};
  return {
    secureContext: window.isSecureContext,
    hasGetUserMedia: typeof navigator.mediaDevices?.getUserMedia === "function",
    userAgent: navigator.userAgent,
  };
}

function kindOf(name: string, message: string, env: MicEnvironment): MicErrorKind {
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
      return "denied";
    case "SecurityError":
      return env.secureContext === false ? "insecure" : "denied";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "not_found";
    case "NotReadableError":
    case "TrackStartError":
    case "AbortError":
      return "in_use";
    case "OverconstrainedError":
    case "ConstraintNotSatisfiedError":
      return "overconstrained";
    case "NotSupportedError":
      return "unsupported";
    case "TypeError":
      return /getUserMedia|mediaDevices|AudioWorklet|undefined/i.test(message) ? "unsupported" : "unknown";
    default:
      return "unknown";
  }
}

/**
 * Classifies an error from getUserMedia, AudioContext or the engine.
 * An insecure context or a missing getUserMedia wins over the error itself,
 * since that is what the participant has to fix.
 */
export function classifyMicError(err: unknown, env: MicEnvironment = currentEnvironment()): MicErrorInfo {
  const e = (err ?? {}) as { name?: unknown; message?: unknown; kind?: unknown };
  const name = typeof e.name === "string" ? e.name : "";
  const detail = (typeof e.message === "string" ? e.message : typeof err === "string" ? err : "").slice(
    0,
    300,
  );
  let kind: MicErrorKind;
  if (env.secureContext === false) kind = "insecure";
  else if (env.hasGetUserMedia === false) kind = "unsupported";
  else if (err instanceof MicError) kind = err.kind;
  else kind = kindOf(name, detail, env);
  const ua = env.userAgent ?? (hasWindow() ? navigator.userAgent : "");
  const browser = detectBrowser(ua);
  const os = detectOs(ua);
  return {
    kind,
    name: err instanceof MicError ? "" : name,
    ...micHelp(kind, browser, os),
  };
}

/** Why this page cannot record at all ("insecure" / "unsupported"), or null when it can try. */
export function micSupportProblem(): "insecure" | "unsupported" | null {
  if (!hasWindow()) return "unsupported";
  if (window.isSecureContext === false) return "insecure";
  if (typeof navigator.mediaDevices?.getUserMedia !== "function") return "unsupported";
  if (typeof AudioContext === "undefined" || typeof AudioWorkletNode === "undefined") return "unsupported";
  return null;
}
