import { reduceEvents, type Scenario, type StoredEvent, type StoredTelemetry, seatList } from "@wkwa/shared";
import { useEffect, useMemo, useState } from "react";
import { fmtDuration } from "../common/format";
import { useLatest } from "../net/latest";
import { Button, GridTable, Panel, StatusTag } from "../ui";
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

/** Playback rhythm: every propose/decide action is shown for exactly this long. */
const MS_PER_ACTION = 1000;

const isAction = (e: StoredEvent) => e.type === "ProposalMade" || e.type === "DecisionMade";

/**
 * Next playback position after `cursor` (= number of events applied): up to and
 * including the next action, or up to the end of the round if it ends first.
 * Everything between two actions (round starts, joins, notes…) is applied at once.
 */
export function nextBeat(events: StoredEvent[], cursor: number): { cursor: number; roundEnd: boolean } {
  for (let j = cursor; j < events.length; j++) {
    const e = events[j]!;
    if (isAction(e)) return { cursor: j + 1, roundEnd: false };
    if (e.type === "RoundCompleted") {
      // include what follows directly (e.g. GameCompleted) up to the next round start or action
      let k = j + 1;
      while (k < events.length && events[k]!.type !== "RoundStarted" && !isAction(events[k]!)) k++;
      return { cursor: k, roundEnd: true };
    }
  }
  return { cursor: events.length, roundEnd: true };
}

/** Previous playback position: just after the action before the last applied one. */
export function prevBeat(events: StoredEvent[], cursor: number): number {
  let seen = 0;
  for (let j = cursor - 1; j >= 0; j--) {
    if (isAction(events[j]!) || events[j]!.type === "RoundCompleted") {
      seen++;
      if (seen === 2) return j + 1;
    }
  }
  const first = events.findIndex(isAction);
  return Math.max(first, 0);
}

/**
 * Replay: the same reducer that runs the live game rebuilds the state at any
 * moment of a recorded session, so the composite and every player's view can
 * be inspected exactly as they were. Playback is paced per action
 * (MS_PER_ACTION each) and pauses at the end of every round.
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
  /** number of events applied (0 … events.length) */
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);

  const latestList = useLatest();
  const latestSession = useLatest();

  useEffect(() => {
    const ifLatest = latestList();
    conn
      .api<Array<{ id: string; status: string; createdWall: string }>>("/api/sessions")
      .then(ifLatest(setSessions), () => {});
  }, [conn, latestList]);

  useEffect(() => {
    if (!sessionId) return;
    const ifLatest = latestSession();
    setData(null);
    setPlaying(false);
    Promise.all([
      conn.api<StoredEvent[]>(`/api/sessions/${sessionId}/events`),
      conn.api<StoredTelemetry[]>(`/api/sessions/${sessionId}/telemetry`),
      conn.api<{ scenario: Scenario; hashMatches: boolean }>(`/api/sessions/${sessionId}/scenario`),
    ]).then(
      ifLatest(([events, telemetry, sc]) => {
        setData({ sessionId, events, telemetry, scenario: sc.scenario, hashMatches: sc.hashMatches });
        // start just before the first action: setup and round 1's start already applied
        const first = events.findIndex(isAction);
        setCursor(first < 0 ? events.length : first);
      }),
      () => {},
    );
  }, [conn, sessionId, latestSession]);

  const events = data?.events ?? [];
  const end = data?.events.at(-1)?.serverTs ?? 0;
  const totalActions = useMemo(() => events.filter(isAction).length, [events]);

  // playback: one action per MS_PER_ACTION; pause at each round end
  useEffect(() => {
    if (!playing || !data) return;
    const t = setTimeout(() => {
      if (cursor >= data.events.length) return setPlaying(false);
      const b = nextBeat(data.events, cursor);
      setCursor(b.cursor);
      if (b.roundEnd) setPlaying(false);
    }, MS_PER_ACTION);
    return () => clearTimeout(t);
  }, [playing, data, cursor]);

  const upto = useMemo(() => events.slice(0, cursor), [events, cursor]);
  const actionsShown = useMemo(() => upto.filter(isAction).length, [upto]);
  /** time of the replayed moment (server clock), for hover positions and the timeline cursor */
  const momentTs = upto.at(-1)?.serverTs ?? events[0]?.serverTs ?? 0;
  const state = useMemo(() => (data ? reduceEvents(upto) : null), [data, upto]);
  const presence = useMemo(() => {
    const p: Record<number, string | null> = {};
    if (!data) return p;
    for (const t of data.telemetry) {
      if (t.type !== "region_hover") continue;
      const pl = t.payload as { regionId: string; durationMs: number };
      if (t.clientTs - pl.durationMs <= momentTs && momentTs <= t.clientTs) p[t.seat] = pl.regionId;
    }
    return p;
  }, [data, momentTs]);

  if (!sessionId) {
    return (
      <Panel title="Replay · choose a session" icon="replay">
        <div className="col">
          <span className="hint">
            Every recorded session can be scrubbed through with the same reducer that ran it live.
          </span>
          <GridTable empty={sessions.length === 0 && "No sessions recorded yet."}>
            {sessions.map((s) => (
              <tr key={s.id} onClick={() => onPick(s.id)} style={{ cursor: "pointer" }}>
                <td className="mono">{s.id}</td>
                <td>
                  <StatusTag>{s.status.replace("_", " ")}</StatusTag>
                </td>
                <td className="small">{s.createdWall.slice(0, 16).replace("T", " ")}</td>
                <td style={{ textAlign: "right" }}>
                  <Button size="sm" icon="start" tip="Step through this session's events from the start">
                    Replay
                  </Button>
                </td>
              </tr>
            ))}
          </GridTable>
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
    setPlaying(false);
    setCursor(dir === 1 ? nextBeat(data.events, cursor).cursor : prevBeat(data.events, cursor));
  };
  const play = () => {
    if (cursor >= data.events.length) {
      const first = data.events.findIndex(isAction);
      setCursor(Math.max(first, 0)); // replay from the start
    }
    setPlaying(true);
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
          <Button size="sm" icon="back" onClick={() => onPick("")} tip="Back to the list of sessions">
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
            <Button iconOnly icon="back" title="Previous action" onClick={() => stepTo(-1)} />
            {playing ? (
              <Button iconOnly icon="pause" title="Pause playback" onClick={() => setPlaying(false)} />
            ) : (
              <Button iconOnly variant="primary" icon="start" title="Play (1 s per action)" onClick={play} />
            )}
            <Button iconOnly icon="next" title="Next action" onClick={() => stepTo(1)} />
            <input
              type="range"
              aria-label="Replay position"
              min={0}
              max={events.length}
              step={1}
              value={cursor}
              onChange={(e) => {
                setPlaying(false);
                setCursor(Number(e.target.value));
              }}
              style={{ flex: 1 }}
            />
            <span className="mono small">
              action {actionsShown}/{totalActions} · {fmtDuration(actionsShown * MS_PER_ACTION)} /{" "}
              {fmtDuration(totalActions * MS_PER_ACTION)}
            </span>
          </div>
          <span className="hint">
            Playback shows every action for {MS_PER_ACTION / 1000} s and pauses at the end of each round
            (press play to continue). The slider moves event by event.
            {!playing && state.phase === "round_complete" && cursor < events.length && (
              <strong className="t-primary">
                {" "}
                Round {state.round} complete, press play for round {state.round + 1}.
              </strong>
            )}
          </span>
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
        <PlayerMirrors scenario={data.scenario} state={state} presence={presence} now={momentTs} />
      </div>
      <Timeline events={data.events} seats={seats} now={end} cursorTs={momentTs} />
      <EventLog events={upto} state={state} regionName={regionName} highlightSeq={current?.seq} />
    </div>
  );
}
