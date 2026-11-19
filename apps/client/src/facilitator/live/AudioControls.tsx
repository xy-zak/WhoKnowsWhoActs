import {
  calibrationNotReadySeats,
  calibrationSeats,
  calibrationWaitingSeats,
  calibrationWaitsIn,
  micCheckHoldSeats,
  type ReadonlyGameState,
  seatsInMicCheck,
} from "@wkwa/shared";
import { Button, Callout, Icon, SeatDot, StatusTag, usePromptReason } from "../../ui";
import { calibrationSummary } from "../audioLive";
import type { FacilitatorConnection } from "../connection";

/*
 * The NEXT panel's audio block (sessions that record audio): the calibration (who is ready, redo,
 * skip) and the seats stuck in their mic check (skip, with a logged reason). The calibration starts
 * by itself once every recorded seat has said it is ready, so there is no start button. Every
 * refusal of the server (e.g. "Recording is paused") shows as a toast.
 */

/** The reason field of the skip confirmations (a reason is required: it is logged with the event). */
const SKIP_REASON = {
  label: "Reason (logged; no names or personal data)",
  placeholder: "e.g. no working microphone",
  required: true,
};

/** The calibration's state as a tag: with its detail (NEXT panel), or `short` (the calibration card). */
export function CalibrationTag({ st, short = false }: { st: ReadonlyGameState; short?: boolean }) {
  const s = calibrationSummary(st);
  return (
    <StatusTag tone={s.tone} icon={s.icon} tip={s.tip}>
      {short ? s.label : s.text}
    </StatusTag>
  );
}

/** The calibration and mic-check block of the NEXT panel. */
export function AudioNext({ conn, st }: { conn: FacilitatorConnection; st: ReadonlyGameState }) {
  const promptReason = usePromptReason();
  const a = st.audio;
  const c = a.calibration;
  const canCalibrate = st.phase === "onboarding" || st.phase === "round_complete";
  const waiting = calibrationWaitingSeats(st);
  const skipCalibration = async () => {
    const reason = await promptReason({
      title: c.status === "running" ? "Cancel the calibration?" : "Skip the calibration?",
      icon: "warning",
      confirmLabel: "Skip calibration",
      reason: SKIP_REASON,
      message: (
        <>
          <p>Round 1 can then start without it.</p>
          <p className="muted">
            Speaker attribution then estimates how much each voice reaches the other microphones from the
            recording itself, which is less precise.
          </p>
        </>
      ),
    });
    if (reason !== null) conn.run("calibration:skip", { reason }, "Calibration skipped");
  };
  const skipMicCheck = async (seat: number) => {
    const reason = await promptReason({
      title: `Skip seat ${seat}'s mic check?`,
      icon: "warning",
      confirmLabel: "Skip mic check",
      reason: SKIP_REASON,
      message: (
        <>
          <p>
            The player goes on with the onboarding, and this seat is not recorded for the rest of the session.
          </p>
          <p className="muted">Use it when the microphone cannot be made to work.</p>
        </>
      ),
    });
    if (reason !== null) conn.run("mic:skip", { seat, reason }, `Mic check of seat ${seat} skipped`);
  };
  const held = micCheckHoldSeats(st);
  const inCheck = seatsInMicCheck(st);
  // who the waiting calibration reads in, and who of them said they are ready
  const waitsHere = c.status === "pending" && calibrationWaitsIn(st);
  const notReady = new Set(calibrationNotReadySeats(st));
  const readers = waitsHere && waiting.length === 0 ? calibrationSeats(st) : [];

  return (
    <div
      className="col"
      style={{ gap: "var(--s2)", borderTop: "1px dashed var(--frame)", paddingTop: "var(--s2)" }}
    >
      <div className="row">
        <span className="small upper muted">
          <Icon name="voice" /> Calibration
        </span>
        <CalibrationTag st={st} />
        <span className="spacer" />
        {canCalibrate && (c.status === "running" || c.status === "done" || c.status === "skipped") && (
          <Button
            icon="refresh"
            onClick={() => conn.run("calibration:redo", {}, "Calibration asked for again")}
            tip="Run the calibration again (e.g. after a seat moved closer to its microphone): every seat says again that it is ready, then it starts by itself"
          >
            Redo
          </Button>
        )}
        {(c.status === "pending" || c.status === "running") && (
          <Button
            icon="close"
            onClick={() => void skipCalibration()}
            tip={
              c.status === "running"
                ? "Cancel the running calibration and go on without it (asks for a reason)"
                : "Go on without a calibration (asks for a reason)"
            }
          >
            Skip calibration
          </Button>
        )}
      </div>
      {a.recordingPaused && canCalibrate && c.status !== "done" && (
        <Callout tone="warn" icon="microphoneOff">
          Recording is paused: resume recording to run the calibration.
        </Callout>
      )}
      {readers.length > 0 && (
        <div className="row small">
          <span className="muted">Ready for the calibration:</span>
          {readers.map((seat) => (
            <span key={seat} className="row nowrap gap-1">
              <SeatDot seat={seat} /> {seat}{" "}
              {notReady.has(seat) ? (
                <span className="faint">waiting</span>
              ) : (
                <span className="t-live">
                  <Icon name="ok" /> ready
                </span>
              )}
            </span>
          ))}
          <span className="hint">It starts by itself once every seat is ready.</span>
        </div>
      )}
      {held.length > 0 && st.phase === "onboarding" && (
        <span className="hint">
          <Icon name="idle" /> Mic checks are held until seat {held.join(", ")}{" "}
          {held.length > 1 ? "have" : "has"} finished the briefing (no microphone opens before everyone has
          agreed and is ready).
        </span>
      )}
      {inCheck.length > 0 && !held.length && (
        <div className="col gap-1">
          {inCheck.map((s) => (
            <div key={s.seat} className="row nowrap small">
              <SeatDot seat={s.seat} />
              <span>Seat {s.seat}: in the mic check</span>
              <span className="spacer" />
              <Button
                size="sm"
                icon="microphoneOff"
                onClick={() => void skipMicCheck(s.seat)}
                tip={`Skip seat ${s.seat}'s mic check (e.g. no working microphone): the player goes on and this seat is not recorded`}
              >
                Skip mic check
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
