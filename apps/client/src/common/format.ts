/*
 * The client's number and time formatting, shared by the player and facilitator screens.
 * Every formatter shows PLACEHOLDER for a value that is missing or not a finite number.
 * Pure: unit-tested in test/database-audio.test.ts and test/audioLive.test.ts.
 */

/** What a formatter shows for a missing value. */
export const PLACEHOLDER = "–";

const ok = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n);

/** `m:ss`, or `h:mm:ss` from one hour, rounded to the second (a negative time reads `0:00`). */
export function fmtDuration(ms: number | null | undefined): string {
  if (!ok(ms)) return PLACEHOLDER;
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m % 60)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

/** Minutes with one decimal, e.g. `12.5 min` (a negative time reads `0.0 min`). */
export function fmtMinutes(ms: number | null | undefined): string {
  if (!ok(ms)) return PLACEHOLDER;
  return `${(Math.max(0, ms) / 60_000).toFixed(1)} min`;
}

/** File size in B / KB / MB / GB (1 KB = 1024 B). */
export function fmtBytes(n: number | null | undefined): string {
  if (!ok(n) || n < 0) return PLACEHOLDER;
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** Share 0–1 as `25 %`. */
export function fmtShare(x: number | null | undefined): string {
  return ok(x) ? `${Math.round(x * 100)} %` : PLACEHOLDER;
}

/**
 * Signed number with a unit and the real minus sign (U+2212), e.g. `+12.3 dB`, `−4 ppm`, `0.0 dB`
 * (also a calibration margin: one decimal, so a failing 9.6 dB never reads as a passing `+10 dB`).
 */
export function fmtSigned(x: number | null | undefined, unit: string, digits = 1): string {
  if (!ok(x)) return PLACEHOLDER;
  const n = Number(x.toFixed(digits));
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(digits)} ${unit}`;
}

/** `−24 dB`, `0 dB`, `−∞ dB`; `– dB` when there is no level (null, NaN). Uses the real minus sign (U+2212). */
export function formatDb(db: number | null | undefined): string {
  if (typeof db !== "number" || Number.isNaN(db)) return `${PLACEHOLDER} dB`;
  if (db === Number.NEGATIVE_INFINITY) return "−∞ dB";
  if (db === Number.POSITIVE_INFINITY) return "+∞ dB";
  const r = Math.round(db);
  if (r === 0) return "0 dB"; // also −0
  return r < 0 ? `−${-r} dB` : `+${r} dB`;
}

/** `1 track`, `3 tracks` (regular English plurals only). */
export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function fmtTime(ts: number | null | undefined): string {
  if (!ts) return PLACEHOLDER;
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function quotaText(q: { used: number; limit: number | null }): string {
  return q.limit === null ? `${q.used}` : `${q.used}/${q.limit}`;
}
