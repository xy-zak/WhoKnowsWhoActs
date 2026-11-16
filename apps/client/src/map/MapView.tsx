import type { Highlight, MapGeometry } from "@wkwa/shared";
import { type PointerEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "../ui/components";

export interface ViewChange {
  x: number;
  y: number;
  w: number;
  h: number;
  zoom: number;
}

export interface MapViewProps {
  geometry: MapGeometry;
  fills?: Record<string, string | undefined>;
  labels?: Record<string, string | undefined>;
  icons?: Record<string, string | undefined>;
  showNames?: boolean;
  highlights?: Highlight[];
  selectedRegionId?: string | null;
  /** Live "who is hovering where" markers (facilitator mirrors/composite). */
  hoverMarkers?: Array<{ seat: number; regionId: string }>;
  interactive?: boolean;
  zoomable?: boolean;
  onRegionClick?: (id: string) => void;
  onRegionEnter?: (id: string) => void;
  onRegionLeave?: (id: string) => void;
  /** Debounced (500 ms) after pan/zoom settles. */
  onViewChange?: (v: ViewChange) => void;
  /** Scale factor for badges/labels (e.g. 1.4 for small mirrors). */
  markScale?: number;
}

/* Theme tokens (see docs/AESTHETIC-RULES.md). SVG presentation attributes do not resolve var(), so colours go in `style`. */
export const PROPOSE_COLOUR = "var(--propose)";
export const DECIDE_COLOUR = "var(--decide)";
const LAND = "var(--land)";
export const seatColour = (seat: number | null) => (seat === null ? "var(--faint)" : `var(--seat-${seat})`);

function parseViewBox(vb: string): [number, number, number, number] {
  const n = vb.split(/[\s,]+/).map(Number);
  return [n[0] ?? 0, n[1] ?? 0, n[2] ?? 1000, n[3] ?? 700];
}

export function MapView(props: MapViewProps) {
  const {
    geometry,
    fills = {},
    labels = {},
    icons = {},
    showNames = false,
    highlights = [],
    selectedRegionId = null,
    hoverMarkers = [],
    interactive = false,
    zoomable = false,
    markScale = 1,
  } = props;
  const base = useMemo(() => parseViewBox(geometry.viewBox), [geometry.viewBox]);
  const [vb, setVb] = useState(base);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; vb: typeof vb; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onViewChange = props.onViewChange;

  useEffect(() => setVb(base), [base]);

  const emitView = useCallback(
    (next: typeof vb) => {
      if (!onViewChange) return;
      if (debounce.current) clearTimeout(debounce.current);
      debounce.current = setTimeout(() => {
        onViewChange({
          x: Math.round(next[0]),
          y: Math.round(next[1]),
          w: Math.round(next[2]),
          h: Math.round(next[3]),
          zoom: Math.round((base[2] / next[2]) * 100) / 100,
        });
      }, 500);
    },
    [onViewChange, base],
  );

  const clamp = useCallback(
    (v: typeof vb): typeof vb => {
      const minW = base[2] / 8;
      const w = Math.min(base[2], Math.max(minW, v[2]));
      const h = (w / base[2]) * base[3];
      const x = Math.min(base[0] + base[2] - w, Math.max(base[0], v[0]));
      const y = Math.min(base[1] + base[3] - h, Math.max(base[1], v[1]));
      return [x, y, w, h];
    },
    [base],
  );

  const toSvg = (clientX: number, clientY: number): [number, number] => {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return [0, 0];
    const p = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return [p.x, p.y];
  };

  const zoomBy = (factor: number, cx?: number, cy?: number) => {
    setVb((cur) => {
      const [px, py] = cx === undefined ? [cur[0] + cur[2] / 2, cur[1] + cur[3] / 2] : [cx, cy!];
      const w = cur[2] / factor;
      const h = cur[3] / factor;
      const next = clamp([px - ((px - cur[0]) / cur[2]) * w, py - ((py - cur[1]) / cur[3]) * h, w, h]);
      emitView(next);
      return next;
    });
  };

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !zoomable) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const [x, y] = toSvg(e.clientX, e.clientY);
      zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, x, y);
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  });

  const onPointerDown = (e: PointerEvent) => {
    if (!zoomable || e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, vb, moved: false };
  };
  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 5) return;
    if (!d.moved) (e.currentTarget as Element).setPointerCapture(e.pointerId);
    d.moved = true;
    const svg = svgRef.current!;
    const scale = d.vb[2] / svg.clientWidth;
    setVb(clamp([d.vb[0] - dx * scale, d.vb[1] - dy * scale, d.vb[2], d.vb[3]]));
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.moved) {
      suppressClick.current = true;
      setTimeout(() => {
        suppressClick.current = false;
      }, 0);
      emitView(vb);
    }
  };

  const byRegion = useMemo(() => {
    const m = new Map<string, Highlight[]>();
    for (const h of highlights) {
      const list = m.get(h.regionId) ?? [];
      list.push(h);
      m.set(h.regionId, list);
    }
    for (const list of m.values()) list.sort((a, b) => a.seq - b.seq);
    return m;
  }, [highlights]);

  const hatchId = `hatch-${useId().replace(/:/g, "")}`;
  const unit = (base[2] / 1000) * markScale; // marks scale with the map size
  const badgeR = 10 * unit;

  return (
    <div className="map-wrap">
      <svg
        ref={svgRef}
        viewBox={vb.join(" ")}
        preserveAspectRatio="xMidYMid meet"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        role="img"
        aria-label="Map"
      >
        <defs>
          <pattern
            id={hatchId}
            patternUnits="userSpaceOnUse"
            width={12 * unit}
            height={12 * unit}
            patternTransform="rotate(45)"
          >
            <rect width={12 * unit} height={12 * unit} style={{ fill: PROPOSE_COLOUR, fillOpacity: 0.14 }} />
            <line
              x1="0"
              y1="0"
              x2="0"
              y2={12 * unit}
              style={{ stroke: PROPOSE_COLOUR, strokeOpacity: 0.65 }}
              strokeWidth={4 * unit}
            />
          </pattern>
        </defs>

        {geometry.regions.map((r) => (
          <path
            key={r.id}
            d={r.path}
            data-region={r.id}
            className={`map-region${interactive ? " interactive" : ""}${selectedRegionId === r.id ? " selected" : ""}`}
            style={{ fill: fills[r.id] ?? LAND }}
            onClick={() => {
              if (!suppressClick.current && interactive) props.onRegionClick?.(r.id);
            }}
            onPointerEnter={() => props.onRegionEnter?.(r.id)}
            onPointerLeave={() => props.onRegionLeave?.(r.id)}
          />
        ))}

        {/* highlight overlays (non-interactive) */}
        <g pointerEvents="none">
          {geometry.regions.map((r) => {
            const hs = byRegion.get(r.id);
            if (!hs) return null;
            const hasDecide = hs.some((h) => h.kind === "decide");
            const hasPropose = hs.some((h) => h.kind === "propose");
            return (
              <g key={r.id}>
                {hasPropose && (
                  <path
                    d={r.path}
                    fill={`url(#${hatchId})`}
                    style={{ stroke: PROPOSE_COLOUR }}
                    strokeWidth={3.5}
                    strokeDasharray="10 6"
                    vectorEffect="non-scaling-stroke"
                  />
                )}
                {hasDecide && (
                  <path
                    d={r.path}
                    style={{ fill: DECIDE_COLOUR, fillOpacity: 0.3, stroke: DECIDE_COLOUR }}
                    strokeWidth={4}
                    vectorEffect="non-scaling-stroke"
                  />
                )}
              </g>
            );
          })}
          {hoverMarkers.map((h) => {
            const r = geometry.regions.find((x) => x.id === h.regionId);
            if (!r) return null;
            return (
              <path
                key={`hover-${h.seat}`}
                d={r.path}
                fill="none"
                style={{ stroke: seatColour(h.seat) }}
                strokeWidth={5}
                strokeDasharray="2 5"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
        </g>

        {/* labels and badges */}
        <g pointerEvents="none">
          {geometry.regions.map((r) => {
            const [ax, ay] = r.anchor;
            const hs = byRegion.get(r.id) ?? [];
            const label = [icons[r.id], labels[r.id]].filter(Boolean).join(" ");
            const total = hs.length;
            const gap = badgeR * 2.3;
            return (
              <g key={r.id}>
                {showNames && (
                  <text
                    x={ax}
                    y={ay - 16 * unit}
                    textAnchor="middle"
                    className="map-name"
                    style={{ fontSize: 12 * unit }}
                  >
                    {r.name}
                  </text>
                )}
                {label && (
                  <text
                    x={ax}
                    y={ay + 5 * unit}
                    textAnchor="middle"
                    className="map-label"
                    style={{ fontSize: 15 * unit }}
                  >
                    {label}
                  </text>
                )}
                {hs.map((h, i) => {
                  const cx = ax + (i - (total - 1) / 2) * gap;
                  const cy = ay + 26 * unit;
                  const colour = seatColour(h.seat);
                  const text = h.seat === null ? "?" : String(h.seat);
                  return h.kind === "propose" ? (
                    <g key={h.seq}>
                      <circle
                        cx={cx}
                        cy={cy}
                        r={badgeR}
                        style={{ fill: "var(--panel)", stroke: colour }}
                        strokeWidth={3 * unit}
                      />
                      <text
                        x={cx}
                        y={cy + 4 * unit}
                        textAnchor="middle"
                        fontSize={11 * unit}
                        fontWeight={700}
                        style={{ fill: "var(--text)" }}
                      >
                        {text}
                      </text>
                    </g>
                  ) : (
                    <g key={h.seq}>
                      <rect
                        x={cx - badgeR}
                        y={cy - badgeR}
                        width={badgeR * 2}
                        height={badgeR * 2}
                        rx={3 * unit}
                        style={{ fill: colour, stroke: "var(--panel)" }}
                        strokeWidth={1.5 * unit}
                      />
                      <text
                        x={cx}
                        y={cy + 4 * unit}
                        textAnchor="middle"
                        fontSize={11 * unit}
                        fontWeight={700}
                        style={{ fill: "var(--on-accent)" }}
                      >
                        {text}
                      </text>
                    </g>
                  );
                })}
              </g>
            );
          })}
        </g>
      </svg>
      {zoomable && (
        <div className="map-controls">
          <Button iconOnly icon="zoomIn" title="Zoom in" onClick={() => zoomBy(1.4)} />
          <Button iconOnly icon="zoomOut" title="Zoom out" onClick={() => zoomBy(1 / 1.4)} />
          <Button
            iconOnly
            icon="zoomReset"
            title="Reset view"
            onClick={() => {
              setVb(base);
              emitView(base);
            }}
          />
        </div>
      )}
    </div>
  );
}

export function MapLegend({ showActors = true }: { showActors?: boolean }) {
  return (
    <div className="legend">
      <span>
        <span className="sw" style={{ background: PROPOSE_COLOUR, color: "var(--propose-text)" }} />
        <span className="t-propose">PROPOSED</span> {showActors && "○ = seat"}
      </span>
      <span>
        <span className="sw" style={{ background: DECIDE_COLOUR, color: "var(--decide-text)" }} />
        <span className="t-decide">DECIDED</span> {showActors && "■ = seat"}
      </span>
    </div>
  );
}
