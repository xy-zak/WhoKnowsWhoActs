import type { PlayerView } from "@wkwa/shared";
import { useEffect, useRef, useState } from "react";
import { Button, Callout, Icon, SeatDot, StatusTag, type StepDef, Stepper } from "../ui";
import { Centered, OnboardingStepper, ReadyScreen } from "./chrome";
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

/**
 * Does the calibration cover this seat's screen? While it runs, and in a round break while a redo
 * waits for the players to say they are ready (before round 1 the READY screen shows that part).
 */
export function isCalibrating(v: PlayerView | null): boolean {
  if (!v || !v.audio.enabled || v.me.withdrawn || v.me.consent === "declined") return false;
  const c = v.audio.calibration;
  if (v.phase === "round_complete")
    return c.status === "running" || (c.status === "pending" && c.waitingFor.length > 0);
  return v.phase === "onboarding" && c.status === "running";
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

/**
 * Part 2 of "Mic check & calibration" (sessions that record audio), after this seat's mic check:
 * what the calibration is, and the "I'm ready for the calibration" button, so it never starts by
 * surprise. Once every recorded seat has clicked it, the server starts the turns. A seat that is
 * not recorded (no audio permission, mic check skipped) only waits.
 */
export function CalibrationPendingScreen({ conn, view }: { conn: PlayerConnection; view: PlayerView }) {
  const c = view.audio.calibration;
  const snap = useRecording(conn);
  const [busy, setBusy] = useState(false);
  const others = c.waitingFor.filter((s) => s !== view.me.seat);
  if (!c.canSayReady && !c.ready) {
    return (
      <ReadyScreen view={view} waitingFor="the calibration" width={720}>
        <p>
          <Icon name="voice" /> Next, the other players do a short <strong>sound calibration</strong>: each in
          turn reads one sentence aloud. Please stay quiet while they do.
        </p>
      </ReadyScreen>
    );
  }
  const sayReady = async () => {
    setBusy(true);
    try {
      await conn.request("calibration:ready", { clientTs: conn.clock.now() });
    } catch (e) {
      conn.showToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Centered title="Mic check & calibration" icon="voice" width={760}>
      {view.phase === "onboarding" && <OnboardingStepper v={view} current="mic_check" />}
      <StatusTag tone="live" icon="ok">
        part 1 · mic check done
      </StatusTag>
      <h1 style={{ margin: 0 }}>Part 2: the calibration</h1>
      <p style={{ margin: 0 }}>
        Each player in turn reads <strong>one sentence aloud</strong> from their screen (about 6 seconds),
        while everyone else stays quiet. This measures how loud each voice is on each microphone.
      </p>
      <div className="row" style={{ gap: "var(--s3)" }}>
        <span className="small upper muted">Your microphone</span>
        <MicLevelMeter conn={conn} state={snap.status.state} />
      </div>
      {c.ready ? (
        <Callout tone="live" icon="ok">
          <strong>You are ready.</strong>{" "}
          {others.length
            ? `Waiting for seat ${others.join(", ")}. The calibration starts as soon as everyone is ready.`
            : "The calibration is starting."}
        </Callout>
      ) : (
        <>
          <p className="muted" style={{ margin: 0 }}>
            When you are seated with your headset on and ready to read, click the button. The calibration
            starts once every player has.
          </p>
          <Button
            variant="primary"
            size="lg"
            icon="voice"
            disabled={busy}
            onClick={() => void sayReady()}
            tip="Tell the others you are ready; the calibration starts once everyone is"
          >
            I'm ready for the calibration
          </Button>
        </>
      )}
    </Centered>
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

  if (c.status === "pending") return <CalibrationPendingScreen conn={conn} view={view} />;

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
