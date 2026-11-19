import { cellName, formatScoreChanges, parseCellId, type StoredEvent } from "@wkwa/shared";
import { useCallback, useId, useMemo, useRef, useState } from "react";
import { kColour, seatColour } from "../map/MapView";
import { ActSwatch, LabelTag, Panel } from "../ui";
import { audioSpans, START_REASON_TEXT, STOP_REASON_TEXT } from "./audioLive";

/**
 * Swimlane timeline: one lane per seat, proposals and decisions over time,
 * round boundaries and pauses. Marks use the map's encoding: the colour is the
 * knowledge type of the target sub-square, hatched = proposed, filled =
 * decided. Optional cursor for replay. Sessions that record audio get one mic lane per seat
 * below: recording spans (track start → stop), recording pauses and the calibration turns; the
 * time axis then starts with the first recording (the mic checks run before round 1).
 *
 * Drawn at the panel's real width (1 SVG unit = 1 px), so its text has the
 * same size as the rest of the interface and follows the text-size setting.
 */
export function Timeline({
  events,
  seats,
  now,
  cursorTs,
}: {
  events: StoredEvent[];
  seats: number[];
  now: number;
  cursorTs?: number;
}) {
  const uid = useId().replace(/:/g, "");
  const [box, width] = useWidth();
  const audio = useMemo(() => audioSpans(events), [events]);
  const roundStart = events.find((e) => e.type === "RoundStarted")?.serverTs;
  const start =
    audio.firstTs !== null
      ? Math.min(roundStart ?? audio.firstTs, audio.firstTs)
      : (roundStart ?? events[0]?.serverTs);
  if (start === undefined || seats.length === 0) return null;
  const sinceText = roundStart !== undefined && start >= roundStart ? "round 1" : "recording started";
  const end = Math.max(now, (events.at(-1)?.serverTs ?? start) + 1000, start + 60_000);
  const W = Math.max(width || 1000, 320);
  const laneH = 26;
  const top = 22;
  const M = 10; // mark size
  const hasAudio = audio.firstTs !== null;
  const micH = 16; // height of a mic lane
  const audioTop = top + seats.length * laneH + 16; // first mic lane
  const H = hasAudio ? audioTop + seats.length * micH + 16 : top + seats.length * laneH + 16;
  const micY = (lane: number) => audioTop + lane * micH + micH / 2;
  const L = 84; // left gutter for the seat labels
  const x = (ts: number) => L + M / 2 + ((ts - start) / (end - start)) * (W - L - M - 10);

  const rounds: Array<{ round: number; s: number; e: number | null }> = [];
  const pauses: Array<{ s: number; e: number | null }> = [];
  for (const ev of events) {
    if (ev.type === "RoundStarted") rounds.push({ round: ev.payload.round, s: ev.serverTs, e: null });
    if (ev.type === "RoundCompleted") {
      const r = rounds.find((x) => x.round === ev.payload.round);
      if (r) r.e = ev.serverTs;
    }
    if (ev.type === "GamePaused") pauses.push({ s: ev.serverTs, e: null });
    if (ev.type === "GameResumed" || ev.type === "RoundCompleted") {
      const p = pauses.at(-1);
      if (p && p.e === null) p.e = ev.serverTs;
    }
  }
  const revoked = new Set(
    events
      .filter((e) => e.type === "ActionRevoked")
      .map((e) => (e.payload as { targetSeq: number }).targetSeq),
  );
  const ks = ["a", "b", "c", "d"] as const;

  return (
    <Panel title="Timeline" icon="timeline">
      <div className="col">
        <span className="legend">
          <span>
            <ActSwatch kind="propose" /> propose
          </span>
          <span>
            <ActSwatch kind="decide" /> decide
          </span>
          <span>colour = knowledge type of the sub-square:</span>
          {ks.map((l) => (
            <LabelTag key={l} label={`K${l}`} />
          ))}
          <span>· faded = revoked · shaded = paused · minutes since {sinceText}</span>
          {hasAudio && (
            <span>
              · mic lanes:{" "}
              <svg width={16} height={8} aria-hidden="true" style={{ verticalAlign: "middle" }}>
                <rect width={16} height={6} y={1} style={{ fill: "var(--live)" }} />
              </svg>{" "}
              recording ·{" "}
              <svg width={16} height={10} aria-hidden="true" style={{ verticalAlign: "middle" }}>
                <rect width={16} height={10} style={{ fill: `url(#${uid}-rp)` }} />
              </svg>{" "}
              recording paused (striped) ·{" "}
              <svg width={16} height={10} aria-hidden="true" style={{ verticalAlign: "middle" }}>
                <rect x={1} y={1} width={14} height={8} style={{ fill: "none", stroke: "var(--text)" }} />
              </svg>{" "}
              calibration turn
            </span>
          )}
        </span>
        <div ref={box}>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            width={W}
            height={H}
            style={{ display: "block", maxWidth: "100%" }}
            role="img"
            aria-label="Timeline"
          >
            <defs>
              {ks.map((l) => (
                <pattern
                  key={l}
                  id={`${uid}-tl-${l}`}
                  patternUnits="userSpaceOnUse"
                  width={4}
                  height={4}
                  patternTransform="rotate(45)"
                >
                  <rect width={4} height={4} style={{ fill: "var(--panel)" }} />
                  <rect width={2} height={4} style={{ fill: `var(--k-${l})` }} />
                </pattern>
              ))}
              {/* recording paused: warn stripes, so it never looks like a game pause (flat shade) */}
              <pattern
                id={`${uid}-rp`}
                patternUnits="userSpaceOnUse"
                width={6}
                height={6}
                patternTransform="rotate(45)"
              >
                <rect width={3} height={6} style={{ fill: "var(--warn)", opacity: 0.55 }} />
              </pattern>
            </defs>
            {rounds.map((r) => (
              <g key={r.round}>
                <rect
                  x={x(r.s)}
                  y={top - 4}
                  width={Math.max(1, x(r.e ?? now) - x(r.s))}
                  height={H - top}
                  style={{ fill: r.round % 2 ? "var(--sunken)" : "var(--hover)" }}
                />
                <text x={x(r.s) + 3} y={13} style={{ fill: "var(--muted)", fontSize: "var(--fs-micro)" }}>
                  Round {r.round}
                </text>
              </g>
            ))}
            {pauses.map((p) => (
              <rect
                key={p.s}
                x={x(p.s)}
                y={top - 4}
                width={Math.max(1, x(p.e ?? now) - x(p.s))}
                height={hasAudio ? audioTop - 12 - (top - 4) : H - top}
                style={{ fill: "var(--warn)", opacity: 0.18 }}
              />
            ))}
            {seats.map((s, i) => (
              <g key={s}>
                <line
                  x1={L}
                  x2={W - 10}
                  y1={top + i * laneH + laneH / 2}
                  y2={top + i * laneH + laneH / 2}
                  style={{ stroke: "var(--frame)" }}
                  strokeDasharray="2 4"
                />
                <circle cx={12} cy={top + i * laneH + laneH / 2} r={6} style={{ fill: seatColour(s) }} />
                <text
                  x={22}
                  y={top + i * laneH + laneH / 2 + 4}
                  style={{ fill: "var(--text)", fontSize: "var(--fs-meta)" }}
                >
                  seat {s}
                </text>
              </g>
            ))}
            {hasAudio && (
              <g>
                <text x={4} y={audioTop - 6} style={{ fill: "var(--muted)", fontSize: "var(--fs-micro)" }}>
                  AUDIO
                </text>
                {audio.pauses.map((p) => (
                  <rect
                    key={`rp${p.s}`}
                    x={x(p.s)}
                    y={audioTop - 2}
                    width={Math.max(1, x(p.e ?? now) - x(p.s))}
                    height={seats.length * micH + 4}
                    style={{ fill: `url(#${uid}-rp)` }}
                    data-tip={`Recording paused for everyone${p.reason ? `: “${p.reason}”` : ""}`}
                  />
                ))}
                {audio.calibrations.map((c) => (
                  <g key={`cal${c.s}`}>
                    <rect
                      x={x(c.s)}
                      y={audioTop - 2}
                      width={Math.max(1, x(c.e ?? now) - x(c.s))}
                      height={seats.length * micH + 4}
                      style={{ fill: "none", stroke: "var(--muted)" }}
                      strokeDasharray="3 3"
                      data-tip={c.cancelled ? "Calibration (cancelled)" : "Calibration"}
                    />
                    <text
                      x={x(c.s) + 3}
                      y={audioTop - 6}
                      style={{ fill: "var(--muted)", fontSize: "var(--fs-micro)" }}
                    >
                      calibration{c.cancelled ? " (cancelled)" : ""}
                    </text>
                  </g>
                ))}
                {seats.map((s, i) => (
                  <g key={`mic${s}`}>
                    <line
                      x1={L}
                      x2={W - 10}
                      y1={micY(i)}
                      y2={micY(i)}
                      style={{ stroke: "var(--frame)" }}
                      strokeDasharray="2 4"
                    />
                    <circle cx={12} cy={micY(i)} r={4} style={{ fill: seatColour(s) }} />
                    <text
                      x={22}
                      y={micY(i) + 4}
                      style={{ fill: "var(--muted)", fontSize: "var(--fs-micro)" }}
                    >
                      mic {s}
                    </text>
                  </g>
                ))}
                {audio.tracks.map((t) => {
                  const lane = seats.indexOf(t.seat);
                  if (lane < 0) return null;
                  const tip = `Seat ${t.seat} recording · ${((t.s - start) / 60_000).toFixed(1)}–${(((t.e ?? now) - start) / 60_000).toFixed(1)} min · started: ${START_REASON_TEXT[t.reason]}${t.stopReason === null ? " · still recording" : ` · stopped: ${STOP_REASON_TEXT[t.stopReason]}`}`;
                  return (
                    <rect
                      key={t.trackId}
                      x={x(t.s)}
                      y={micY(lane) - 3}
                      width={Math.max(1, x(t.e ?? now) - x(t.s))}
                      height={6}
                      style={{ fill: "var(--live)" }}
                      data-tip={tip}
                      aria-label={tip}
                    />
                  );
                })}
                {audio.turns.map((t) => {
                  const lane = seats.indexOf(t.seat);
                  if (lane < 0) return null;
                  return (
                    <rect
                      key={`turn${t.seat}-${t.s}`}
                      x={x(t.s)}
                      y={micY(lane) - micH / 2 + 2}
                      width={Math.max(2, x(t.e ?? now) - x(t.s))}
                      height={micH - 4}
                      style={{ fill: "none", stroke: "var(--text)" }}
                      data-tip={`Calibration turn of seat ${t.seat}`}
                    />
                  );
                })}
              </g>
            )}
            {events.map((e) => {
              if ((e.type !== "ProposalMade" && e.type !== "DecisionMade") || e.seat === null) return null;
              const lane = seats.indexOf(e.seat);
              if (lane < 0) return null;
              const cx = x(e.serverTs);
              const cy = top + lane * laneH + laneH / 2;
              const isRevoked = revoked.has(e.seq);
              const k = parseCellId(e.payload.regionId)?.k;
              const colour = k ? kColour(k) : "var(--text)";
              const propose = e.type === "ProposalMade";
              const changes = formatScoreChanges(e.payload.scoreChanges);
              const tip = `#${e.seq} · seat ${e.seat} ${propose ? "proposed" : "decided"} ${cellName(e.payload.regionId)}${
                changes ? ` · scores: ${changes}` : ""
              }${isRevoked ? " · revoked" : ""}`;
              return (
                <rect
                  key={e.seq}
                  data-tip={tip}
                  x={cx - M / 2}
                  y={cy - M / 2}
                  width={M}
                  height={M}
                  style={{
                    fill: propose ? (k ? `url(#${uid}-tl-${k[1]})` : "var(--panel)") : colour,
                    stroke: colour,
                    opacity: isRevoked ? 0.25 : 1,
                  }}
                  strokeWidth={1.5}
                  aria-label={tip}
                />
              );
            })}
            {[0, 0.25, 0.5, 0.75, 1].map((f) => {
              const ts = start + f * (end - start);
              return (
                <text
                  key={f}
                  x={x(ts)}
                  y={H - 2}
                  style={{ fill: "var(--faint)", fontSize: "var(--fs-micro)" }}
                  textAnchor="middle"
                >
                  {((ts - start) / 60_000).toFixed(1)}
                </text>
              );
            })}
            {cursorTs !== undefined && (
              <line
                x1={x(cursorTs)}
                x2={x(cursorTs)}
                y1={top - 6}
                y2={H}
                style={{ stroke: "var(--focus)" }}
                strokeWidth={2}
              />
            )}
          </svg>
        </div>
      </div>
    </Panel>
  );
}

/** Width of an element, kept up to date (0 until it is measured). A callback ref, so it also works when the element mounts later. */
function useWidth(): [(el: HTMLElement | null) => void, number] {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    setWidth(Math.floor(el.getBoundingClientRect().width));
    if (typeof ResizeObserver === "undefined") return;
    observer.current = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.floor(entry.contentRect.width));
    });
    observer.current.observe(el);
  }, []);
  return [ref, width];
}
