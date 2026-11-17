import { type ActionKind, type PlayerView, quotaLeft } from "@wkwa/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fmtDuration, quotaText } from "../common/format";
import { MapLegend, MapView } from "../map/MapView";
import { AsciiProgress, Button, Icon, Panel, Popup, SeatDot, StatusTag } from "../ui";
import type { PlayerConnection } from "./connection";

const HOVER_MIN_MS = 150;

export function Game({ conn, view }: { conn: PlayerConnection; view: PlayerView }) {
  const [tool, setToolState] = useState<ActionKind | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ kind: ActionKind; regionId: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const inspectOpenedAt = useRef<number | null>(null);
  const hoverStart = useRef<{ id: string; t: number } | null>(null);

  const active = view.phase === "round_active" && !view.paused;
  const q = view.me.quota;
  const canDo = (k: ActionKind) => active && quotaLeft(q[k]) > 0;

  const setTool = useCallback(
    (t: ActionKind | null) => {
      setToolState(t);
      conn.track("tool_select", { tool: t });
    },
    [conn],
  );

  const openDraft = (kind: ActionKind, regionId: string) => {
    if (!canDo(kind)) return;
    setDraft({ kind, regionId });
    conn.track("action_draft", { kind, regionId, outcome: "opened" });
  };
  const cancelDraft = () => {
    if (draft) conn.track("action_draft", { ...draft, outcome: "cancelled" });
    setDraft(null);
  };
  const confirmDraft = async () => {
    if (!draft || busy) return;
    const d = draft;
    conn.track("action_draft", { ...d, outcome: "confirmed" });
    setBusy(true);
    try {
      const ack = await conn.request<{ ok: boolean; detail?: string }>("intent", {
        clientSeq: conn.nextClientSeq(),
        kind: d.kind,
        regionId: d.regionId,
        clientTs: conn.clock.now(),
      });
      if (!ack.ok) conn.showToast(ack.detail ?? "Action not possible");
    } catch (e) {
      conn.showToast((e as Error).message);
    } finally {
      setBusy(false);
      setDraft(null);
    }
  };

  // keyboard: P / D tools, Enter confirms, Esc cancels
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "Enter" && draft) {
        e.preventDefault();
        void confirmDraft();
      } else if (e.key === "Escape") {
        if (draft) cancelDraft();
        else if (tool) setTool(null);
      } else if (e.key === "p" || e.key === "P") setTool(tool === "propose" ? null : "propose");
      else if (e.key === "d" || e.key === "D") setTool(tool === "decide" ? null : "decide");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // drop the tool when its quota is used up
  useEffect(() => {
    if (tool && !canDo(tool)) setToolState(null);
  });

  const closeInspect = useCallback(() => {
    if (selected && inspectOpenedAt.current !== null) {
      conn.track("region_inspect", {
        regionId: selected,
        action: "close",
        durationMs: Math.round(performance.now() - inspectOpenedAt.current),
      });
    }
    inspectOpenedAt.current = null;
  }, [selected, conn]);

  const select = (id: string | null) => {
    if (id === selected) return;
    closeInspect();
    setSelected(id);
    if (id) {
      inspectOpenedAt.current = performance.now();
      conn.track("region_inspect", { regionId: id, action: "open", durationMs: null });
    }
  };

  const onRegionClick = (id: string) => {
    select(id);
    if (tool) openDraft(tool, id);
    else setDraft(null);
  };
  const onEnter = (id: string) => {
    hoverStart.current = { id, t: performance.now() };
    conn.presence(id);
  };
  const onLeave = (id: string) => {
    const h = hoverStart.current;
    if (h && h.id === id) {
      const dur = performance.now() - h.t;
      if (dur >= HOVER_MIN_MS) conn.track("region_hover", { regionId: id, durationMs: Math.round(dur) });
    }
    hoverStart.current = null;
    conn.presence(null);
  };

  const fills = useMemo(
    () => Object.fromEntries(Object.entries(view.content).map(([id, c]) => [id, c.fill])),
    [view.content],
  );
  const labels = useMemo(
    () => Object.fromEntries(Object.entries(view.content).map(([id, c]) => [id, c.label])),
    [view.content],
  );
  const icons = useMemo(
    () => Object.fromEntries(Object.entries(view.content).map(([id, c]) => [id, c.icon])),
    [view.content],
  );

  const region = view.map.regions.find((r) => r.id === selected);
  const content = selected ? view.content[selected] : undefined;
  const onRegion = view.highlights.filter((h) => h.regionId === selected);

  return (
    <div
      style={{
        display: "grid",
        gridTemplateRows: "auto auto 1fr",
        height: "100%",
        gap: "var(--s2)",
        padding: "var(--s2) var(--s3) var(--s3)",
      }}
    >
      <StatusLine view={view} conn={conn} />
      <div className="row panel" style={{ padding: "var(--s2) var(--s3)", marginTop: 0 }}>
        <span className="small upper muted">Tool</span>
        <Button
          icon="propose"
          kbd="P"
          active={tool === "propose"}
          disabled={!canDo("propose")}
          onClick={() => setTool(tool === "propose" ? null : "propose")}
          className={tool === "propose" ? "t-propose" : ""}
        >
          Propose {quotaText(q.propose)}
        </Button>
        <Button
          icon="decide"
          kbd="D"
          active={tool === "decide"}
          disabled={!canDo("decide")}
          onClick={() => setTool(tool === "decide" ? null : "decide")}
          className={tool === "decide" ? "t-decide" : ""}
        >
          Decide {quotaText(q.decide)}
        </Button>
        <span className="hint cursor">
          {tool
            ? `Click an area to ${tool} it · Esc to cancel`
            : "Click an area to see what you know about it"}
        </span>
        <span className="spacer" />
        <MapLegend showActors={view.visibility.showActorToPlayers} />
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) 340px",
          gap: "var(--s3)",
          minHeight: 0,
        }}
      >
        <MapView
          geometry={view.map}
          fills={fills}
          labels={labels}
          icons={icons}
          highlights={view.highlights}
          selectedRegionId={selected}
          interactive
          zoomable
          showNames
          onRegionClick={onRegionClick}
          onRegionEnter={onEnter}
          onRegionLeave={onLeave}
          onViewChange={(v) => conn.track("map_view_change", v)}
        />
        <aside className="col" style={{ minHeight: 0, overflow: "auto", gap: "var(--s2)" }}>
          <Panel
            title={region ? region.name : "Area"}
            icon="scenario"
            actions={
              region ? (
                <Button iconOnly variant="ghost" icon="close" title="Close" onClick={() => select(null)} />
              ) : undefined
            }
          >
            {!region ? (
              <p className="muted cursor">Select an area on the map</p>
            ) : (
              <div className="col">
                {view.me.viewName && <span className="small muted upper">{view.me.viewName}</span>}
                <table className="grid">
                  <tbody>
                    {Object.entries(content?.attributes ?? {}).map(([k, val]) => {
                      const def = view.map.attributes.find((a) => a.key === k);
                      return (
                        <tr key={k}>
                          <td className="muted">{def?.label ?? k}</td>
                          <td style={{ textAlign: "right" }} className="strong">
                            {val}
                            {def?.unit ? ` ${def.unit}` : ""}
                          </td>
                        </tr>
                      );
                    })}
                    {Object.keys(content?.attributes ?? {}).length === 0 && (
                      <tr>
                        <td className="muted">You have no information about this area.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
                {content?.notes && <p className="small">{content.notes}</p>}
                {onRegion.length > 0 && (
                  <div className="row" style={{ gap: 4 }}>
                    {onRegion.map((h) => (
                      <StatusTag key={h.seq}>
                        <span className={h.kind === "propose" ? "t-propose" : "t-decide"}>
                          {h.kind === "propose" ? "proposed" : "decided"}
                        </span>
                        {h.seat !== null && (
                          <>
                            {" "}
                            <SeatDot seat={h.seat} /> {h.mine ? "you" : `seat ${h.seat}`}
                          </>
                        )}
                      </StatusTag>
                    ))}
                  </div>
                )}
                {draft && draft.regionId === region.id ? (
                  <div
                    className="callout"
                    style={{
                      borderLeftColor:
                        draft.kind === "propose" ? "var(--propose-text)" : "var(--decide-text)",
                    }}
                  >
                    <div className="strong" style={{ marginBottom: "var(--s2)" }}>
                      <span className={draft.kind === "propose" ? "t-propose" : "t-decide"}>
                        {draft.kind.toUpperCase()}
                      </span>{" "}
                      “{region.name}”?
                    </div>
                    <div className="row">
                      <Button
                        variant="primary"
                        icon="ok"
                        kbd="Enter"
                        disabled={busy}
                        onClick={() => void confirmDraft()}
                      >
                        Confirm
                      </Button>
                      <Button icon="close" kbd="Esc" disabled={busy} onClick={cancelDraft}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="row">
                    <Button
                      icon="propose"
                      disabled={!canDo("propose")}
                      onClick={() => openDraft("propose", region.id)}
                    >
                      Propose
                    </Button>
                    <Button
                      icon="decide"
                      disabled={!canDo("decide")}
                      onClick={() => openDraft("decide", region.id)}
                    >
                      Decide
                    </Button>
                  </div>
                )}
              </div>
            )}
          </Panel>
          <OthersPanel view={view} />
          {view.broadcasts.length > 0 && (
            <Panel title="Messages" icon="broadcast">
              <div className="col">
                {view.broadcasts
                  .slice()
                  .reverse()
                  .map((b) => (
                    <div key={b.seq} className="callout warn small">
                      {b.text}
                    </div>
                  ))}
              </div>
            </Panel>
          )}
        </aside>
      </div>
      {view.paused && (
        <Popup title="Game paused" icon="pause" closable={false} width={520}>
          <p className="cursor">
            {view.pauseReason === "disconnect"
              ? "A player lost their connection. The game continues when the facilitator resumes"
              : "The facilitator paused the game. Please wait"}
          </p>
        </Popup>
      )}
      {view.phase === "round_complete" && (
        <Popup title={`Round ${view.round} complete`} icon="done" closable={false} width={520}>
          <p className="cursor">Waiting for the facilitator to start round {view.round + 1}</p>
        </Popup>
      )}
    </div>
  );
}

function StatusLine({ view, conn }: { view: PlayerView; conn: PlayerConnection }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const limit = view.roundSpec?.timeLimitSec;
  let left: number | null = null;
  if (limit && view.roundStartedTs) {
    const now = conn.clock.now();
    const pausedNow = view.paused && view.pausedSince ? now - view.pausedSince : 0;
    left = limit * 1000 - (now - view.roundStartedTs - view.roundPausedMs - pausedNow);
  }
  return (
    <div className="row panel" style={{ padding: "var(--s2) var(--s3)", marginTop: 0 }}>
      <strong className="upper" style={{ fontSize: "var(--fs-title)" }}>
        Round {view.round}/{view.roundCount}
      </strong>
      <span className="faint">│</span>
      <span className="row nowrap" style={{ gap: 4 }}>
        <SeatDot seat={view.me.seat} /> <strong>SEAT {view.me.seat}</strong>
      </span>
      {view.me.k && <StatusTag icon="labels">{view.me.k}</StatusTag>}
      {view.me.p && <StatusTag>{view.me.p}</StatusTag>}
      <span className="spacer" />
      <span className="row nowrap" style={{ gap: 6 }}>
        <span className="t-propose strong">PROPOSALS</span>{" "}
        <AsciiProgress used={view.me.quota.propose.used} limit={view.me.quota.propose.limit} />
      </span>
      <span className="row nowrap" style={{ gap: 6 }}>
        <span className="t-decide strong">DECISIONS</span>{" "}
        <AsciiProgress used={view.me.quota.decide.used} limit={view.me.quota.decide.limit} />
      </span>
      {left !== null && (
        <StatusTag tone={left < 60_000 ? "danger" : "neutral"} icon="timeline">
          {fmtDuration(left)}
        </StatusTag>
      )}
    </div>
  );
}

function OthersPanel({ view }: { view: PlayerView }) {
  if (view.others.length === 0) return null;
  return (
    <Panel title="Other players" icon="seats">
      <div className="col" style={{ gap: 4 }}>
        {view.others.map((o) => (
          <div key={o.seat} className="row nowrap small">
            <SeatDot seat={o.seat} />
            <span>SEAT {o.seat}</span>
            {o.k && <span className="muted">{o.k}</span>}
            {o.p && <span className="muted">{o.p}</span>}
            <span className="spacer" />
            {o.withdrawn ? (
              <StatusTag>left</StatusTag>
            ) : !o.connected ? (
              <StatusTag tone="danger" icon="disconnected">
                offline
              </StatusTag>
            ) : o.progress ? (
              <span className="muted">
                <span className="t-propose">P</span> {quotaText(o.progress.propose)} ·{" "}
                <span className="t-decide">D</span> {quotaText(o.progress.decide)}
              </span>
            ) : (
              <Icon name="connected" />
            )}
          </div>
        ))}
      </div>
    </Panel>
  );
}
