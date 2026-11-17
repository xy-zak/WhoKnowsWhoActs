import { type GameState, type Highlight, playerView, type Scenario, seatList } from "@wkwa/shared";
import { useMemo, useState } from "react";
import { MapLegend, MapView } from "../map/MapView";
import { Button, Check, ConnTag, Panel, SeatDot, StatusTag } from "../ui";

/** All views' information about one region, side by side. */
function RegionComparison({
  scenario,
  state,
  regionId,
  onRevoke,
}: {
  scenario: Scenario;
  state: GameState;
  regionId: string;
  onRevoke?: (seq: number) => void;
}) {
  const region = scenario.regions.find((r) => r.id === regionId);
  const viewIds = Object.keys(scenario.views);
  const keys = [
    ...new Set(viewIds.flatMap((v) => Object.keys(scenario.views[v]!.regions[regionId]?.attributes ?? {}))),
  ];
  const seatsByView = (v: string) =>
    seatList(state)
      .filter((s) => s.view === v)
      .map((s) => s.seat);
  const actions = state.actions.filter((a) => a.regionId === regionId);
  return (
    <div className="col">
      <h3 style={{ margin: 0 }}>
        {region?.name} <span className="faint">{regionId}</span>
      </h3>
      <div style={{ overflowX: "auto" }}>
        <table className="grid">
          <thead>
            <tr>
              <th />
              {viewIds.map((v) => (
                <th key={v}>
                  <span className="row nowrap" style={{ gap: 3 }}>
                    {v}
                    {seatsByView(v).map((s) => (
                      <SeatDot key={s} seat={s} />
                    ))}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => {
              const def = scenario.attributes.find((a) => a.key === k);
              return (
                <tr key={k}>
                  <td className="muted">{def?.label ?? k}</td>
                  {viewIds.map((v) => {
                    const val = scenario.views[v]!.regions[regionId]?.attributes[k];
                    return (
                      <td key={v} className={val === undefined ? "faint" : "strong"}>
                        {val === undefined ? "–" : `${val}${def?.unit ? ` ${def.unit}` : ""}`}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <span className="small upper muted">Actions on this region</span>
      {actions.length === 0 && <span className="small faint">none</span>}
      {actions.map((a) => (
        <div key={a.seq} className="row small">
          <span className="mono faint">#{a.seq}</span>
          <span>R{a.round}</span>
          <SeatDot seat={a.seat} /> seat {a.seat}
          <span className={a.kind === "decide" ? "t-decide strong" : "t-propose strong"}>
            {a.kind.toUpperCase()}
          </span>
          {a.revoked && <StatusTag>revoked</StatusTag>}
          {onRevoke && !a.revoked && a.round === state.round && state.phase === "round_active" && (
            <Button size="sm" icon="revoke" onClick={() => onRevoke(a.seq)}>
              Revoke
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}

export function CompositeMap({
  scenario,
  state,
  presence = {},
  onRevoke,
  height = 520,
}: {
  scenario: Scenario;
  state: GameState;
  presence?: Record<number, string | null>;
  onRevoke?: (seq: number) => void;
  height?: number;
}) {
  const viewIds = Object.keys(scenario.views);
  const [colourBy, setColourBy] = useState<string>(viewIds[0] ?? "none");
  const [allRounds, setAllRounds] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const fills = useMemo(() => {
    const v = scenario.views[colourBy];
    return v ? Object.fromEntries(Object.entries(v.regions).map(([id, c]) => [id, c.fill])) : {};
  }, [scenario, colourBy]);
  const labels = useMemo(() => {
    const v = scenario.views[colourBy];
    return v ? Object.fromEntries(Object.entries(v.regions).map(([id, c]) => [id, c.label])) : {};
  }, [scenario, colourBy]);

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

  return (
    <Panel
      title="Composite map"
      icon="scenario"
      actions={
        <select
          aria-label="Colour the map by view"
          value={colourBy}
          onChange={(e) => setColourBy(e.target.value)}
        >
          {viewIds.map((v) => (
            <option key={v} value={v}>
              colour: {v} — {scenario.views[v]!.name}
            </option>
          ))}
          <option value="none">colour: none</option>
        </select>
      }
    >
      <div className="col">
        <div className="row">
          <Check label="all rounds" checked={allRounds} onChange={setAllRounds} />
          <span className="spacer" />
          <MapLegend />
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: selected ? "minmax(0,1fr) 420px" : "1fr",
            gap: "var(--s2)",
          }}
        >
          <div style={{ height }}>
            <MapView
              geometry={scenario}
              fills={fills}
              labels={labels}
              showNames
              highlights={highlights}
              hoverMarkers={hoverMarkers}
              selectedRegionId={selected}
              interactive
              zoomable
              onRegionClick={(id) => setSelected(id === selected ? null : id)}
            />
          </div>
          {selected && (
            <Panel
              nested
              title="Region"
              icon="review"
              actions={
                <Button
                  iconOnly
                  variant="ghost"
                  icon="close"
                  title="Close"
                  onClick={() => setSelected(null)}
                />
              }
            >
              <div style={{ overflow: "auto", maxHeight: height - 40 }}>
                <RegionComparison scenario={scenario} state={state} regionId={selected} onRevoke={onRevoke} />
              </div>
            </Panel>
          )}
        </div>
        <span className="hint">
          Dotted outlines = where a seat is hovering now. Click a region to compare all views.
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
  state: GameState;
  presence?: Record<number, string | null>;
  now: number;
}) {
  const seats = seatList(state).filter((s) => s.bound || s.withdrawn);
  if (seats.length === 0) return null;
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
          const fills = pv
            ? Object.fromEntries(Object.entries(pv.content).map(([id, c]) => [id, c.fill]))
            : {};
          const hover = presence[s.seat];
          return (
            <div key={s.seat} className="col" style={{ gap: 4 }}>
              <div className="row nowrap small">
                <SeatDot seat={s.seat} />
                <strong>SEAT {s.seat}</strong>
                {s.k && <span className="muted">{s.k}</span>}
                {s.p && <span className="muted">{s.p}</span>}
                <span className="spacer" />
                {s.agent ? (
                  <StatusTag icon="agent" title={`Agent: ${s.agent}`}>
                    {s.withdrawn ? "withdrawn" : "agent"}
                  </StatusTag>
                ) : (
                  <>
                    {s.fake && <StatusTag icon="fake">fake</StatusTag>}
                    <ConnTag connected={s.connected} withdrawn={s.withdrawn} />
                  </>
                )}
              </div>
              <div style={{ height: 180 }}>
                <MapView
                  geometry={scenario}
                  fills={fills}
                  highlights={pv?.highlights ?? []}
                  hoverMarkers={hover ? [{ seat: s.seat, regionId: hover }] : []}
                  markScale={1.6}
                />
              </div>
              <span className="micro faint">{s.view ? scenario.views[s.view]?.name : ""}</span>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
