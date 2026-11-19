import type { PlayerView } from "@wkwa/shared";
import { useEffect, useRef, useState } from "react";
import { Icon, SeatDot, type StepDef, Stepper } from "../ui";
import { Centered, ReadyScreen } from "./chrome";
import type { PlayerConnection } from "./connection";
import { MicLevelMeter, useRecording } from "./RecordingIndicator";

/** Whole seconds left until `endsAt` (server clock), redrawn once a second: a static number, no animation. */
function useSecondsLeft(conn: PlayerConnection, endsAt: number | null): number | null {
  const [, tick] = useState(0);
  useEffect(() => {
    if (endsAt === null) return;
    const t = setInterval(() => tick((x) => x + 1), 250);
    return () => clearInterval(t);
  }, [endsAt]);
  if (endsAt === null) return null;
  return Math.max(0, Math.ceil((endsAt - conn.clock.now()) / 1000));
}

/** Is the facilitator's calibration running for this seat's screen? */
export function isCalibrating(v: PlayerView | null): boolean {
  return (
    !!v &&
    v.audio.enabled &&
    v.audio.calibration.status === "running" &&
    !v.me.withdrawn &&
    v.me.consent !== "declined" &&
    (v.phase === "onboarding" || v.phase === "round_complete")
  );
}

/**
 * The calibration turns as a stepper: done ✓, the seat reading now ▶, the seats still to come.
 * Between turns (`last` = index of the turn that just ended) nothing is current.
 */
function TurnStepper({ view, last }: { view: PlayerView; last: number }) {
  const c = view.audio.calibration;
  const steps: StepDef[] = c.order.map((seat) => ({
    key: String(seat),
    label: seat === view.me.seat ? `Seat ${seat} (you)` : `Seat ${seat}`,
  }));
  const idx = c.turnSeat === null ? -1 : c.order.indexOf(c.turnSeat);
  return <Stepper steps={steps} current={idx} completed={(i) => (idx >= 0 ? i < idx : i <= last)} />;
}

/** READY in a session that records audio, until the facilitator runs (or skips) the calibration. */
export function CalibrationPendingScreen({ view }: { view: PlayerView }) {
  return (
    <ReadyScreen view={view} waitingFor="the facilitator" width={720}>
      <p>
        <Icon name="voice" /> Next, the facilitator runs a short <strong>sound calibration</strong>: each
        player in turn reads one sentence aloud, while everyone else stays quiet.
      </p>
    </ReadyScreen>
  );
}

/**
 * The facilitator-led calibration while it runs (sessions that record audio): each seat in turn
 * reads a sentence aloud while the others stay quiet, which measures how much each voice reaches
 * the other microphones. It covers the onboarding screen underneath, which keeps its answers.
 */
export function CalibrationScreen({ conn, view }: { conn: PlayerConnection; view: PlayerView }) {
  const c = view.audio.calibration;
  const snap = useRecording(conn);
  const left = useSecondsLeft(conn, c.myTurn ? c.turnEndsAt : null);
  // index of the latest turn seen, for the gap between two turns (the view has no turn then)
  const lastTurn = useRef(-1);
  if (c.status !== "running") lastTurn.current = -1;
  else if (c.turnSeat !== null) lastTurn.current = c.order.indexOf(c.turnSeat);
  const last = lastTurn.current;

  if (c.myTurn) {
    return (
      <Centered title="Calibration" icon="voice" width={760}>
        <TurnStepper view={view} last={last} />
        <h1 style={{ margin: 0 }}>Your turn: read this sentence aloud</h1>
        <blockquote
          className="strong"
          style={{
            margin: 0,
            padding: "var(--s4)",
            borderLeft: "3px solid var(--live)",
            background: "var(--sunken)",
            fontSize: "var(--fs-title)",
            width: "100%",
            boxSizing: "border-box",
          }}
        >
          {c.sentence ?? "One, two, three, four, five, six, seven, eight."}
        </blockquote>
        <p className="muted" style={{ margin: 0 }}>
          In your normal voice, facing your microphone
          {left !== null && (
            <>
              {" "}
              · <strong className="mono">{left} s</strong> left
            </>
          )}
        </p>
        <MicLevelMeter conn={conn} state={snap.status.state} />
      </Centered>
    );
  }

  const next = c.turnSeat === null ? (c.order[last + 1] ?? null) : null;
  return (
    <Centered title="Calibration" icon="voice" width={760}>
      <TurnStepper view={view} last={last} />
      <h1 style={{ margin: 0 }}>
        {c.turnSeat !== null ? (
          <>
            Stay quiet: <SeatDot seat={c.turnSeat} /> seat {c.turnSeat} is reading
          </>
        ) : (
          "Stay quiet, please"
        )}
      </h1>
      <p className="muted" style={{ margin: 0 }}>
        {c.turnSeat === null && next !== null
          ? next === view.me.seat
            ? "Your turn is next: get ready to read a sentence aloud"
            : `Next: seat ${next}`
          : "Please do not speak until it is your turn. Your sentence appears here when it is"}
      </p>
    </Centered>
  );
}
