import {
  activeSeats,
  canStartFirstRound,
  type GameState,
  isParticipant,
  micCheckApplies,
  micCheckHoldSeats,
  type SeatState,
} from "@wkwa/shared";
import { useState } from "react";
import { Button, Callout, Field, Icon, Popup, SeatDot, StatusTag } from "../../ui";
import type { FacilitatorConnection } from "../connection";

/*
 * The NEXT panel's audio block (sessions that record audio): the calibration (start / redo /
 * skip) and the seats stuck in their mic check (skip, with a logged reason). Every refusal of the
 * server (e.g. "Waiting for the mic check of seat 3", "Recording is paused") shows as a toast.
 */

/** Is the calibration still needed before round 1? */
export function calibrationNeeded(st: GameState): boolean {
  return !canStartFirstRound(st);
}

/** Real seats the calibration waits for: not past their mic check yet (consent included). */
export function calibrationWaiting(st: GameState): SeatState[] {
  return activeSeats(st).filter(
    (s) =>
      isParticipant(s) && (s.consent !== "given" || (micCheckApplies(st, s) && s.micCheck === "pending")),
  );
}

/** Seats in their own mic check now (consent given, check pending): the facilitator may skip them. */
export function seatsInMicCheck(st: GameState): SeatState[] {
  if (st.phase !== "onboarding") return [];
  return activeSeats(st).filter(
    (s) => micCheckApplies(st, s) && s.consent === "given" && s.micCheck === "pending",
  );
}

/** Popup asking for a reason (logged with the event); Confirm is enabled once a reason is typed. */
function ReasonPopup({
  title,
  message,
  confirmLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  message: React.ReactNode;
  confirmLabel: string;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const ok = reason.trim().length > 0;
  return (
    <Popup
      title={title}
      icon="warning"
      width={560}
      onClose={onClose}
      footer={
        <>
          <Button icon="close" kbd="Esc" onClick={onClose}>
            Cancel
          </Button>
          <span className="spacer" />
          <Button
            variant="primary"
            icon="ok"
            disabled={!ok}
            onClick={() => onConfirm(reason.trim())}
            tip={ok ? "Logged with this reason" : "Type a short reason first"}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="col">
        <div>{message}</div>
        <Field label="Reason (logged; no names or personal data)">
          <input
            type="text"
            value={reason}
            maxLength={200}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. no working microphone"
            aria-label="Reason"
          />
        </Field>
      </div>
    </Popup>
  );
}

function CalibrationStatus({ st }: { st: GameState }) {
  const c = st.audio.calibration;
  switch (c.status) {
    case "running": {
      const turn = c.turns[c.turns.length - 1];
      const reading = turn && turn.endTs === null ? turn.seat : null;
      return (
        <StatusTag tone="live" icon="voice" tip="Each seat reads its sentence while the others stay quiet">
          running ·{" "}
          {reading !== null
            ? `seat ${reading} reading (${c.order.indexOf(reading) + 1}/${c.order.length})`
            : `between turns (${c.turns.length}/${c.order.length})`}
        </StatusTag>
      );
    }
    case "done": {
      const q = c.quality;
      if (!q)
        return (
          <StatusTag tone="warn" icon="idle" tip="The turns are over; the quick check waits for their audio">
            done · checking the audio
          </StatusTag>
        );
      const weak = q.perSeat.filter((p) => !p.ok);
      return weak.length === 0 ? (
        <StatusTag tone="live" icon="ok" tip="Every seat's own voice is clearly louder on its own microphone">
          done · separation ok
        </StatusTag>
      ) : (
        <StatusTag
          tone="warn"
          icon="microphoneWarning"
          tip="A seat's voice is nearly as loud on another microphone: move it closer to its own mic (or use a headset) and redo"
        >
          done · weak separation:{" "}
          {weak
            .map(
              (p) =>
                `seat ${p.seat}${p.marginDb !== null ? ` (${p.marginDb >= 0 ? "+" : ""}${p.marginDb} dB)` : ""}`,
            )
            .join(", ")}
        </StatusTag>
      );
    }
    case "skipped":
      return (
        <StatusTag
          icon="close"
          tip="Skipped: attribution estimates the leakage between microphones from the recording"
        >
          skipped
        </StatusTag>
      );
    default:
      return (
        <StatusTag tone="warn" icon="idle" tip="Each seat reads a sentence in turn, before round 1">
          not run yet
        </StatusTag>
      );
  }
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
  const [ask, setAsk] = useState<null | { kind: "calibration" } | { kind: "mic"; seat: number }>(null);
  const run = (name: string, payload: unknown, ok: string) =>
    void conn.cmd(name, payload, ok).catch(() => {});
  const a = st.audio;
  const c = a.calibration;
  const canCalibrate = st.phase === "onboarding" || st.phase === "round_complete";
  const waiting = calibrationWaiting(st);
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
        <CalibrationStatus st={st} />
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
            onClick={() => setAsk({ kind: "calibration" })}
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
                onClick={() => setAsk({ kind: "mic", seat: s.seat })}
                tip={`Skip seat ${s.seat}'s mic check (e.g. no working microphone): the player goes on and this seat is not recorded`}
              >
                Skip mic check
              </Button>
            </div>
          ))}
        </div>
      )}
      {ask?.kind === "calibration" && (
        <ReasonPopup
          title={c.status === "running" ? "Cancel the calibration?" : "Skip the calibration?"}
          message={
            <>
              <p>Round 1 can then start without it.</p>
              <p className="muted">
                Speaker attribution then estimates how much each voice reaches the other microphones from the
                recording itself, which is less precise.
              </p>
            </>
          }
          confirmLabel="Skip calibration"
          onClose={() => setAsk(null)}
          onConfirm={(reason) => {
            setAsk(null);
            run("calibration:skip", { reason }, "Calibration skipped");
          }}
        />
      )}
      {ask?.kind === "mic" && (
        <ReasonPopup
          title={`Skip seat ${ask.seat}'s mic check?`}
          message={
            <>
              <p>
                The player goes on with the onboarding, and this seat is not recorded for the rest of the
                session.
              </p>
              <p className="muted">Use it when the microphone cannot be made to work.</p>
            </>
          }
          confirmLabel="Skip mic check"
          onClose={() => setAsk(null)}
          onConfirm={(reason) => {
            const seat = ask.seat;
            setAsk(null);
            run("mic:skip", { seat, reason }, `Mic check of seat ${seat} skipped`);
          }}
        />
      )}
    </div>
  );
}
