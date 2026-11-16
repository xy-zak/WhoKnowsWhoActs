import { reduceEvents, type Scenario, type StoredEvent, type StoredTelemetry, seatList } from "@wkwa/shared";
import { useEffect, useMemo, useState } from "react";
import { fmtDuration } from "../common/format";
import { CompositeMap, PlayerMirrors } from "./Composite";
import type { FacilitatorConnection } from "./connection";
import { EventLog, summarise } from "./EventLog";
import { Timeline } from "./Timeline";

interface Loaded {
  sessionId: string;
  events: StoredEvent[];
  telemetry: StoredTelemetry[];
  scenario: Scenario;
  hashMatches: boolean;
}

/**
 * Replay: the same reducer that runs the live game rebuilds the state at any
 * moment of a recorded session, so the composite and every player's view can
 * be inspected exactly as they were.
 */
export function Replay({
  conn,
  sessionId,
  onPick,
}: {
  conn: FacilitatorConnection;
  sessionId: string | null;
  onPick: (id: string) => void;
}) {
  const [sessions, setSessions] = useState<Array<{ id: string; status: string; createdWall: string }>>([]);
  const [data, setData] = useState<Loaded | null>(null);
  const [cursor, setCursor] = useState(0);
  const [speed, setSpeed] = useState(0);

  useEffect(() => {
    conn
      .api<Array<{ id: string; status: string; createdWall: string }>>("/api/sessions")
      .then(setSessions, () => {});
  }, [conn]);

  useEffect(() => {
    if (!sessionId) return;
    setData(null);
    setSpeed(0);
    Promise.all([
      conn.api<StoredEvent[]>(`/api/sessions/${sessionId}/events`),
      conn.api<StoredTelemetry[]>(`/api/sessions/${sessionId}/telemetry`),
      conn.api<{ scenario: Scenario; hashMatches: boolean }>(`/api/sessions/${sessionId}/scenario`),
    ]).then(
      ([events, telemetry, sc]) => {
        setData({ sessionId, events, telemetry, scenario: sc.scenario, hashMatches: sc.hashMatches });
        setCursor(events[0]?.serverTs ?? 0);
      },
      () => {},
    );
  }, [conn, sessionId]);

  const start = data?.events[0]?.serverTs ?? 0;
  const end = data?.events.at(-1)?.serverTs ?? 0;

  // playback
  useEffect(() => {
    if (!speed || !data) return;
    const t = setInterval(() => {
      setCursor((c) => {
        const next = c + 100 * speed;
        if (next >= end) {
          setSpeed(0);
          return end;
        }
        return next;
      });
    }, 100);
    return () => clearInterval(t);
  }, [speed, data, end]);

  // the slider's value loses sub-millisecond precision: at the end, include everything
  const upto = useMemo(
    () => (data ? (cursor >= end - 1 ? data.events : data.events.filter((e) => e.serverTs <= cursor)) : []),
    [data, cursor, end],
  );
  const state = useMemo(() => (data ? reduceEvents(upto) : null), [data, upto]);
  const presence = useMemo(() => {
    const p: Record<number, string | null> = {};
    if (!data) return p;
    for (const t of data.telemetry) {
      if (t.type !== "region_hover") continue;
      const pl = t.payload as { regionId: string; durationMs: number };
      if (t.clientTs - pl.durationMs <= cursor && cursor <= t.clientTs) p[t.seat] = pl.regionId;
    }
    return p;
  }, [data, cursor]);

  if (!sessionId) {
    return (
      <div className="panel col">
        <h2>Replay a session</h2>
        {sessions.map((s) => (
          <button type="button" key={s.id} onClick={() => onPick(s.id)} style={{ textAlign: "left" }}>
            <span className="mono">{s.id}</span> · {s.status} · {s.createdWall.slice(0, 16).replace("T", " ")}
          </button>
        ))}
        {sessions.length === 0 && <span className="muted">No sessions recorded yet.</span>}
      </div>
    );
  }
  if (!data || !state) return <div className="panel">Loading {sessionId}…</div>;

  const regionName = (id: string) => data.scenario.regions.find((r) => r.id === id)?.name ?? id;
  const current = upto.at(-1);
  const stepTo = (dir: 1 | -1) => {
    const idx = upto.length - 1;
    const target = data.events[Math.max(0, Math.min(data.events.length - 1, idx + dir))];
    if (target) setCursor(target.serverTs);
  };
  const seats = seatList(state)
    .filter((s) => s.bound || s.withdrawn)
    .map((s) => s.seat);

  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="panel col">
        <div className="row">
          <strong>Replay</strong>
          <span className="mono">{data.sessionId}</span>
          <span className="pill">{state.phase}</span>
          {state.round > 0 && <span className="pill">round {state.round}</span>}
          {state.paused && <span className="pill bad">paused</span>}
          {!data.hashMatches && <span className="pill warn">scenario files changed since recording</span>}
          <span className="spacer" />
          <button type="button" className="small" onClick={() => onPick("")}>
            Other session…
          </button>
        </div>
        <div className="row">
          <button type="button" onClick={() => stepTo(-1)} title="Previous event">
            ⏮
          </button>
          {speed ? (
            <button type="button" onClick={() => setSpeed(0)}>
              ⏸
            </button>
          ) : (
            <button type="button" onClick={() => setSpeed(4)}>
              ▶
            </button>
          )}
          <button type="button" onClick={() => stepTo(1)} title="Next event">
            ⏭
          </button>
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
            <option value={0}>paused</option>
            <option value={1}>1×</option>
            <option value={4}>4×</option>
            <option value={16}>16×</option>
            <option value={64}>64×</option>
          </select>
          <input
            type="range"
            min={start}
            max={end}
            step="any"
            value={cursor}
            onChange={(e) => setCursor(Number(e.target.value))}
            style={{ flex: 1 }}
          />
          <span className="mono small">
            {fmtDuration(cursor - start)} / {fmtDuration(end - start)}
          </span>
        </div>
        {current && (
          <div className="small">
            <span className="mono">#{current.seq}</span> {current.type}
            {current.seat ? ` · seat ${current.seat}` : ""} — {summarise(current, regionName)}
          </div>
        )}
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 3fr) minmax(0, 2fr)",
          gap: 10,
          alignItems: "start",
        }}
      >
        <CompositeMap scenario={data.scenario} state={state} presence={presence} />
        <PlayerMirrors scenario={data.scenario} state={state} presence={presence} now={cursor} />
      </div>
      <Timeline events={data.events} seats={seats} now={end} cursorTs={cursor} />
      <EventLog events={upto} state={state} regionName={regionName} highlightSeq={current?.seq} />
    </div>
  );
}
