export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "–";
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m % 60)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

export function fmtTime(ts: number | null | undefined): string {
  if (!ts) return "–";
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function quotaText(q: { used: number; limit: number | null }): string {
  return q.limit === null ? `${q.used}` : `${q.used}/${q.limit}`;
}

export function remaining(q: { used: number; limit: number | null }): number {
  return q.limit === null ? Number.POSITIVE_INFINITY : Math.max(0, q.limit - q.used);
}
