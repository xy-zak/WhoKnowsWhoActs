import { type GameState, RECORDING_PHASES, type StoredEvent } from "@wkwa/shared";
import { useEffect, useState } from "react";
import { fmtTime } from "../../common/format";
import { useStore } from "../../net/store";
import { Button, Callout, formatDb, Icon, Panel, Popup, SeatDot, StatusTag } from "../../ui";
import {
  type AudioCheck,
  CALIBRATION_MIN_MARGIN_DB,
  calibrationAdvice,
  fmtMargin,
  micStatsOf,
  type TrackStatusLite,
  wrapUpAudioCheck,
} from "../audioLive";
import type { FacilitatorConnection } from "../connection";

/*
 * LIVE audio monitoring beside the NEXT panel: the calibration quality card, the TOOLS panel's
 * recording pause, and the wrap-up audio check. Rules: docs/AESTHETIC-RULES.md § 8.1.
 */

/* ─────────────────────────── calibration quality ─────────────────────────── */

/** The last calibration event, when it was a server cancel (status back to pending). */
function cancelledRun(events: readonly StoredEvent[]): { reason: string; ts: number } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "CalibrationSkipped")
      return e.payload.cancelled ? { reason: e.payload.reason, ts: e.serverTs } : null;
    if (e.type === "CalibrationStarted") return null;
  }
  return null;
}

/**
 * The calibration and its quality check: which turn runs, "checking…" between the end of the
 * last turn and the check, then per seat the margin of its own voice over the loudest other mic,
 * the verdict and plain advice for each seat that failed. Hidden until a calibration ran.
 */
export function CalibrationCard({ st, events }: { st: GameState; events: readonly StoredEvent[] }) {
  if (!st.audio.enabled) return null;
  const c = st.audio.calibration;
  const cancelled = c.status === "pending" ? cancelledRun(events) : null;
  if (c.status === "pending" && !cancelled) return null;
  const q = c.quality;
  const advice = q ? q.perSeat.map(calibrationAdvice).filter((a): a is string => a !== null) : [];
  return (
    <Panel title="Calibration" icon="voice">
      <div className="col">
        {c.status === "pending" && cancelled && (
          <Callout tone="warn" icon="warning">
            The calibration was cancelled at {fmtTime(cancelled.ts)}
            {cancelled.reason ? ` (${cancelled.reason})` : ""}. Run it again (or skip it) in the NEXT panel
            before round 1.
          </Callout>
        )}
        {c.status === "running" && (
          <div className="row">
            <StatusTag tone="warn" icon="voice">
              calibrating
            </StatusTag>
            <span>
              {c.turnIndex === null
                ? "Starting…"
                : `Turn ${c.turnIndex + 1}/${c.order.length}: seat ${c.order[c.turnIndex]} reads its sentence aloud; everyone else stays quiet.`}
            </span>
          </div>
        )}
        {c.status === "skipped" && (
          <div className="row">
            <StatusTag icon="voice">skipped</StatusTag>
            <span className="muted">
              No calibration: speaker attribution estimates the leakage between the microphones from the
              recordings (less exact with laptop microphones).
            </span>
          </div>
        )}
        {c.status === "done" && !q && (
          <div className="row">
            <StatusTag tone="warn" icon="idle">
              checking…
            </StatusTag>
            <span>Calibration complete. Checking how well the microphones keep the voices apart…</span>
          </div>
        )}
        {c.status === "done" && q && (
          <>
            <div className="row">
              {q.ok ? (
                <StatusTag tone="live" icon="ok">
                  calibration ok
                </StatusTag>
              ) : (
                <StatusTag tone="warn" icon="microphoneWarning">
                  needs attention
                </StatusTag>
              )}
              <span className={q.ok ? "muted" : undefined}>
                {q.ok
                  ? "Every seat's own voice stands out on its own microphone."
                  : `Seat ${q.perSeat
                      .filter((r) => !r.ok)
                      .map((r) => r.seat)
                      .join(", ")}: attribution will be poor. Fix it now, then redo the calibration.`}
              </span>
              <span className="spacer" />
              <span className="faint small">checked {fmtTime(q.checkedTs)}</span>
            </div>
            <table className="grid" style={{ width: "auto", minWidth: "60%" }}>
              <thead>
                <tr>
                  <th>Seat</th>
                  <th>Own voice, own mic</th>
                  <th>Loudest other mic</th>
                  <th>Margin</th>
                  <th>Verdict</th>
                </tr>
              </thead>
              <tbody>
                {q.perSeat.map((r) => (
                  <tr key={r.seat}>
                    <td>
                      <span className="row nowrap">
                        <SeatDot seat={r.seat} /> <strong>{r.seat}</strong>
                      </span>
                    </td>
                    <td className="mono small">{r.ownDb === null ? "—" : formatDb(r.ownDb)}</td>
                    <td className="mono small">{r.bestOtherDb === null ? "—" : formatDb(r.bestOtherDb)}</td>
                    <td className={`mono${r.ok ? "" : " t-warn strong"}`}>{fmtMargin(r.marginDb)}</td>
                    <td>
                      {r.ok ? (
                        <StatusTag tone="live" icon="ok">
                          ok
                        </StatusTag>
                      ) : r.marginDb === null ? (
                        <StatusTag tone="warn" icon="microphoneWarning">
                          no audio
                        </StatusTag>
                      ) : (
                        <StatusTag tone="warn" icon="microphoneWarning">
                          too much leakage
                        </StatusTag>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {advice.length > 0 && (
              <Callout tone="warn" icon="microphoneWarning">
                <ul style={{ margin: 0, paddingLeft: "1.2em" }}>
                  {advice.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
              </Callout>
            )}
            <span className="hint">
              Margin = level of the seat's voice on its own microphone minus its level on the loudest other
              one. The verdict also allows for different microphone gains; at least{" "}
              {CALIBRATION_MIN_MARGIN_DB} dB is needed to tell the speakers apart reliably.
            </span>
          </>
        )}
      </div>
    </Panel>
  );
}

/* ─────────────────────────── TOOLS: pause / resume recording ─────────────────────────── */

/** The latest RecordingPaused, while recording is paused. */
function lastPause(events: readonly StoredEvent[]): { ts: number; reason: string | null } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "RecordingResumed") return null;
    if (e.type === "RecordingPaused") return { ts: e.serverTs, reason: e.payload.reason ?? null };
  }
  return null;
}

/**
 * Pause recording for every seat (after a confirmation with an optional reason) or resume it.
 * Players cannot mute themselves; both are logged by the server. Only possible while audio is
 * recorded (onboarding and rounds).
 */
export function RecordingControl({ conn, st }: { conn: FacilitatorConnection; st: GameState }) {
  const fs = useStore(conn.store);
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  if (!st.audio.enabled) return null;
  const can = RECORDING_PHASES.has(st.phase);
  const paused = st.audio.recordingPaused;
  const since = paused ? lastPause(fs.events) : null;
  const send = (name: string, payload: unknown, ok: string) => {
    setBusy(true);
    return conn
      .cmd(name, payload, ok)
      .then(
        () => true,
        () => false,
      )
      .finally(() => setBusy(false));
  };
  const pause = () =>
    void send("recording:pause", reason.trim() ? { reason: reason.trim() } : {}, "Recording paused").then(
      (ok) => {
        if (!ok) return;
        setAsking(false);
        setReason("");
      },
    );
  return (
    <div className="row">
      {paused ? (
        <>
          <StatusTag
            tone="warn"
            icon="microphoneOff"
            tip="No seat is recorded; players see 'Recording paused by the facilitator'"
          >
            recording paused
          </StatusTag>
          <span className="small muted">
            {since ? `since ${fmtTime(since.ts)}` : ""}
            {since?.reason ? ` · “${since.reason}”` : ""}
          </span>
          <span className="spacer" />
          <Button
            icon="microphone"
            disabled={!can || busy}
            onClick={() => void send("recording:resume", {}, "Recording resumed")}
            tip="Record every seat again (logged); each recorded seat starts a new track"
          >
            Resume recording
          </Button>
        </>
      ) : (
        <>
          <Button
            icon="microphoneOff"
            disabled={!can || busy}
            onClick={() => setAsking(true)}
            tip={
              can
                ? "Stop recording every microphone for now, e.g. for a private conversation (logged, with your reason); the game goes on"
                : "Recording can only be paused during onboarding and the rounds"
            }
          >
            Pause recording
          </Button>
          <span className="hint">For everyone: players cannot mute themselves.</span>
        </>
      )}
      {asking && (
        <Popup
          title="Pause recording for everyone?"
          icon="microphoneOff"
          width={560}
          onClose={() => setAsking(false)}
          onPrimary={busy ? undefined : pause}
          footer={
            <>
              <Button icon="close" kbd="Esc" onClick={() => setAsking(false)}>
                Cancel
              </Button>
              <span className="spacer" />
              <Button variant="primary" icon="microphoneOff" kbd="Enter" disabled={busy} onClick={pause}>
                Pause recording
              </Button>
            </>
          }
        >
          <div className="col">
            <p>
              Every microphone stops recording now; the game itself goes on. Players see{" "}
              <em>Recording paused by the facilitator</em> until you resume. The pause and your reason are
              logged.
            </p>
            {st.audio.calibration.status === "running" && (
              <Callout tone="warn" icon="warning">
                The calibration that is running is cancelled: run it again after resuming.
              </Callout>
            )}
            <label className="field">
              <span className="label">Reason (optional, logged and exported: never type names)</span>
              <input
                type="text"
                aria-label="Reason for pausing the recording"
                value={reason}
                maxLength={200}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. break, private conversation"
              />
            </label>
          </div>
        </Popup>
      )}
    </div>
  );
}

/* ─────────────────────────── wrap-up: audio check ─────────────────────────── */

const POLL_MS = 5000;

/**
 * The wrap-up's audio check, refreshed every few seconds: every real seat's tracks closed and no
 * upload pending ("All audio uploaded"), else what is still on its way and what went missing.
 * Non-blocking: the facilitator can still close. Returns the check for the caller's buttons.
 */
export function useAudioCheck(conn: FacilitatorConnection, st: GameState): AudioCheck | null {
  const fs = useStore(conn.store);
  const [tracks, setTracks] = useState<TrackStatusLite[] | null>(null);
  const id = st.sessionId;
  const enabled = st.audio.enabled;
  useEffect(() => {
    if (!enabled || !id) return;
    let stop = false;
    const load = async () => {
      // a quiet fetch: a failed poll must not raise an error toast every few seconds
      const headers = new Headers();
      if (conn.token) headers.set("authorization", `Bearer ${conn.token}`);
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/audio`, { headers });
        if (!res.ok || stop) return;
        const body = (await res.json()) as { tracks?: TrackStatusLite[] };
        if (!stop) setTracks(body.tracks ?? []);
      } catch {}
    };
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [conn, id, enabled]);
  if (!enabled) return null;
  return wrapUpAudioCheck(st, micStatsOf(fs.dashboard?.stats), tracks);
}

/** The audio check as shown at the top of every wrap-up step. */
export function AudioCheckView({ check }: { check: AudioCheck }) {
  const uploads = check.lines.filter((l) => l.kind === "upload");
  const issues = check.lines.filter((l) => l.kind === "issue");
  return (
    <div className="col" style={{ gap: "var(--s2)" }}>
      {uploads.length > 0 ? (
        <Callout tone="warn" icon="upload">
          <strong>Audio still uploading: keep the players' browsers open.</strong>
          <ul style={{ margin: "4px 0 0", paddingLeft: "1.2em" }}>
            {uploads.map((l) => (
              <li key={l.text}>{l.text}</li>
            ))}
          </ul>
          <span className="muted">
            Closing the session now is possible, but audio that has not arrived is lost.
          </span>
        </Callout>
      ) : check.uploaded ? (
        <Callout tone="live" icon="ok">
          <strong>All audio uploaded:</strong> every seat's tracks are closed and nothing is waiting to
          upload.
        </Callout>
      ) : (
        <span className="row small muted">
          <Icon name="idle" /> Checking the audio…
        </span>
      )}
      {issues.length > 0 && (
        <Callout tone="warn" icon="microphoneWarning">
          <strong>Audio gaps in this session</strong> (kept as they are; note them for the analysis):
          <ul style={{ margin: "4px 0 0", paddingLeft: "1.2em" }}>
            {issues.map((l) => (
              <li key={l.text}>{l.text}</li>
            ))}
          </ul>
        </Callout>
      )}
    </div>
  );
}
