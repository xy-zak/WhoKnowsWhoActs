import { type ActionKind, type PlayerView, SEAT_COLOURS } from "@wkwa/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fmtDuration, quotaText, remaining } from "../common/format";
import { DECIDE_COLOUR, MapLegend, MapView, PROPOSE_COLOUR } from "../map/MapView";
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
  const canDo = (k: ActionKind) => active && remaining(q[k]) > 0;

  const setTool = useCallback(
    (t: ActionKind | null) => {
      setToolState(t);
      conn.track("tool_select", { tool: t });
    },
    [conn],
  );

  // keyboard shortcuts: P / D / Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === "p" || e.key === "P") setTool(tool === "propose" ? null : "propose");
      else if (e.key === "d" || e.key === "D") setTool(tool === "decide" ? null : "decide");
      else if (e.key === "Escape") {
        if (draft) cancelDraft();
        else setTool(null);
      }
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
    if (!draft) return;
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
    <div style={{ display: "grid", gridTemplateRows: "auto auto 1fr", height: "100%", gap: 8, padding: 8 }}>
      <Header view={view} conn={conn} />
      <div className="row panel" style={{ padding: "0.5rem 0.8rem" }}>
        <strong>Tool:</strong>
        <ToolButton
          kind="propose"
          tool={tool}
          setTool={setTool}
          enabled={canDo("propose")}
          q={quotaText(q.propose)}
        />
        <ToolButton
          kind="decide"
          tool={tool}
          setTool={setTool}
          enabled={canDo("decide")}
          q={quotaText(q.decide)}
        />
        <span className="muted small">
          {tool
            ? `Click an area to ${tool} it (Esc to cancel).`
            : "Click an area to see what you know about it. Shortcuts: P / D."}
        </span>
        <span className="spacer" />
        <MapLegend showActors={view.visibility.showActorToPlayers} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 320px", gap: 8, minHeight: 0 }}>
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
        <aside className="col" style={{ minHeight: 0, overflow: "auto" }}>
          <div className="panel">
            {!region ? (
              <p className="muted">Select an area on the map.</p>
            ) : (
              <>
                <div className="row">
                  <h2 style={{ margin: 0 }}>{region.name}</h2>
                  <span className="spacer" />
                  <button type="button" className="small" onClick={() => select(null)}>
                    ✕
                  </button>
                </div>
                {view.me.viewName && <p className="small muted">{view.me.viewName}</p>}
                <table className="grid" style={{ margin: "0.5rem 0" }}>
                  <tbody>
                    {Object.entries(content?.attributes ?? {}).map(([k, val]) => {
                      const def = view.map.attributes.find((a) => a.key === k);
                      return (
                        <tr key={k}>
                          <td>{def?.label ?? k}</td>
                          <td style={{ textAlign: "right", fontWeight: 600 }}>
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
                  <p className="small">
                    {onRegion.map((h) => (
                      <span key={h.seq} className="pill" style={{ marginRight: 4 }}>
                        {h.kind === "propose" ? "Proposed" : "Decided"}
                        {h.seat !== null && (
                          <>
                            {" "}
                            by <span className="seat-dot" style={{ background: SEAT_COLOURS[h.seat] }} />{" "}
                            {h.mine ? "you" : `seat ${h.seat}`}
                          </>
                        )}
                      </span>
                    ))}
                  </p>
                )}
                {draft && draft.regionId === region.id ? (
                  <div className="col" style={{ borderTop: "1px solid var(--border)", paddingTop: 8 }}>
                    <strong>
                      {draft.kind === "propose" ? "Propose" : "Decide"} “{region.name}”?
                    </strong>
                    <div className="row">
                      <button type="button" className="primary" disabled={busy} onClick={confirmDraft}>
                        Confirm
                      </button>
                      <button type="button" disabled={busy} onClick={cancelDraft}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="row">
                    <button
                      type="button"
                      disabled={!canDo("propose")}
                      onClick={() => openDraft("propose", region.id)}
                    >
                      Propose
                    </button>
                    <button
                      type="button"
                      disabled={!canDo("decide")}
                      onClick={() => openDraft("decide", region.id)}
                    >
                      Decide
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
          <OthersPanel view={view} />
          {view.broadcasts.length > 0 && (
            <div className="panel col">
              <strong>Messages</strong>
              {view.broadcasts
                .slice()
                .reverse()
                .map((b) => (
                  <div key={b.seq} className="banner small">
                    {b.text}
                  </div>
                ))}
            </div>
          )}
        </aside>
      </div>
      {view.paused && (
        <div className="overlay">
          <div className="panel">
            <h2>Game paused</h2>
            <p className="muted">
              {view.pauseReason === "disconnect"
                ? "A player lost their connection. The game continues when the facilitator resumes."
                : "The facilitator paused the game. Please wait."}
            </p>
          </div>
        </div>
      )}
      {view.phase === "round_complete" && (
        <div className="overlay">
          <div className="panel">
            <h2>Round {view.round} complete</h2>
            <p className="muted">Waiting for the facilitator to start round {view.round + 1}.</p>
          </div>
        </div>
      )}
    </div>
  );
}

function ToolButton(props: {
  kind: ActionKind;
  tool: ActionKind | null;
  setTool: (t: ActionKind | null) => void;
  enabled: boolean;
  q: string;
}) {
  const on = props.tool === props.kind;
  const colour = props.kind === "propose" ? PROPOSE_COLOUR : DECIDE_COLOUR;
  return (
    <button
      type="button"
      disabled={!props.enabled}
      onClick={() => props.setTool(on ? null : props.kind)}
      style={{
        borderColor: colour,
        background: on ? colour : undefined,
        color: on ? "white" : undefined,
        fontWeight: 600,
      }}
    >
      {props.kind === "propose" ? "Propose" : "Decide"} <span className="small">({props.q})</span>
    </button>
  );
}

function Header({ view, conn }: { view: PlayerView; conn: PlayerConnection }) {
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
    <div className="row panel" style={{ padding: "0.5rem 0.8rem" }}>
      <strong style={{ fontSize: "1.1rem" }}>
        Round {view.round}/{view.roundCount}
      </strong>
      <span className="pill">
        <span className="seat-dot" style={{ background: SEAT_COLOURS[view.me.seat] }} /> Seat {view.me.seat}
      </span>
      {view.me.k && <span className="pill">{view.me.k}</span>}
      {view.me.p && <span className="pill">{view.me.p}</span>}
      <span className="spacer" />
      <span>
        Proposals left: <strong>{fmtLeft(view.me.quota.propose)}</strong>
      </span>
      <span>
        Decisions left: <strong>{fmtLeft(view.me.quota.decide)}</strong>
      </span>
      {left !== null && (
        <span className={`pill ${left < 60_000 ? "bad" : ""}`} style={{ fontSize: "1rem" }}>
          ⏱ {fmtDuration(left)}
        </span>
      )}
    </div>
  );
}

function fmtLeft(q: { used: number; limit: number | null }): string {
  return q.limit === null ? "∞" : String(Math.max(0, q.limit - q.used));
}

function OthersPanel({ view }: { view: PlayerView }) {
  if (view.others.length === 0) return null;
  return (
    <div className="panel col">
      <strong>Other players</strong>
      {view.others.map((o) => (
        <div key={o.seat} className="row small">
          <span className="seat-dot" style={{ background: SEAT_COLOURS[o.seat] }} />
          <span>Seat {o.seat}</span>
          {o.k && <span className="pill">{o.k}</span>}
          {o.p && <span className="pill">{o.p}</span>}
          <span className="spacer" />
          {o.withdrawn ? (
            <span className="pill">left</span>
          ) : !o.connected ? (
            <span className="pill bad">offline</span>
          ) : o.progress ? (
            <span className="muted">
              P {quotaText(o.progress.propose)} · D {quotaText(o.progress.decide)}
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}
