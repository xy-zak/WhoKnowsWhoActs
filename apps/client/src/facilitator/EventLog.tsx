import {
  EVENT_TYPES,
  formatScoreChanges,
  type ReadonlyGameState,
  type StoredEvent,
  type StoredTelemetry,
  samplesToMs,
} from "@wkwa/shared";
import { Fragment, useMemo, useState } from "react";
import { fmtDuration, fmtSigned, plural } from "../common/format";
import { Button, formatDb, Panel, SeatDot } from "../ui";
import { START_REASON_TEXT, STOP_REASON_TEXT, shortTrack } from "./audioLive";

function ms(ts: number) {
  const d = new Date(ts);
  return `${d.toLocaleTimeString([], { hour12: false })}.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

/** One-line human summary of an event payload. */
export function summarise(ev: StoredEvent, regionName: (id: string) => string): string {
  switch (ev.type) {
    case "ProposalMade":
    case "DecisionMade": {
      const p = ev.payload;
      const prior = [
        p.priorProposals.length ? `proposed before by ${p.priorProposals.join(",")}` : "",
        p.priorDecisions.length ? `decided before by ${p.priorDecisions.join(",")}` : "",
      ]
        .filter(Boolean)
        .join("; ");
      const scores = formatScoreChanges(p.scoreChanges);
      return `${regionName(p.regionId)} (${p.quotaUsed}/${p.quotaLimit ?? "∞"})${prior ? ` — ${prior}` : ""}${scores ? ` · scores ${scores}` : ""}`;
    }
    case "IntentRejected":
      return `${ev.payload.kind} ${regionName(ev.payload.regionId)}: ${ev.payload.reason}`;
    case "ActionRevoked":
      return `#${ev.payload.targetSeq} ${ev.payload.targetType} by seat ${ev.payload.targetSeat} on ${regionName(ev.payload.regionId)}${ev.payload.reason ? ` (${ev.payload.reason})` : ""}${ev.payload.scoreChanges?.length ? ` · scores ${formatScoreChanges(ev.payload.scoreChanges)}` : ""}`;
    case "RoundStarted":
      return `round ${ev.payload.round} (${ev.payload.startedBy})`;
    case "RoundCompleted":
      return `round ${ev.payload.round}: ${ev.payload.reason}, ${Math.round(ev.payload.durationMs / 1000)} s`;
    case "LabelsAssigned":
      return `${ev.payload.assignments.map((a) => `${a.seat}:${a.k}/${a.p}`).join(" ")} (${ev.payload.method})`;
    case "SeatBound":
      return `client ${ev.payload.terminal} → seat ${ev.payload.seat}${ev.payload.fake ? ` (FAKE player, ${ev.payload.fakePace ?? "normal"} pace)` : ""}`;
    case "AgentBound":
      return `agent ${ev.payload.policy} v${ev.payload.policyVersion} → seat ${ev.payload.seat} (seed ${ev.payload.seed})`;
    case "ConsentRecorded":
      return ev.payload.consented ? "consent given" : "consent DECLINED";
    case "DemographicsSubmitted":
      return "submitted (answers hidden)";
    case "GamePaused":
      return ev.payload.reason === "disconnect"
        ? `auto-pause: seat ${ev.payload.seat} disconnected`
        : "paused";
    case "GameResumed":
      return `after ${Math.round(ev.payload.pausedMs / 1000)} s`;
    case "PlayerDisconnected":
      return ev.payload.reason;
    case "PlayerConnected":
      return ev.payload.reconnect ? "reconnected" : "connected";
    case "FacilitatorBroadcast":
    case "SessionNote":
      return `“${ev.payload.text}”`;
    case "ParticipantWithdrawn":
      return `seat ${ev.payload.seat} (${ev.payload.by})`;
    case "GameCompleted":
      return `${ev.payload.roundsPlayed} rounds, ${ev.payload.reason}`;
    case "MicCheckCompleted": {
      const p = ev.payload;
      const tries = plural(p.attempts, "attempt");
      return `mic check ${p.passed ? "passed" : "NOT passed"} (${tries}) · speech ${formatDb(p.speechDb)} for ${(p.speechMs / 1000).toFixed(1)} s, background ${formatDb(p.noiseFloorDb)}`;
    }
    case "MicCheckSkipped":
      return `mic check of seat ${ev.payload.seat} skipped${ev.payload.reason ? `: “${ev.payload.reason}”` : ""} · not recorded`;
    case "AudioTrackStarted":
      return `track ${shortTrack(ev.payload.trackId)} started (${START_REASON_TEXT[ev.payload.reason]})`;
    case "AudioTrackStopped": {
      const p = ev.payload;
      const dropped = p.droppedChunks ? `, ${p.droppedChunks} DROPPED (audio missing)` : "";
      return `track ${shortTrack(p.trackId)} stopped (${STOP_REASON_TEXT[p.reason]}) · ${fmtDuration(samplesToMs(p.samples))} stored in ${plural(p.chunks, "chunk")}${dropped}`;
    }
    case "CalibrationStarted":
      return `calibration started · order seat ${ev.payload.order.join(" → ")} · ${ev.payload.turnMs / 1000} s turns, ${ev.payload.gapMs / 1000} s gaps`;
    case "CalibrationTurn":
      return `turn ${ev.payload.index + 1}: seat ${ev.payload.seat} reads sentence ${ev.payload.sentenceId}`;
    case "CalibrationCompleted":
      return `calibration complete · ${plural(ev.payload.turns.length, "turn")} · checking the quality…`;
    case "CalibrationChecked": {
      const seats = ev.payload.perSeat
        .map(
          (r) =>
            `seat ${r.seat} ${r.marginDb === null ? "no audio" : fmtSigned(r.marginDb, "dB")} ${r.ok ? "✓" : "✗"}`,
        )
        .join(", ");
      return `calibration ${ev.payload.ok ? "OK" : "NOT OK"} · own voice over the loudest other mic: ${seats}`;
    }
    case "CalibrationSkipped":
      return ev.payload.cancelled
        ? `calibration cancelled${ev.payload.reason ? ` (${ev.payload.reason})` : ""} · it has to be run again`
        : `calibration skipped${ev.payload.reason ? `: “${ev.payload.reason}”` : ""}`;
    case "RecordingPaused":
      return `recording paused for everyone${ev.payload.reason ? `: “${ev.payload.reason}”` : ""}`;
    case "RecordingResumed":
      return "recording resumed for everyone";
    default:
      return "";
  }
}

export function EventLog({
  events,
  state,
  regionName,
  onRevoke,
  highlightSeq,
  maxHeight = 360,
}: {
  events: StoredEvent[];
  state: ReadonlyGameState | null;
  regionName: (id: string) => string;
  onRevoke?: (seq: number) => void;
  highlightSeq?: number;
  maxHeight?: number;
}) {
  const [type, setType] = useState("");
  const [seat, setSeat] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const rows = useMemo(
    () =>
      events
        .filter((e) => (!type || e.type === type) && (!seat || String(e.seat) === seat))
        .slice(-1000)
        .reverse(),
    [events, type, seat],
  );
  const revocable = (e: StoredEvent) =>
    onRevoke &&
    state?.phase === "round_active" &&
    (e.type === "ProposalMade" || e.type === "DecisionMade") &&
    e.round === state.round &&
    !state.actions.find((a) => a.seq === e.seq)?.revoked;

  return (
    <Panel title={`Event log · ${events.length}`} icon="review">
      <div className="col">
        <div className="row">
          <span className="hint">Newest first · click a row for the full event</span>
          <span className="spacer" />
          <select aria-label="Filter by event type" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">all types</option>
            {EVENT_TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <select aria-label="Filter by seat" value={seat} onChange={(e) => setSeat(e.target.value)}>
            <option value="">all seats</option>
            {[1, 2, 3, 4].map((s) => (
              <option key={s} value={s}>
                seat {s}
              </option>
            ))}
          </select>
        </div>
        <div style={{ maxHeight, overflow: "auto" }}>
          <table className="grid">
            <thead>
              <tr>
                <th>#</th>
                <th>time</th>
                <th>R</th>
                <th>type</th>
                <th>seat</th>
                <th>details</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <Fragment key={e.seq}>
                  <tr
                    onClick={() => setOpen(open === e.seq ? null : e.seq)}
                    className={e.seq === highlightSeq ? "selected" : ""}
                    style={{ cursor: "pointer" }}
                  >
                    <td className="faint">{e.seq}</td>
                    <td className="mono small">{ms(e.serverTs)}</td>
                    <td>{e.round || ""}</td>
                    <td>{e.type}</td>
                    <td>
                      {e.seat && (
                        <span className="row nowrap" style={{ gap: 4 }}>
                          <SeatDot seat={e.seat} /> {e.seat}
                        </span>
                      )}
                    </td>
                    <td className="small">{summarise(e, regionName)}</td>
                    <td>
                      {revocable(e) && (
                        <Button
                          size="sm"
                          icon="revoke"
                          onClick={(x) => {
                            x.stopPropagation();
                            onRevoke!(e.seq);
                          }}
                          tip="Undo this action for everyone: its mark and score changes are undone and the quota is returned; the event stays in the log"
                        >
                          Revoke
                        </Button>
                      )}
                    </td>
                  </tr>
                  {open === e.seq && (
                    <tr>
                      <td colSpan={7}>
                        <pre className="mono small" style={{ margin: 0, whiteSpace: "pre-wrap" }}>
                          {JSON.stringify({ ...e, payload: e.payload }, null, 2)}
                        </pre>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Panel>
  );
}

export function TelemetryFeed({
  items,
  regionName,
}: {
  items: StoredTelemetry[];
  regionName: (id: string) => string;
}) {
  const rows = items.slice(-150).reverse();
  return (
    <Panel title="Live telemetry" icon="telemetry">
      <div className="col">
        <span className="hint">Last {rows.length} items · state acks and clock syncs hidden</span>
        <div style={{ maxHeight: 340, overflow: "auto" }}>
          <table className="grid">
            <tbody>
              {rows.map((t) => {
                const p = t.payload as Record<string, unknown>;
                const detail = Object.entries(p)
                  .map(([k, v]) =>
                    k === "regionId"
                      ? regionName(String(v))
                      : `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`,
                  )
                  .join(" ");
                return (
                  <tr key={t.id}>
                    <td className="mono small">{ms(t.clientTs)}</td>
                    <td>
                      <span className="row nowrap" style={{ gap: 4 }}>
                        <SeatDot seat={t.seat} /> {t.seat}
                      </span>
                    </td>
                    <td>{t.type}</td>
                    <td className="small">{detail}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </Panel>
  );
}
