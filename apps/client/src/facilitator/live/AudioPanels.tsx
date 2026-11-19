import {
  CALIBRATION_MIN_MARGIN_DB,
  currentCalibrationTurn,
  type FacilitatorCommand,
  type FacilitatorPayload,
  RECORDING_PHASES,
  type ReadonlyGameState,
} from "@wkwa/shared";
import { useEffect, useMemo, useState } from "react";
import { fmtSigned, fmtTime, formatDb, PLACEHOLDER } from "../../common/format";
import { useStore } from "../../net/store";
import { Button, Callout, Icon, Panel, SeatDot, StatusTag, usePromptReason } from "../../ui";
import {
  type AudioCheck,
  calibrationAdvice,
  micStatsOf,
  type TrackStatusLite,
  wrapUpAudioCheck,
} from "../audioLive";
import type { FacilitatorConnection } from "../connection";
import { CalibrationTag } from "./AudioControls";

/*
 * LIVE audio monitoring beside the NEXT panel: the calibration quality card, the TOOLS panel's
 * recording pause, and the wrap-up audio check. Rules: docs/AESTHETIC-RULES.md § 8.1.
 */

/* ─────────────────────────── calibration quality ─────────────────────────── */

/**
 * The calibration and its quality check: which turn runs, "checking…" between the end of the
 * last turn and the check, then per seat the margin of its own voice over the loudest other mic,
 * the verdict and plain advice for each seat that failed. Hidden until a calibration ran.
 */
export function CalibrationCard({ st }: { st: ReadonlyGameState }) {
  if (!st.audio.enabled) return null;
  const c = st.audio.calibration;
  const cancelled = c.status === "pending" ? c.lastCancel : null;
  if (c.status === "pending" && !cancelled) return null;
  const q = c.quality;
  const advice = q ? q.perSeat.map(calibrationAdvice).filter((a): a is string => a !== null) : [];
  const turn = currentCalibrationTurn(st);
  return (
    <Panel title="Calibration" icon="voice">
      <div className="col">
        {cancelled && (
          <Callout tone="warn" icon="warning">
            The calibration was cancelled at {fmtTime(cancelled.ts)}
            {cancelled.reason ? ` (${cancelled.reason})` : ""}. Run it again (or skip it) in the NEXT panel
            before round 1.
          </Callout>
        )}
        {c.status === "running" && (
          <div className="row">
            <CalibrationTag st={st} short />
            <span>
              {turn
                ? `Turn ${c.order.indexOf(turn.seat) + 1}/${c.order.length}: seat ${turn.seat} reads its sentence aloud; everyone else stays quiet.`
                : "Starting…"}
            </span>
          </div>
        )}
        {c.status === "skipped" && (
          <div className="row">
            <CalibrationTag st={st} short />
            <span className="muted">
              No calibration: speaker attribution assumes a conservative leakage between the microphones
              (overlapping speech is missed more often).
            </span>
          </div>
        )}
        {c.status === "done" && !q && (
          <div className="row">
            <CalibrationTag st={st} short />
            <span>Calibration complete. Checking how well the microphones keep the voices apart…</span>
          </div>
        )}
        {c.status === "done" && q && (
          <>
            <div className="row">
              <CalibrationTag st={st} short />
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
                    <td className="mono small">{r.ownDb === null ? PLACEHOLDER : formatDb(r.ownDb)}</td>
                    <td className="mono small">
                      {r.bestOtherDb === null ? PLACEHOLDER : formatDb(r.bestOtherDb)}
                    </td>
                    <td className={`mono${r.ok ? "" : " t-warn strong"}`}>{fmtSigned(r.marginDb, "dB")}</td>
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

/**
 * Pause recording for every seat (after a confirmation with an optional reason) or resume it.
 * Players cannot mute themselves; both are logged by the server. Only possible while audio is
 * recorded (onboarding and rounds).
 */
export function RecordingControl({ conn, st }: { conn: FacilitatorConnection; st: ReadonlyGameState }) {
  const promptReason = usePromptReason();
  const [busy, setBusy] = useState(false);
  if (!st.audio.enabled) return null;
  const can = RECORDING_PHASES.has(st.phase);
  const a = st.audio;
  const send = <K extends FacilitatorCommand>(name: K, payload: FacilitatorPayload<K>, ok: string) => {
    setBusy(true);
    void conn
      .cmd(name, payload, ok)
      .catch(() => {})
      .finally(() => setBusy(false));
  };
  const pause = async () => {
    const reason = await promptReason({
      title: "Pause recording for everyone?",
      icon: "microphoneOff",
      confirmLabel: "Pause recording",
      reason: {
        label: "Reason (optional, logged and exported: never type names)",
        placeholder: "e.g. break, private conversation",
      },
      message: (
        <div className="col">
          <p>
            Every microphone stops recording now; the game itself goes on. Players see{" "}
            <em>Recording paused by the facilitator</em> until you resume. The pause and your reason are
            logged.
          </p>
          {a.calibration.status === "running" && (
            <Callout tone="warn" icon="warning">
              The calibration that is running is cancelled: run it again after resuming.
            </Callout>
          )}
        </div>
      ),
    });
    if (reason !== null) send("recording:pause", reason ? { reason } : {}, "Recording paused");
  };
  return (
    <div className="row">
      {a.recordingPaused ? (
        <>
          <StatusTag
            tone="warn"
            icon="microphoneOff"
            tip="No seat is recorded; players see 'Recording paused by the facilitator'"
          >
            recording paused
          </StatusTag>
          <span className="small muted">
            {a.pausedTs !== null ? `since ${fmtTime(a.pausedTs)}` : ""}
            {a.pauseReason ? ` · “${a.pauseReason}”` : ""}
          </span>
          <span className="spacer" />
          <Button
            icon="microphone"
            disabled={!can || busy}
            onClick={() => send("recording:resume", {}, "Recording resumed")}
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
            onClick={() => void pause()}
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
    </div>
  );
}

/* ─────────────────────────── wrap-up: audio check ─────────────────────────── */

const POLL_MS = 5000;

/**
 * The wrap-up's audio check, refreshed every few seconds until everything is on the server: every
 * real seat's tracks closed and no upload pending ("All audio uploaded"), else what is still on its
 * way and what went missing. Polling starts again if a seat reports pending chunks later.
 * Non-blocking: the facilitator can still close. Returns the check for the caller's buttons.
 */
export function useAudioCheck(conn: FacilitatorConnection, st: ReadonlyGameState): AudioCheck | null {
  const stats = useStore(conn.store).dashboard?.stats;
  const [tracks, setTracks] = useState<TrackStatusLite[] | null>(null);
  const id = st.sessionId;
  const enabled = st.audio.enabled;
  const check = useMemo(
    () => (enabled ? wrapUpAudioCheck(st, micStatsOf(stats), tracks) : null),
    [enabled, st, stats, tracks],
  );
  const settled = check?.uploaded === true;
  useEffect(() => {
    if (!enabled || !id || settled) return;
    let stop = false;
    const load = async () => {
      // quiet: a failed poll must not raise an error toast every few seconds
      const body = await conn
        .api<{ tracks?: TrackStatusLite[] }>(`/api/sessions/${encodeURIComponent(id)}/audio`, { quiet: true })
        .catch(() => null);
      if (body && !stop) setTracks(body.tracks ?? []);
    };
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [conn, id, enabled, settled]);
  return check;
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
