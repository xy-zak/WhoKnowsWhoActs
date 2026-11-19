import {
  cellId,
  cellName,
  formatMapScore,
  getGameRules,
  type Highlight,
  K_LABELS,
  type KLabel,
  mapScoreOf,
  parseCellId,
  playerView,
  type ReadonlyGameState,
  rulesFor,
  type Scenario,
  type Scores,
  seatList,
} from "@wkwa/shared";
import { useMemo, useState } from "react";
import { MapLegend, MapScore, MapView } from "../map/MapView";
import { ActSwatch, Button, Check, LabelTag, Panel, SeatDot, StatusTag } from "../ui";
import { OccupantTags } from "./seats";

/** The board of a session (recorded at creation; the scenario's for sessions before the grid map). */
function boardOf(state: ReadonlyGameState, scenario: Scenario) {
  return state.board ?? scenario.board;
}

/** All four sub-squares of one square: score, who sees it, who acts on it, and every action there. */
function SquareComparison({
  scenario,
  state,
  square,
  onRevoke,
}: {
  scenario: Scenario;
  state: ReadonlyGameState;
  square: string;
  onRevoke?: (seq: number) => void;
}) {
  const rules = rulesFor(state);
  const seats = seatList(state).filter((s) => s.bound);
  const seesK = (k: KLabel) => seats.filter((s) => s.view === k).map((s) => s.seat);
  const actsK = (k: KLabel) =>
    seats.filter((s) => rules.targetOf({ seat: s.seat, k: s.k, p: s.p }, "decide") === k).map((s) => s.seat);
  const actions = state.actions.filter((a) => parseCellId(a.regionId)?.id === square);
  return (
    <div className="col">
      <h3 style={{ margin: 0 }}>Square {square}</h3>
      <table className="grid">
        <thead>
          <tr>
            <th>Type</th>
            <th style={{ textAlign: "right" }}>Score</th>
            <th style={{ textAlign: "right" }}>Start</th>
            <th>Seen by</th>
            <th>Acted on by</th>
          </tr>
        </thead>
        <tbody>
          {K_LABELS.map((k) => {
            const id = cellId(square, k);
            const now = state.scores[id];
            const start = state.initialScores[id] ?? scenario.initialScores[id];
            return (
              <tr key={k}>
                <td>
                  <span className="row nowrap" style={{ gap: 6 }}>
                    <LabelTag label={k} tip={scenario.views[k]?.description} />
                    <span className="muted small">{scenario.views[k]?.name}</span>
                  </span>
                </td>
                <td style={{ textAlign: "right" }} className="strong">
                  {now ?? "–"}
                </td>
                <td
                  style={{ textAlign: "right" }}
                  className="muted"
                  data-tip="Starting score (from the scenario)"
                >
                  {start ?? "–"}
                </td>
                <td>
                  <span
                    className="row nowrap"
                    style={{ gap: 3 }}
                    data-tip={`Seats whose view is ${k}: they see these scores`}
                  >
                    {seesK(k).map((s) => (
                      <SeatDot key={s} seat={s} />
                    ))}
                    {seesK(k).length === 0 && <span className="faint">–</span>}
                  </span>
                </td>
                <td>
                  <span
                    className="row nowrap"
                    style={{ gap: 3 }}
                    data-tip={`Seats whose actions land on ${k} sub-squares (game rules: power type)`}
                  >
                    {actsK(k).map((s) => (
                      <SeatDot key={s} seat={s} />
                    ))}
                    {actsK(k).length === 0 && <span className="faint">–</span>}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <span className="small upper muted">Actions on this square</span>
      {actions.length === 0 && <span className="small faint">none</span>}
      {actions.map((a) => (
        <div key={a.seq} className="row small">
          <span className="mono faint">#{a.seq}</span>
          <span>R{a.round}</span>
          <SeatDot seat={a.seat} /> seat {a.seat}
          <ActSwatch kind={a.kind} k={parseCellId(a.regionId)?.k} />
          <span className="strong">{a.kind.toUpperCase()}</span>
          <span>{cellName(a.regionId)}</span>
          {a.revoked && <StatusTag>revoked</StatusTag>}
          {onRevoke && !a.revoked && a.round === state.round && state.phase === "round_active" && (
            <Button
              size="sm"
              icon="revoke"
              onClick={() => onRevoke(a.seq)}
              tip={`Undo seat ${a.seat}'s ${a.kind} on ${cellName(a.regionId)} for everyone: its mark disappears, its score changes are undone and the seat gets the quota back. The original event stays in the log`}
            >
              Revoke
            </Button>
          )}
        </div>
      ))}
      <span className="hint">
        Rules: {rules.name} v{state.rules?.version ?? rules.version}. {rules.summary}
      </span>
    </div>
  );
}

const ALL = "all";
const NONE = "none";

export function CompositeMap({
  scenario,
  state,
  presence = {},
  onRevoke,
  height = 560,
}: {
  scenario: Scenario;
  state: ReadonlyGameState;
  presence?: Record<number, string | null>;
  onRevoke?: (seq: number) => void;
  height?: number;
}) {
  const [numbers, setNumbers] = useState<string>(ALL);
  const [allRounds, setAllRounds] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const board = boardOf(state, scenario);
  const rules = getGameRules(state.rules?.id ?? state.config.rules);
  const scoreMax = rules?.scoreRange.max ?? 10;

  const scores = useMemo(() => {
    if (numbers === NONE) return {};
    if (numbers === ALL) return state.scores;
    const out: Scores = {};
    for (const [id, v] of Object.entries(state.scores)) if (parseCellId(id)?.k === numbers) out[id] = v;
    return out;
  }, [state.scores, numbers]);

  const highlights: Highlight[] = state.actions
    .filter((a) => !a.revoked && (allRounds || a.round === state.round))
    .map((a) => ({
      seq: a.seq,
      kind: a.kind,
      regionId: a.regionId,
      round: a.round,
      seat: a.seat,
      mine: false,
    }));
  const hoverMarkers = Object.entries(presence)
    .filter(([, r]) => r)
    .map(([seat, regionId]) => ({ seat: Number(seat), regionId: regionId! }));

  const actorTip = (id: string) => {
    const hs = highlights.filter((h) => h.regionId === id);
    if (hs.length === 0) return undefined;
    return hs.map((h) => `${h.kind === "propose" ? "proposed" : "decided"} by seat ${h.seat}`).join(" · ");
  };

  return (
    <Panel
      title="Composite map"
      icon="scenario"
      actions={
        <select
          aria-label="Which scores to write on the map"
          data-tip="Which scores to write in the sub-squares: every knowledge type (what no single player sees), one type (what that type's players see), or none"
          value={numbers}
          onChange={(e) => setNumbers(e.target.value)}
        >
          <option value={ALL}>scores: all types</option>
          {K_LABELS.map((k) => (
            <option key={k} value={k}>
              scores: {k} — {scenario.views[k]?.name ?? k}
            </option>
          ))}
          <option value={NONE}>scores: hidden</option>
        </select>
      }
    >
      <div className="col">
        <div className="row">
          <MapScore value={mapScoreOf(state)} max={scoreMax} decimals={rules?.mapScoreDecimals ?? 2} />
          <span className="faint">│</span>
          <span data-tip="Also show the hatches and fills of earlier rounds (players see only the current round when 'clear highlights each round' is on)">
            <Check label="all rounds" checked={allRounds} onChange={setAllRounds} />
          </span>
          <span className="spacer" />
          <MapLegend views={scenario.views} />
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: selected ? "minmax(0,1fr) 440px" : "1fr",
            gap: "var(--s2)",
          }}
        >
          <div style={{ height }}>
            <MapView
              board={board}
              views={scenario.views}
              scores={scores}
              scoreMax={scoreMax}
              highlights={highlights}
              hoverMarkers={hoverMarkers}
              selectedSquare={selected}
              tip={actorTip}
              interactive
              zoomable
              onSquareClick={(sq) => setSelected(sq === selected ? null : sq)}
            />
          </div>
          {selected && (
            <Panel
              nested
              title="Square"
              icon="review"
              actions={
                <Button
                  iconOnly
                  variant="ghost"
                  icon="close"
                  title="Close"
                  tip="Close the square panel"
                  onClick={() => setSelected(null)}
                />
              }
            >
              <div style={{ overflow: "auto", maxHeight: height - 40 }}>
                <SquareComparison scenario={scenario} state={state} square={selected} onRevoke={onRevoke} />
              </div>
            </Panel>
          )}
        </div>
        <span className="hint">
          Dotted outlines = the sub-square a seat is hovering now. Click a square to compare its four
          sub-squares. Map score: {formatMapScore(rules, mapScoreOf(state))}.
        </span>
      </div>
    </Panel>
  );
}

/** Each player's map exactly as their projection shows it (same shared function as the server). */
export function PlayerMirrors({
  scenario,
  state,
  presence = {},
  now,
}: {
  scenario: Scenario;
  state: ReadonlyGameState;
  presence?: Record<number, string | null>;
  now: number;
}) {
  const seats = seatList(state).filter((s) => s.bound || s.withdrawn);
  if (seats.length === 0) return null;
  const board = boardOf(state, scenario);
  const small = board.cols <= 6;
  return (
    <Panel title="Player views" icon="visibility">
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
          gap: "var(--s2)",
        }}
      >
        {seats.map((s) => {
          let pv: ReturnType<typeof playerView> | null = null;
          try {
            pv = s.bound ? playerView(state, scenario, s.seat, null, now) : null;
          } catch {}
          const hover = presence[s.seat];
          return (
            <div key={s.seat} className="col gap-1">
              <div className="row nowrap small">
                <SeatDot seat={s.seat} />
                <strong>SEAT {s.seat}</strong>
                {s.k && <LabelTag label={s.k} tip={`Seat ${s.seat}'s knowledge type`} />}
                {s.p && <LabelTag label={s.p} filled tip={`Seat ${s.seat}'s power type`} />}
                <span className="spacer" />
                <OccupantTags seat={s} />
              </div>
              <div style={{ height: 220 }}>
                <MapView
                  board={board}
                  scores={pv?.scores ?? {}}
                  showScores={small}
                  showAxes={false}
                  highlights={pv?.highlights ?? []}
                  hoverMarkers={hover ? [{ seat: s.seat, regionId: hover }] : []}
                  markScale={2.5}
                />
              </div>
              <span className="micro faint">
                {s.view ? `sees ${s.view} · ${scenario.views[s.view]?.name ?? ""}` : ""}
                {pv?.me.actsOn.decide ? ` · acts on ${pv.me.actsOn.decide}` : ""}
              </span>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
