import { reduceEvents, type Scenario, type StoredEvent, type StoredTelemetry, seatList } from "@wkwa/shared";
import { useEffect, useMemo, useState } from "react";
import { fmtDuration } from "../common/format";
import { Button, Panel, StatusTag } from "../ui";
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
      <Panel title="Replay · choose a session" icon="replay">
        <div className="col">
          <span className="hint">
            Every recorded session can be scrubbed through with the same reducer that ran it live.
          </span>
          <table className="grid">
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id} onClick={() => onPick(s.id)} style={{ cursor: "pointer" }}>
                  <td className="mono">{s.id}</td>
                  <td>
                    <StatusTag>{s.status.replace("_", " ")}</StatusTag>
                  </td>
                  <td className="small">{s.createdWall.slice(0, 16).replace("T", " ")}</td>
                  <td style={{ textAlign: "right" }}>
                    <Button size="sm" icon="start">
                      Replay
                    </Button>
                  </td>
                </tr>
              ))}
              {sessions.length === 0 && (
                <tr>
                  <td className="faint">No sessions recorded yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    );
  }
  if (!data || !state)
    return (
      <Panel title="Replay" icon="replay">
        <span className="cursor muted">Loading {sessionId}</span>
      </Panel>
    );

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
    <div className="col" style={{ gap: "var(--s3)" }}>
      <Panel
        title={`Replay · ${data.sessionId}`}
        icon="replay"
        actions={
          <Button size="sm" icon="back" onClick={() => onPick("")}>
            Other session
          </Button>
        }
      >
        <div className="col">
          <div className="row">
            <StatusTag tone="primary">{state.phase.replace("_", " ")}</StatusTag>
            {state.round > 0 && <StatusTag>round {state.round}</StatusTag>}
            {state.paused && (
              <StatusTag tone="warn" icon="pause">
                paused
              </StatusTag>
            )}
            {state.config.tags.map((t) => (
              <StatusTag key={t} icon="tag">
                {t}
              </StatusTag>
            ))}
            {!data.hashMatches && (
              <StatusTag tone="warn" icon="warning">
                scenario files changed since recording
              </StatusTag>
            )}
          </div>
          <div className="row nowrap">
            <Button iconOnly icon="back" title="Previous event" onClick={() => stepTo(-1)} />
            {speed ? (
              <Button iconOnly icon="pause" title="Pause playback" onClick={() => setSpeed(0)} />
            ) : (
              <Button iconOnly variant="primary" icon="start" title="Play" onClick={() => setSpeed(4)} />
            )}
            <Button iconOnly icon="next" title="Next event" onClick={() => stepTo(1)} />
            <select
              aria-label="Playback speed"
              value={speed}
              onChange={(e) => setSpeed(Number(e.target.value))}
            >
              <option value={0}>paused</option>
              <option value={1}>1×</option>
              <option value={4}>4×</option>
              <option value={16}>16×</option>
              <option value={64}>64×</option>
            </select>
            <input
              type="range"
              aria-label="Replay position"
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
              <span className="faint">#{current.seq}</span> <strong>{current.type}</strong>
              {current.seat ? ` · seat ${current.seat}` : ""} — {summarise(current, regionName)}
            </div>
          )}
        </div>
      </Panel>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 3fr) minmax(0, 2fr)",
          gap: "var(--s3)",
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
