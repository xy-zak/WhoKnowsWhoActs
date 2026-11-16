import { SEAT_COLOURS, type StoredEvent } from "@wkwa/shared";
import { DECIDE_COLOUR, PROPOSE_COLOUR } from "../map/MapView";

/**
 * Swimlane timeline: one lane per seat, proposals (○) and decisions (■) over
 * time, round boundaries and pauses. Optional cursor for replay.
 */
export function Timeline({
  events,
  seats,
  now,
  cursorTs,
}: {
  events: StoredEvent[];
  seats: number[];
  now: number;
  cursorTs?: number;
}) {
  const start = events.find((e) => e.type === "RoundStarted")?.serverTs ?? events[0]?.serverTs;
  if (start === undefined || seats.length === 0) return null;
  const end = Math.max(now, (events.at(-1)?.serverTs ?? start) + 1000, start + 60_000);
  const W = 1000;
  const laneH = 26;
  const top = 18;
  const H = top + seats.length * laneH + 8;
  const x = (ts: number) => 60 + ((ts - start) / (end - start)) * (W - 70);

  const rounds: Array<{ round: number; s: number; e: number | null }> = [];
  const pauses: Array<{ s: number; e: number | null }> = [];
  for (const ev of events) {
    if (ev.type === "RoundStarted") rounds.push({ round: ev.payload.round, s: ev.serverTs, e: null });
    if (ev.type === "RoundCompleted") {
      const r = rounds.find((x) => x.round === ev.payload.round);
      if (r) r.e = ev.serverTs;
    }
    if (ev.type === "GamePaused") pauses.push({ s: ev.serverTs, e: null });
    if (ev.type === "GameResumed" || ev.type === "RoundCompleted") {
      const p = pauses.at(-1);
      if (p && p.e === null) p.e = ev.serverTs;
    }
  }
  const revoked = new Set(
    events
      .filter((e) => e.type === "ActionRevoked")
      .map((e) => (e.payload as { targetSeq: number }).targetSeq),
  );

  return (
    <div className="panel col">
      <div className="row">
        <strong>Timeline</strong>
        <span className="small muted">○ propose · ■ decide · shaded = paused · minutes since round 1</span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: "100%", height: "auto" }}
        role="img"
        aria-label="Timeline"
      >
        {rounds.map((r) => (
          <g key={r.round}>
            <rect
              x={x(r.s)}
              y={top - 4}
              width={Math.max(1, x(r.e ?? now) - x(r.s))}
              height={H - top}
              fill={r.round % 2 ? "#f3f1ea" : "#e9eef3"}
            />
            <text x={x(r.s) + 3} y={11} fontSize={11} fill="#555">
              Round {r.round}
            </text>
          </g>
        ))}
        {pauses.map((p) => (
          <rect
            key={p.s}
            x={x(p.s)}
            y={top - 4}
            width={Math.max(1, x(p.e ?? now) - x(p.s))}
            height={H - top}
            fill="#c93c37"
            opacity={0.15}
          />
        ))}
        {seats.map((s, i) => (
          <g key={s}>
            <line
              x1={60}
              x2={W - 10}
              y1={top + i * laneH + laneH / 2}
              y2={top + i * laneH + laneH / 2}
              stroke="#ddd"
            />
            <circle cx={12} cy={top + i * laneH + laneH / 2} r={6} fill={SEAT_COLOURS[s]} />
            <text x={22} y={top + i * laneH + laneH / 2 + 4} fontSize={12}>
              seat {s}
            </text>
          </g>
        ))}
        {events.map((e) => {
          if ((e.type !== "ProposalMade" && e.type !== "DecisionMade") || e.seat === null) return null;
          const lane = seats.indexOf(e.seat);
          if (lane < 0) return null;
          const cx = x(e.serverTs);
          const cy = top + lane * laneH + laneH / 2;
          const op = revoked.has(e.seq) ? 0.25 : 1;
          return e.type === "ProposalMade" ? (
            <circle
              key={e.seq}
              cx={cx}
              cy={cy}
              r={5}
              fill="white"
              stroke={PROPOSE_COLOUR}
              strokeWidth={2.5}
              opacity={op}
            >
              <title>{`#${e.seq} propose ${e.payload.regionId}`}</title>
            </circle>
          ) : (
            <rect
              key={e.seq}
              x={cx - 4.5}
              y={cy - 4.5}
              width={9}
              height={9}
              fill={DECIDE_COLOUR}
              opacity={op}
            >
              <title>{`#${e.seq} decide ${e.payload.regionId}`}</title>
            </rect>
          );
        })}
        {[0, 0.25, 0.5, 0.75, 1].map((f) => {
          const ts = start + f * (end - start);
          return (
            <text key={f} x={x(ts)} y={H - 1} fontSize={10} fill="#888" textAnchor="middle">
              {((ts - start) / 60_000).toFixed(1)}
            </text>
          );
        })}
        {cursorTs !== undefined && (
          <line x1={x(cursorTs)} x2={x(cursorTs)} y1={top - 6} y2={H} stroke="#111" strokeWidth={2} />
        )}
      </svg>
    </div>
  );
}
