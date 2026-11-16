import {
  EVENT_TYPES,
  type GameState,
  SEAT_COLOURS,
  type StoredEvent,
  type StoredTelemetry,
} from "@wkwa/shared";
import { Fragment, useMemo, useState } from "react";

function ms(ts: number) {
  const d = new Date(ts);
  return `${d.toLocaleTimeString([], { hour12: false })}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

/** One-line human summary of an event payload. */
export function summarise(ev: StoredEvent, regionName: (id: string) => string): string {
  switch (ev.type) {
    case "ProposalMade":
    case "DecisionMade": {
      const p = ev.payload;
      const prior = [
        p.priorProposals.length ? `proposed before by ${p.priorProposals.join(",")}` : "",
        p.priorDecisions.length ? `decided before by ${p.priorDecisions.join(",")}` : "",
      ]
        .filter(Boolean)
        .join("; ");
      return `${regionName(p.regionId)} (${p.quotaUsed}/${p.quotaLimit ?? "∞"})${prior ? ` — ${prior}` : ""}`;
    }
    case "IntentRejected":
      return `${ev.payload.kind} ${regionName(ev.payload.regionId)}: ${ev.payload.reason}`;
    case "ActionRevoked":
      return `#${ev.payload.targetSeq} ${ev.payload.targetType} by seat ${ev.payload.targetSeat}${ev.payload.reason ? ` (${ev.payload.reason})` : ""}`;
    case "RoundStarted":
      return `round ${ev.payload.round} (${ev.payload.startedBy})`;
    case "RoundCompleted":
      return `round ${ev.payload.round}: ${ev.payload.reason}, ${Math.round(ev.payload.durationMs / 1000)} s`;
    case "LabelsAssigned":
      return `${ev.payload.assignments.map((a) => `${a.seat}:${a.k}/${a.p}`).join(" ")} (${ev.payload.method})`;
    case "SeatBound":
      return `terminal ${ev.payload.terminal} → seat ${ev.payload.seat}`;
    case "ConsentRecorded":
      return ev.payload.consented ? "consent given" : "consent DECLINED";
    case "DemographicsSubmitted":
      return "submitted (answers hidden)";
    case "GamePaused":
      return ev.payload.reason === "disconnect"
        ? `auto-pause: seat ${ev.payload.seat} disconnected`
        : "paused";
    case "GameResumed":
      return `after ${Math.round(ev.payload.pausedMs / 1000)} s`;
    case "PlayerDisconnected":
      return ev.payload.reason;
    case "PlayerConnected":
      return ev.payload.reconnect ? "reconnected" : "connected";
    case "FacilitatorBroadcast":
    case "SessionNote":
      return `“${ev.payload.text}”`;
    case "ParticipantWithdrawn":
      return `seat ${ev.payload.seat} (${ev.payload.by})`;
    case "GameCompleted":
      return `${ev.payload.roundsPlayed} rounds, ${ev.payload.reason}`;
    default:
      return "";
  }
}

export function EventLog({
  events,
  state,
  regionName,
  onRevoke,
  highlightSeq,
  maxHeight = 360,
}: {
  events: StoredEvent[];
  state: GameState | null;
  regionName: (id: string) => string;
  onRevoke?: (seq: number) => void;
  highlightSeq?: number;
  maxHeight?: number;
}) {
  const [type, setType] = useState("");
  const [seat, setSeat] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const rows = useMemo(
    () =>
      events
        .filter((e) => (!type || e.type === type) && (!seat || String(e.seat) === seat))
        .slice(-1000)
        .reverse(),
    [events, type, seat],
  );
  const revocable = (e: StoredEvent) =>
    onRevoke &&
    state?.phase === "round_active" &&
    (e.type === "ProposalMade" || e.type === "DecisionMade") &&
    e.round === state.round &&
    !state.actions.find((a) => a.seq === e.seq)?.revoked;

  return (
    <div className="panel col">
      <div className="row">
        <strong>Event log</strong>
        <span className="muted small">{events.length} events</span>
        <span className="spacer" />
        <select value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">all types</option>
          {EVENT_TYPES.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
        <select value={seat} onChange={(e) => setSeat(e.target.value)}>
          <option value="">all seats</option>
          {[1, 2, 3, 4].map((s) => (
            <option key={s} value={s}>
              seat {s}
            </option>
          ))}
        </select>
      </div>
      <div style={{ maxHeight, overflow: "auto" }}>
        <table className="grid">
          <thead>
            <tr>
              <th>#</th>
              <th>time</th>
              <th>R</th>
              <th>type</th>
              <th>seat</th>
              <th>details</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <Fragment key={e.seq}>
                <tr
                  onClick={() => setOpen(open === e.seq ? null : e.seq)}
                  style={{ cursor: "pointer", background: e.seq === highlightSeq ? "#fff3c4" : undefined }}
                >
                  <td className="mono">{e.seq}</td>
                  <td className="mono small">{ms(e.serverTs)}</td>
                  <td>{e.round || ""}</td>
                  <td>{e.type}</td>
                  <td>
                    {e.seat && (
                      <>
                        <span className="seat-dot" style={{ background: SEAT_COLOURS[e.seat] }} /> {e.seat}
                      </>
                    )}
                  </td>
                  <td className="small">{summarise(e, regionName)}</td>
                  <td>
                    {revocable(e) && (
                      <button
                        type="button"
                        className="small danger"
                        onClick={(x) => {
                          x.stopPropagation();
                          onRevoke!(e.seq);
                        }}
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
                {open === e.seq && (
                  <tr>
                    <td colSpan={7}>
                      <pre className="mono small" style={{ margin: 0, whiteSpace: "pre-wrap" }}>
                        {JSON.stringify({ ...e, payload: e.payload }, null, 2)}
                      </pre>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function TelemetryFeed({
  items,
  regionName,
}: {
  items: StoredTelemetry[];
  regionName: (id: string) => string;
}) {
  const rows = items.slice(-150).reverse();
  return (
    <div className="panel col">
      <div className="row">
        <strong>Live telemetry</strong>
        <span className="muted small">last {rows.length} items (state acks and clock syncs hidden)</span>
      </div>
      <div style={{ maxHeight: 260, overflow: "auto" }}>
        <table className="grid">
          <tbody>
            {rows.map((t) => {
              const p = t.payload as Record<string, unknown>;
              const detail = Object.entries(p)
                .map(([k, v]) =>
                  k === "regionId"
                    ? regionName(String(v))
                    : `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`,
                )
                .join(" ");
              return (
                <tr key={t.id}>
                  <td className="mono small">{ms(t.clientTs)}</td>
                  <td>
                    <span className="seat-dot" style={{ background: SEAT_COLOURS[t.seat] }} /> {t.seat}
                  </td>
                  <td>{t.type}</td>
                  <td className="small">{detail}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
