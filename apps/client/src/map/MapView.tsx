import {
  type Board,
  cellId,
  cellName,
  type Highlight,
  K_LABELS,
  type KLabel,
  parseCellId,
  type Scores,
  SUB_SQUARE_POSITION,
  squareId,
  type View,
} from "@wkwa/shared";
import { type PointerEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ActSwatch, Button, LabelTag } from "../ui/components";

/* ═══════════════════════════════════════════════════════════════════════════
 * THE MAP — a grid of squares; every square holds one sub-square per
 * knowledge type (Ka Kb / Kc Kd). Styled like an election tile map: a base
 * grid of outlined squares, each sub-square outlined in its knowledge-type
 * colour, HATCHED when proposed and FILLED when decided. Each known score is
 * written in its sub-square. Colours: docs/AESTHETIC-RULES.md § 2.2.
 * ═══════════════════════════════════════════════════════════════════════════ */

export interface ViewChange {
  x: number;
  y: number;
  w: number;
  h: number;
  zoom: number;
}

export interface MapViewProps {
  board: Board;
  /** Knowledge-type names (scenario views), for hover text. */
  views?: Record<string, Pick<View, "name">>;
  /** Scores to write in the sub-squares; a sub-square without a score stays blank. */
  scores?: Readonly<Scores>;
  /** Highest possible score, for hover text ("6/10"). */
  scoreMax?: number;
  showScores?: boolean;
  /** Column letters and row numbers around the grid. */
  showAxes?: boolean;
  highlights?: Highlight[];
  selectedSquare?: string | null;
  /** Live "who is hovering where" markers (facilitator mirrors/composite), by sub-square. */
  hoverMarkers?: Array<{ seat: number; regionId: string }>;
  /** Knowledge type the current tool would act on: hovering a square outlines that sub-square. */
  previewK?: KLabel | null;
  interactive?: boolean;
  zoomable?: boolean;
  /** A square was clicked (`cell` = the sub-square under the pointer). */
  onSquareClick?: (square: string, cell: string | null) => void;
  onCellEnter?: (cell: string) => void;
  onCellLeave?: (cell: string) => void;
  /** Debounced (500 ms) after pan/zoom settles. */
  onViewChange?: (v: ViewChange) => void;
  /** Extra hover text per sub-square (appended to the name and score). */
  tip?: (cell: string) => string | undefined;
  /** Scale factor for hatch stripes (e.g. 2.5 for small mirrors). */
  markScale?: number;
}

export const seatColour = (seat: number | null) => (seat === null ? "var(--faint)" : `var(--seat-${seat})`);
export const kColour = (k: string) => `var(--k-${k[1]})`;

/* Geometry in SVG user units. */
const S = 100; // square side
const GAP = 10; // gap between squares
const PAD = 7; // padding inside a square
const IG = 4; // gap between sub-squares
const SUB = (S - 2 * PAD - IG) / 2; // sub-square side
const AXIS = 34; // room for column letters / row numbers

export function boardBox(board: Board, axes: boolean): [number, number, number, number] {
  const m = axes ? AXIS : 6;
  return [
    0,
    0,
    m + board.cols * S + (board.cols - 1) * GAP + 6,
    m + board.rows * S + (board.rows - 1) * GAP + 6,
  ];
}

interface CellMarks {
  proposed: boolean;
  decided: boolean;
}

export function MapView(props: MapViewProps) {
  const {
    board,
    views = {},
    scores = {},
    scoreMax = 10,
    showScores = true,
    showAxes = true,
    highlights = [],
    selectedSquare = null,
    hoverMarkers = [],
    previewK = null,
    interactive = false,
    zoomable = false,
    markScale = 1,
  } = props;
  const base = useMemo(() => boardBox(board, showAxes), [board, showAxes]);
  const [vb, setVb] = useState(base);
  const [hoverSquare, setHoverSquare] = useState<string | null>(null);
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
      const minW = base[2] / 6;
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

  const marks = useMemo(() => {
    const m = new Map<string, CellMarks>();
    for (const h of highlights) {
      const cur = m.get(h.regionId) ?? { proposed: false, decided: false };
      if (h.kind === "propose") cur.proposed = true;
      else cur.decided = true;
      m.set(h.regionId, cur);
    }
    return m;
  }, [highlights]);

  const uid = useId().replace(/:/g, "");
  const hatchId = (k: KLabel) => `${uid}-hatch-${k}`;
  const origin = showAxes ? AXIS : 6;
  const squareXY = (col: number, row: number): [number, number] => [
    origin + col * (S + GAP),
    origin + row * (S + GAP),
  ];
  const cellXY = (col: number, row: number, k: KLabel): [number, number] => {
    const [x, y] = squareXY(col, row);
    const [cx, cy] = SUB_SQUARE_POSITION[k];
    return [x + PAD + cx * (SUB + IG), y + PAD + cy * (SUB + IG)];
  };
  const stripe = 9 * markScale;
  const fontSize = `calc(${20}px * var(--map-text, 1))`;

  const squares: Array<{ id: string; col: number; row: number }> = [];
  for (let row = 0; row < board.rows; row++)
    for (let col = 0; col < board.cols; col++) squares.push({ id: squareId(col, row), col, row });

  const tipText = (id: string): string => {
    const c = parseCellId(id)!;
    const name = views[c.k]?.name;
    const score = scores[id];
    const m = marks.get(id);
    const parts = [
      `${cellName(id)}${name ? ` (${name})` : ""}`,
      score === undefined ? "score unknown to you" : `score ${score}/${scoreMax}`,
    ];
    if (m?.decided) parts.push("decided");
    else if (m?.proposed) parts.push("proposed");
    const extra = props.tip?.(id);
    if (extra) parts.push(extra);
    return parts.join(" · ");
  };

  const square = (id: string) => squares.find((s) => s.id === id);
  const selected = selectedSquare ? square(selectedSquare) : undefined;
  const previewSquare = previewK && hoverSquare ? square(hoverSquare) : undefined;

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
        aria-label={`Map: ${board.cols} × ${board.rows} squares`}
      >
        <defs>
          {K_LABELS.map((k) => (
            <pattern
              key={k}
              id={hatchId(k)}
              patternUnits="userSpaceOnUse"
              width={stripe}
              height={stripe}
              patternTransform="rotate(45)"
            >
              <rect width={stripe} height={stripe} style={{ fill: "var(--panel)" }} />
              <rect width={stripe * 0.45} height={stripe} style={{ fill: kColour(k) }} />
            </pattern>
          ))}
        </defs>

        {showAxes && (
          <g className="map-axis" style={{ fontSize }}>
            {squares
              .filter((sq) => sq.row === 0)
              .map((sq) => (
                <text
                  key={`col-${sq.id}`}
                  x={squareXY(sq.col, 0)[0] + S / 2}
                  y={AXIS - 10}
                  textAnchor="middle"
                >
                  {sq.id.replace(/\d+$/, "")}
                </text>
              ))}
            {squares
              .filter((sq) => sq.col === 0)
              .map((sq) => (
                <text
                  key={`row-${sq.id}`}
                  x={AXIS - 8}
                  y={squareXY(0, sq.row)[1] + S / 2 + 7}
                  textAnchor="end"
                >
                  {sq.row + 1}
                </text>
              ))}
          </g>
        )}

        {squares.map((sq) => {
          const [x, y] = squareXY(sq.col, sq.row);
          return (
            <g
              key={sq.id}
              data-square={sq.id}
              className={`grid-square-hit${interactive ? " interactive" : ""}`}
              onClick={(e) => {
                if (suppressClick.current || !interactive) return;
                const cell = (e.target as Element).getAttribute?.("data-cell") ?? null;
                props.onSquareClick?.(sq.id, cell);
              }}
              onPointerEnter={() => setHoverSquare(sq.id)}
              onPointerLeave={() => setHoverSquare((h) => (h === sq.id ? null : h))}
            >
              <rect className="grid-square" x={x} y={y} width={S} height={S} />
              {K_LABELS.map((k) => {
                const id = cellId(sq.id, k);
                const [cx, cy] = cellXY(sq.col, sq.row, k);
                const m = marks.get(id);
                const fill = m?.decided ? kColour(k) : m?.proposed ? `url(#${hatchId(k)})` : "var(--panel)";
                return (
                  <rect
                    key={k}
                    data-cell={id}
                    data-state={m?.decided ? "decided" : m?.proposed ? "proposed" : "none"}
                    data-tip={interactive ? tipText(id) : undefined}
                    className="grid-cell"
                    x={cx}
                    y={cy}
                    width={SUB}
                    height={SUB}
                    style={{ fill, stroke: kColour(k) }}
                    onPointerEnter={() => props.onCellEnter?.(id)}
                    onPointerLeave={() => props.onCellLeave?.(id)}
                  />
                );
              })}
            </g>
          );
        })}

        {showScores && (
          <g style={{ fontSize }}>
            {squares.flatMap((sq) =>
              K_LABELS.map((k) => {
                const id = cellId(sq.id, k);
                const v = scores[id];
                if (v === undefined) return null;
                const [cx, cy] = cellXY(sq.col, sq.row, k);
                const m = marks.get(id);
                return (
                  <text
                    key={id}
                    x={cx + SUB / 2}
                    y={cy + SUB / 2 + 7}
                    textAnchor="middle"
                    className={`grid-score${m?.proposed && !m.decided ? " halo" : ""}`}
                    style={{ fill: m?.decided ? `var(--k-${k[1]}-on)` : "var(--text)" }}
                  >
                    {v}
                  </text>
                );
              }),
            )}
          </g>
        )}

        <g pointerEvents="none">
          {hoverMarkers.map((h) => {
            const c = parseCellId(h.regionId);
            if (!c || c.col >= board.cols || c.row >= board.rows) return null;
            const [cx, cy] = cellXY(c.col, c.row, c.k);
            return (
              <rect
                key={`hover-${h.seat}`}
                x={cx - 3}
                y={cy - 3}
                width={SUB + 6}
                height={SUB + 6}
                fill="none"
                style={{ stroke: seatColour(h.seat) }}
                strokeWidth={3.5}
                strokeDasharray="2 4"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
          {previewSquare && previewK && (
            <rect
              className="grid-preview"
              x={cellXY(previewSquare.col, previewSquare.row, previewK)[0] - 2}
              y={cellXY(previewSquare.col, previewSquare.row, previewK)[1] - 2}
              width={SUB + 4}
              height={SUB + 4}
            />
          )}
          {selected && (
            <rect
              className="grid-selected"
              x={squareXY(selected.col, selected.row)[0] - 3}
              y={squareXY(selected.col, selected.row)[1] - 3}
              width={S + 6}
              height={S + 6}
            />
          )}
        </g>
      </svg>
      {zoomable && (
        <div className="map-controls">
          <Button
            iconOnly
            icon="zoomIn"
            title="Zoom in"
            tip="Zoom in (or scroll on the map)"
            onClick={() => zoomBy(1.4)}
          />
          <Button iconOnly icon="zoomOut" title="Zoom out" tip="Zoom out" onClick={() => zoomBy(1 / 1.4)} />
          <Button
            iconOnly
            icon="zoomReset"
            title="Reset view"
            tip="Show the whole map again"
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

/** Legend: pattern (hatched = proposed, filled = decided) and one colour per knowledge type. */
export function MapLegend({
  views,
  compact = false,
}: {
  views?: Record<string, Pick<View, "name">>;
  compact?: boolean;
}) {
  return (
    <div className="legend">
      <span>
        <ActSwatch kind="propose" /> PROPOSED
      </span>
      <span>
        <ActSwatch kind="decide" /> DECIDED
      </span>
      {K_LABELS.map((k) => (
        <span key={k}>
          <LabelTag
            label={k}
            tip={`Outline colour of the ${k} sub-squares${views?.[k] ? ` (${views[k].name})` : ""}`}
          />
          {!compact && views?.[k] && <span>{views[k].name}</span>}
        </span>
      ))}
    </div>
  );
}

/** `MAP SCORE ▰▰▰▰▰▱▱▱▱▱ 5.13/10` — the score of the whole map. */
export function MapScore({
  value,
  max = 10,
  decimals = 2,
  label = "Map score",
}: {
  value: number | null;
  max?: number;
  decimals?: number;
  label?: string;
}) {
  const n = 10;
  const filled = value === null ? 0 : Math.round((Math.min(max, Math.max(0, value)) / max) * n);
  return (
    <span
      className="row nowrap"
      style={{ gap: 6 }}
      data-tip={`Score of the whole map: the average of every sub-square's score (0–${max})`}
      data-testid="map-score"
    >
      <span className="strong upper">{label}</span>
      <span className="ascii-progress">
        <span className="on">{"▰".repeat(filled)}</span>
        <span className="off">{"▱".repeat(n - filled)}</span>{" "}
        <strong>{value === null ? "–" : value.toFixed(decimals)}</strong>/{max}
      </span>
    </span>
  );
}
