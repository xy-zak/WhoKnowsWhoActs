import {
  type ActionKind,
  cellId,
  cellName,
  getGameRules,
  type Highlight,
  K_LABELS,
  type KLabel,
  type PlayerView,
  quotaLeft,
  roundActiveMs,
} from "@wkwa/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fmtDuration, quotaText } from "../common/format";
import { MapLegend, MapScore, MapView } from "../map/MapView";
import {
  ActSwatch,
  AsciiProgress,
  Button,
  Icon,
  LabelTag,
  Panel,
  Popup,
  SeatDot,
  StatusTag,
  useBusy,
  useNow,
} from "../ui";
import type { PlayerConnection } from "./connection";
import { RecordingProblem, RecordingTag } from "./RecordingIndicator";

const HOVER_MIN_MS = 150;

const VERB: Record<ActionKind, string> = { propose: "proposal", decide: "decision" };

/** "you", "seat 2", … for the actors of a sub-square's highlights. */
function actorsText(hs: Highlight[]): string {
  const names = [
    ...new Set(hs.map((h) => (h.mine ? "you" : h.seat === null ? "a player" : `seat ${h.seat}`))),
  ];
  return names.join(", ");
}

export function Game({ conn, view }: { conn: PlayerConnection; view: PlayerView }) {
  const [tool, setToolState] = useState<ActionKind | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ kind: ActionKind; regionId: string } | null>(null);
  const [busy, run] = useBusy((e) => conn.showToast(e.message));
  const inspectOpenedAt = useRef<number | null>(null);
  const hoverStart = useRef<{ id: string; t: number } | null>(null);

  const rules = getGameRules(view.rules.id);
  const scoreMax = rules?.scoreRange.max ?? 10;
  const active = view.phase === "round_active" && !view.paused;
  const q = view.me.quota;
  const actsOn = view.me.actsOn;
  const canDo = (k: ActionKind) => active && quotaLeft(q[k]) > 0 && actsOn[k] !== null;

  const setTool = useCallback(
    (t: ActionKind | null) => {
      setToolState(t);
      conn.track("tool_select", { tool: t });
    },
    [conn],
  );

  /** Open the confirmation for `kind` on square `square` (lands on the sub-square the rules give this seat). */
  const openDraft = (kind: ActionKind, square: string) => {
    const k = actsOn[kind];
    if (!canDo(kind) || !k) return;
    const regionId = cellId(square, k);
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
    await run(async () => {
      const ack = await conn.intent(d.kind, d.regionId);
      // a resend the server had already stored ("duplicate" without its first answer) is no error
      if (!ack.ok && ack.reason !== "duplicate") conn.showToast(ack.detail || "Action not possible");
    });
    setDraft(null);
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

  const select = (square: string | null) => {
    if (square === selected) return;
    closeInspect();
    setSelected(square);
    if (square) {
      inspectOpenedAt.current = performance.now();
      conn.track("region_inspect", { regionId: square, action: "open", durationMs: null });
    }
  };

  const onSquareClick = (square: string) => {
    select(square);
    if (tool) openDraft(tool, square);
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
  // the pointer never "leaves" a square when the game screen closes under it
  useEffect(() => () => conn.presence(null), [conn]);

  const byCell = useMemo(() => {
    const m = new Map<string, Highlight[]>();
    for (const h of view.highlights) m.set(h.regionId, [...(m.get(h.regionId) ?? []), h]);
    return m;
  }, [view.highlights]);

  const cellTip = (id: string): string | undefined => {
    const hs = byCell.get(id);
    if (!hs || !view.visibility.showActorToPlayers) return undefined;
    const p = hs.filter((h) => h.kind === "propose");
    const d = hs.filter((h) => h.kind === "decide");
    return [p.length ? `proposed by ${actorsText(p)}` : "", d.length ? `decided by ${actorsText(d)}` : ""]
      .filter(Boolean)
      .join(" · ");
  };

  const toolHint = tool
    ? `Click a square: your ${VERB[tool]} lands on its ${actsOn[tool]} sub-square · Esc to cancel`
    : "Click a square to see what you know about it";

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
      <div className="col">
        {/* sessions that record audio: a non-blocking banner while the microphone needs the participant */}
        <RecordingProblem conn={conn} view={view} />
        <StatusLine view={view} conn={conn} scoreMax={scoreMax} decimals={rules?.mapScoreDecimals ?? 2} />
      </div>
      <div className="row panel" style={{ padding: "var(--s2) var(--s3)", marginTop: 0 }}>
        <span className="small upper muted">Tool</span>
        <Button
          icon="propose"
          kbd="P"
          active={tool === "propose"}
          disabled={!canDo("propose")}
          onClick={() => setTool(tool === "propose" ? null : "propose")}
          tip={
            actsOn.propose
              ? `Propose tool: click a square to propose its ${actsOn.propose} sub-square. A proposal marks it (hatched) for everyone and changes no scores. ${quotaText(q.propose)} used this round`
              : "You cannot propose yet"
          }
        >
          Propose {quotaText(q.propose)}
        </Button>
        <Button
          icon="decide"
          kbd="D"
          active={tool === "decide"}
          disabled={!canDo("decide")}
          onClick={() => setTool(tool === "decide" ? null : "decide")}
          tip={
            actsOn.decide
              ? `Decide tool: click a square to decide on its ${actsOn.decide} sub-square. A decision fills it for everyone and changes the scores of that square. ${quotaText(q.decide)} used this round`
              : "You cannot decide yet"
          }
        >
          Decide {quotaText(q.decide)}
        </Button>
        <span className="hint cursor">{toolHint}</span>
        <span className="spacer" />
        <MapLegend views={view.map.views} compact />
      </div>
      <div
        style={{
          display: "grid",
          // side panel: 360 px at the small text size, wider with large text (27em = 432 px)
          gridTemplateColumns: "minmax(0, 1fr) max(360px, 27em)",
          gap: "var(--s3)",
          minHeight: 0,
        }}
      >
        <MapView
          board={view.map.board}
          views={view.map.views}
          scores={view.scores}
          scoreMax={scoreMax}
          highlights={view.highlights}
          selectedSquare={selected}
          previewK={tool ? actsOn[tool] : null}
          interactive
          zoomable
          tip={cellTip}
          onSquareClick={onSquareClick}
          onCellEnter={onEnter}
          onCellLeave={onLeave}
          onViewChange={(v) => conn.track("map_view_change", v)}
        />
        <aside className="col" style={{ minHeight: 0, overflow: "auto", gap: "var(--s2)" }}>
          <Panel
            title={selected ? `Square ${selected}` : "Square"}
            icon="scenario"
            actions={
              selected ? (
                <Button
                  iconOnly
                  variant="ghost"
                  icon="close"
                  title="Close"
                  tip="Close this square's panel"
                  onClick={() => select(null)}
                />
              ) : undefined
            }
          >
            {!selected ? (
              <p className="muted cursor">Select a square on the map</p>
            ) : (
              <SquarePanel
                view={view}
                square={selected}
                byCell={byCell}
                scoreMax={scoreMax}
                draft={draft}
                busy={busy}
                canDo={canDo}
                onDraft={(kind) => openDraft(kind, selected)}
                onConfirm={() => void confirmDraft()}
                onCancel={cancelDraft}
              />
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

/** The four sub-squares of the selected square: score (if known), marks, and the propose/decide flow. */
function SquarePanel({
  view,
  square,
  byCell,
  scoreMax,
  draft,
  busy,
  canDo,
  onDraft,
  onConfirm,
  onCancel,
}: {
  view: PlayerView;
  square: string;
  byCell: Map<string, Highlight[]>;
  scoreMax: number;
  draft: { kind: ActionKind; regionId: string } | null;
  busy: boolean;
  canDo: (k: ActionKind) => boolean;
  onDraft: (kind: ActionKind) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const actsOn = view.me.actsOn;
  const target = (kind: ActionKind): KLabel | null => actsOn[kind];
  const showActors = view.visibility.showActorToPlayers;
  return (
    <div className="col">
      <table className="grid">
        <thead>
          <tr>
            <th>Type</th>
            <th style={{ textAlign: "right" }}>Score</th>
            <th>On the map</th>
          </tr>
        </thead>
        <tbody>
          {K_LABELS.map((k) => {
            const id = cellId(square, k);
            const score = view.scores[id];
            const hs = byCell.get(id) ?? [];
            const p = hs.filter((h) => h.kind === "propose");
            const d = hs.filter((h) => h.kind === "decide");
            const mine = actsOn.decide === k || actsOn.propose === k;
            return (
              <tr key={k} data-cell={id}>
                <td>
                  {/* sq-type: may wrap with large text or a wide font, so the other columns keep their room */}
                  <span className="row nowrap sq-type" style={{ gap: 6 }}>
                    <LabelTag
                      label={k}
                      tip={`${view.map.views[k]?.name ?? k}: ${view.map.views[k]?.description ?? ""}`}
                    />
                    <span className="muted small">{view.map.views[k]?.name}</span>
                    {mine && (
                      <StatusTag tone="primary" title="Your proposals and decisions land on this sub-square">
                        you act
                      </StatusTag>
                    )}
                  </span>
                </td>
                <td
                  style={{ textAlign: "right" }}
                  className={score === undefined ? "faint" : "strong"}
                  data-tip={
                    score === undefined
                      ? `Only players who know ${k} see this score`
                      : `Your knowledge: this sub-square scores ${score} out of ${scoreMax}`
                  }
                >
                  {score === undefined ? "?" : `${score}/${scoreMax}`}
                </td>
                <td className="small">
                  {d.length > 0 && (
                    <span className="row nowrap gap-1">
                      <ActSwatch kind="decide" k={k} /> decided{showActors ? ` · ${actorsText(d)}` : ""}
                    </span>
                  )}
                  {p.length > 0 && (
                    <span className="row nowrap gap-1">
                      <ActSwatch kind="propose" k={k} /> proposed{showActors ? ` · ${actorsText(p)}` : ""}
                    </span>
                  )}
                  {hs.length === 0 && <span className="faint">–</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {draft?.regionId.startsWith(`${square}-`) ? (
        <div className="callout" style={{ borderLeftColor: "var(--primary)" }}>
          <div className="row strong" style={{ marginBottom: "var(--s2)", gap: 6 }}>
            <ActSwatch kind={draft.kind} k={draft.regionId.slice(-2)} />
            {draft.kind.toUpperCase()} “{cellName(draft.regionId)}”?
          </div>
          <div className="row">
            <Button
              variant="primary"
              icon="ok"
              kbd="Enter"
              disabled={busy}
              onClick={onConfirm}
              tip={`Send your ${VERB[draft.kind]} on ${cellName(draft.regionId)} to the server. It counts towards your quota`}
            >
              Confirm
            </Button>
            <Button icon="close" kbd="Esc" disabled={busy} onClick={onCancel} tip="Cancel; nothing is sent">
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="row">
          {(["propose", "decide"] as const).map((kind) => {
            const k = target(kind);
            return (
              <Button
                key={kind}
                icon={kind}
                disabled={!canDo(kind)}
                onClick={() => onDraft(kind)}
                tip={
                  k
                    ? kind === "propose"
                      ? `Propose ${square} · ${k}: marks it hatched for everyone; no score changes`
                      : `Decide on ${square} · ${k}: fills it for everyone and changes the scores of square ${square}`
                    : `You cannot ${kind} yet`
                }
              >
                {kind === "propose" ? "Propose" : "Decide"}
                {k ? ` ${square} · ${k}` : ""}
              </Button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StatusLine({
  view,
  conn,
  scoreMax,
  decimals,
}: {
  view: PlayerView;
  conn: PlayerConnection;
  scoreMax: number;
  decimals: number;
}) {
  useNow(); // redraw the countdown each second
  const limit = view.roundSpec?.timeLimitSec;
  let left: number | null = null;
  // not roundRemainingMs: that hides the countdown during the round break
  if (limit && view.roundStartedTs) left = limit * 1000 - roundActiveMs(view, conn.clock.now());
  const knows = view.me.knows;
  return (
    <div className="row panel" style={{ padding: "var(--s2) var(--s3)", marginTop: 0 }}>
      <strong className="upper" style={{ fontSize: "var(--fs-title)" }}>
        Round {view.round}/{view.roundCount}
      </strong>
      <span className="faint">│</span>
      <span className="row nowrap gap-1">
        <SeatDot seat={view.me.seat} /> <strong>SEAT {view.me.seat}</strong>
      </span>
      <RecordingTag conn={conn} view={view} />
      {view.me.k && (
        <LabelTag
          label={view.me.k}
          tip={`Your knowledge type${knows ? `: you see the scores of the ${knows} sub-squares${view.me.viewName ? ` (${view.me.viewName})` : ""}` : ""}`}
        />
      )}
      {view.me.p && (
        <LabelTag
          label={view.me.p}
          filled
          tip={`Your power type${view.me.actsOn.decide ? `: your proposals and decisions land on the ${view.me.actsOn.decide} sub-squares` : ""}`}
        />
      )}
      <span className="spacer" />
      <MapScore value={view.mapScore} max={scoreMax} decimals={decimals} />
      <span className="faint">│</span>
      <span
        className="row nowrap"
        style={{ gap: 6 }}
        data-tip="Proposals you have made this round, out of your quota"
      >
        <ActSwatch kind="propose" k={view.me.actsOn.propose} />
        <span className="strong">PROPOSALS</span>{" "}
        <AsciiProgress used={view.me.quota.propose.used} limit={view.me.quota.propose.limit} />
      </span>
      <span
        className="row nowrap"
        style={{ gap: 6 }}
        data-tip="Decisions you have made this round, out of your quota"
      >
        <ActSwatch kind="decide" k={view.me.actsOn.decide} />
        <span className="strong">DECISIONS</span>{" "}
        <AsciiProgress used={view.me.quota.decide.used} limit={view.me.quota.decide.limit} />
      </span>
      {left !== null && (
        <StatusTag
          tone={left < 60_000 ? "danger" : "neutral"}
          icon="timeline"
          title="Time left in this round"
        >
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
      <div className="col gap-1">
        {view.others.map((o) => (
          <div key={o.seat} className="row nowrap small">
            <SeatDot seat={o.seat} />
            <span>SEAT {o.seat}</span>
            {o.k && <LabelTag label={o.k} tip={`Seat ${o.seat}'s knowledge type`} />}
            {o.p && <LabelTag label={o.p} filled tip={`Seat ${o.seat}'s power type`} />}
            <span className="spacer" />
            {o.withdrawn ? (
              <StatusTag>left</StatusTag>
            ) : !o.connected ? (
              <StatusTag tone="danger" icon="disconnected">
                offline
              </StatusTag>
            ) : o.progress ? (
              <span className="muted row nowrap gap-1" data-tip={`Seat ${o.seat}'s quota used this round`}>
                <ActSwatch kind="propose" /> {quotaText(o.progress.propose)} · <ActSwatch kind="decide" />{" "}
                {quotaText(o.progress.decide)}
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
