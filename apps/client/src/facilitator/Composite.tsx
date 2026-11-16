import {
  type GameState,
  type Highlight,
  playerView,
  type Scenario,
  SEAT_COLOURS,
  seatList,
} from "@wkwa/shared";
import { useMemo, useState } from "react";
import { MapLegend, MapView } from "../map/MapView";

/** All four views' information about the same region, side by side. */
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
        {region?.name} <span className="muted small">({regionId})</span>
      </h3>
      <div style={{ overflowX: "auto" }}>
        <table className="grid">
          <thead>
            <tr>
              <th />
              {viewIds.map((v) => (
                <th key={v}>
                  {v}{" "}
                  {seatsByView(v).map((s) => (
                    <span
                      key={s}
                      className="seat-dot"
                      style={{ background: SEAT_COLOURS[s] }}
                      title={`seat ${s}`}
                    />
                  ))}
                  <div className="small muted" style={{ fontWeight: 400 }}>
                    {scenario.views[v]!.name}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => {
              const def = scenario.attributes.find((a) => a.key === k);
              return (
                <tr key={k}>
                  <td>{def?.label ?? k}</td>
                  {viewIds.map((v) => {
                    const val = scenario.views[v]!.regions[regionId]?.attributes[k];
                    return (
                      <td key={v} style={{ fontWeight: val === undefined ? 400 : 600 }}>
                        {val === undefined ? (
                          <span className="muted">–</span>
                        ) : (
                          `${val}${def?.unit ? ` ${def.unit}` : ""}`
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <strong className="small">Actions on this region</strong>
      {actions.length === 0 && <span className="small muted">none</span>}
      {actions.map((a) => (
        <div key={a.seq} className="row small">
          <span className="mono">#{a.seq}</span>
          <span>R{a.round}</span>
          <span className="seat-dot" style={{ background: SEAT_COLOURS[a.seat] }} /> seat {a.seat}
          <span className={`pill ${a.kind === "decide" ? "bad" : "warn"}`}>{a.kind}</span>
          {a.revoked && <span className="pill">revoked</span>}
          {onRevoke && !a.revoked && a.round === state.round && state.phase === "round_active" && (
            <button type="button" className="small danger" onClick={() => onRevoke(a.seq)}>
              Revoke
            </button>
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
    <div className="panel col">
      <div className="row">
        <strong>Composite map</strong>
        <span className="small muted">colour by</span>
        <select value={colourBy} onChange={(e) => setColourBy(e.target.value)}>
          {viewIds.map((v) => (
            <option key={v} value={v}>
              {v} — {scenario.views[v]!.name}
            </option>
          ))}
          <option value="none">none (outline only)</option>
        </select>
        <label className="row small">
          <input type="checkbox" checked={allRounds} onChange={(e) => setAllRounds(e.target.checked)} /> all
          rounds
        </label>
        <span className="spacer" />
        <MapLegend />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: selected ? "minmax(0,1fr) 420px" : "1fr", gap: 8 }}>
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
          <div className="panel" style={{ boxShadow: "none", overflow: "auto", maxHeight: height }}>
            <div className="row">
              <span className="spacer" />
              <button type="button" className="small" onClick={() => setSelected(null)}>
                ✕
              </button>
            </div>
            <RegionComparison scenario={scenario} state={state} regionId={selected} onRevoke={onRevoke} />
          </div>
        )}
      </div>
      <span className="small muted">
        Dotted coloured outlines = region a seat is hovering right now. Click a region to compare all views.
      </span>
    </div>
  );
}

/** Each player's map exactly as their projection shows it (computed with the same shared function). */
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
    <div className="panel col">
      <strong>Player views (as each player sees them)</strong>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 8 }}>
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
              <div className="row small">
                <span className="seat-dot" style={{ background: SEAT_COLOURS[s.seat] }} />
                <strong>Seat {s.seat}</strong>
                {s.k && <span className="pill">{s.k}</span>}
                {s.p && <span className="pill">{s.p}</span>}
                <span className="muted">{s.view ? scenario.views[s.view]?.name : ""}</span>
                <span className="spacer" />
                {s.withdrawn ? (
                  <span className="pill">withdrawn</span>
                ) : s.connected ? (
                  <span className="pill ok">online</span>
                ) : (
                  <span className="pill bad">offline</span>
                )}
              </div>
              <div style={{ height: 190 }}>
                <MapView
                  geometry={scenario}
                  fills={fills}
                  highlights={pv?.highlights ?? []}
                  hoverMarkers={hover ? [{ seat: s.seat, regionId: hover }] : []}
                  markScale={1.6}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
