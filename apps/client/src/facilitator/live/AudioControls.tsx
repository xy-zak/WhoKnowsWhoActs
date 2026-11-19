import { calibrationWaitingSeats, type GameState, micCheckHoldSeats, seatsInMicCheck } from "@wkwa/shared";
import { Button, Callout, Icon, SeatDot, StatusTag, usePromptReason } from "../../ui";
import { calibrationSummary } from "../audioLive";
import type { FacilitatorConnection } from "../connection";

/*
 * The NEXT panel's audio block (sessions that record audio): the calibration (start / redo /
 * skip) and the seats stuck in their mic check (skip, with a logged reason). Every refusal of the
 * server (e.g. "Waiting for the mic check of seat 3", "Recording is paused") shows as a toast.
 */

/** The reason field of the skip confirmations (a reason is required: it is logged with the event). */
const SKIP_REASON = {
  label: "Reason (logged; no names or personal data)",
  placeholder: "e.g. no working microphone",
  required: true,
};

/** The calibration's state as a tag: with its detail (NEXT panel), or `short` (the calibration card). */
export function CalibrationTag({ st, short = false }: { st: GameState; short?: boolean }) {
  const s = calibrationSummary(st);
  return (
    <StatusTag tone={s.tone} icon={s.icon} tip={s.tip}>
      {short ? s.label : s.text}
    </StatusTag>
  );
}

/**
 * The calibration and mic-check block of the NEXT panel. `primary` makes Start calibration the
 * view's primary button (when it is the next thing to do).
 */
export function AudioNext({
  conn,
  st,
  primary,
}: {
  conn: FacilitatorConnection;
  st: GameState;
  primary: boolean;
}) {
  const promptReason = usePromptReason();
  const run = (name: string, payload: unknown, ok: string) =>
    void conn.cmd(name, payload, ok).catch(() => {});
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
    if (reason !== null) run("calibration:skip", { reason }, "Calibration skipped");
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
    if (reason !== null) run("mic:skip", { seat, reason }, `Mic check of seat ${seat} skipped`);
  };
  const held = micCheckHoldSeats(st);
  const inCheck = seatsInMicCheck(st);
  const startable = c.status === "pending" && waiting.length === 0 && !a.recordingPaused;

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
        {canCalibrate && c.status === "pending" && (
          <Button
            variant={primary && startable ? "primary" : "secondary"}
            icon="voice"
            onClick={() => run("calibration:start", {}, "Calibration started")}
            tip={
              waiting.length
                ? `Waiting for the mic check of seat ${waiting.map((s) => s.seat).join(", ")}`
                : "Each seat in turn reads a sentence aloud while the others stay quiet (about 7 s per seat)"
            }
          >
            Start calibration
          </Button>
        )}
        {canCalibrate && (c.status === "running" || c.status === "done" || c.status === "skipped") && (
          <Button
            icon="refresh"
            onClick={() => run("calibration:redo", {}, "Calibration started again")}
            tip="Run the calibration again from the first seat (e.g. after a seat moved closer to its microphone)"
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
      {held.length > 0 && st.phase === "onboarding" && (
        <span className="hint">
          <Icon name="idle" /> Mic checks are held until seat {held.join(", ")}{" "}
          {held.length > 1 ? "have" : "has"} finished the consent form (no microphone opens before everyone
          agreed).
        </span>
      )}
      {inCheck.length > 0 && !held.length && (
        <div className="col" style={{ gap: "var(--s1)" }}>
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
