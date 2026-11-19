import { AudioCaptureSettingsSchema, clampDb, type PlayerView } from "@wkwa/shared";
import { useEffect, useRef, useState } from "react";
import { classifyMicError, MicError, micSupportProblem } from "../audio";
import { useStore } from "../net/store";
import { AsciiProgress, Button, Callout, Icon, RecTag, StatusTag } from "../ui";
import type { PlayerConnection } from "./connection";
import { MicCheckAttempt, type MicCheckOutcome } from "./micCheckAttempt";
import { Page } from "./Onboarding";
import { MicFixSteps, MicLevelMeter, useRecording } from "./RecordingIndicator";
import { recStateFor } from "./recording";

/** Cells of the speech-heard bar. */
const SPEECH_CELLS = 10;

/** `▰▰▰▱▱ 0.6/1.0 s`: speech heard so far, out of what the check needs. */
function SpeechProgress({ ms, need }: { ms: number; need: number }) {
  const heard = Math.min(ms, need);
  return (
    <AsciiProgress
      used={heard}
      limit={need}
      width={SPEECH_CELLS}
      // whole cells only: the bar is full only once the check passed
      filled={Math.floor((heard / need) * SPEECH_CELLS)}
      label="Speech heard"
      text={`${(heard / 1000).toFixed(1)}/${(need / 1000).toFixed(1)} s`}
    />
  );
}

/** Sends one mic check result (`mic:check`); false when it failed (shown as a toast). */
async function submitMicCheck(conn: PlayerConnection, o: MicCheckOutcome): Promise<boolean> {
  const r = o.result;
  const contextSampleRate = conn.recording.store.get().contextSampleRate;
  try {
    await conn.request("mic:check", {
      passed: o.passed,
      attempts: o.attempts,
      durationMs: o.durationMs,
      // only the processing flags and the sample rate (the schema strips anything else)
      settings: AudioCaptureSettingsSchema.safeParse(conn.recording.captureSettings).data ?? {},
      ...(contextSampleRate ? { contextSampleRate } : {}),
      noiseFloorDb: clampDb(r.noiseFloorDb),
      speechDb: clampDb(r.speechDb),
      speechMs: Math.max(0, r.speechMs),
      clientTs: conn.clock.now(),
    });
    return true;
  } catch (e) {
    conn.showToast((e as Error).message);
    return false;
  }
}

/**
 * Onboarding step `mic_check` (sessions that record audio). Held while another seat is still in
 * consent (no microphone opens before everyone agreed). Then: what is recorded and for how long,
 * a Start button (the user gesture the browser needs), the live level, the phrase to read aloud
 * and the speech heard so far. Passing sends `mic:check` and moves on; there is no skip for the
 * player (the facilitator can skip a seat). Recording starts here and runs until the game ends.
 */
export function MicCheckScreen({ conn, view }: { conn: PlayerConnection; view: PlayerView }) {
  const a = view.audio;
  const snap = useRecording(conn);
  const need = a.micCheckMinSpeechMs ?? 1000;
  const [check] = useState(
    () =>
      new MicCheckAttempt({
        minSpeechMs: need,
        // the Start click survives a remount of this screen (the recorder keeps it)
        resumed: conn.recording.store.get().gesture,
        submit: (o) => submitMicCheck(conn, o),
      }),
  );
  const c = useStore(check.store);
  useEffect(() => () => check.close(), [check]);
  const support = useRef(micSupportProblem()).current;

  const st = snap.status.state;
  const failed = st === "denied" || st === "error";
  // the participant clicked Start (in this page: a reload asks again)
  const started = c.attempts > 0 && snap.gesture;
  const listening = c.attempts > 0;
  // feed the recorder's 16 kHz blocks into the attempt's speech detector
  useEffect(
    () => (listening ? conn.recording.addTap((s) => check.push(s)) : undefined),
    [listening, conn, check],
  );

  const gaveUp = started && c.gaveUp;

  const start = () => {
    // inside the click: the browser only lets audio start from a user gesture
    conn.recording.startFromClick();
    check.start();
  };

  if (a.micCheckHeld) {
    return (
      <Page
        view={view}
        step="mic_check"
        title="Mic check"
        icon="microphone"
        footer={
          <>
            <StatusTag tone="warn" icon="idle">
              waiting
            </StatusTag>
            <span className="spacer" />
          </>
        }
      >
        <h2 style={{ margin: 0 }}>Waiting for the other players to finish the consent form</h2>
        <p className="muted cursor">
          Your microphone stays off until everyone in the room has agreed. This takes a moment
        </p>
      </Page>
    );
  }

  const recState = recStateFor(view, snap) ?? "off";
  const supportError = support ? classifyMicError(new MicError(support)) : null;
  const error = failed ? snap.status.error : supportError;
  const needsResume = started && snap.status.needsGesture;

  let primary: React.ReactNode;
  if (!started || failed) {
    primary = (
      <Button
        variant="primary"
        size="lg"
        icon={failed ? "refresh" : "microphone"}
        disabled={c.busy}
        onClick={start}
        tip="Your browser asks to use the microphone: choose Allow"
      >
        {failed ? "Try again" : "Start mic check"}
      </Button>
    );
  } else if (needsResume) {
    primary = (
      <Button
        variant="primary"
        size="lg"
        icon="microphone"
        onClick={() => conn.recording.fixFromClick()}
        tip="Your browser needs a click to use the microphone"
      >
        Resume
      </Button>
    );
  } else if (c.unsent) {
    primary = (
      <Button
        variant="primary"
        size="lg"
        icon="next"
        disabled={c.busy}
        onClick={() => check.resend()}
        tip="The mic check passed: send the result again and go on"
      >
        Continue
      </Button>
    );
  } else if (gaveUp) {
    primary = (
      <Button
        variant="primary"
        size="lg"
        icon="refresh"
        disabled={c.busy}
        onClick={start}
        tip="Listen again from the start"
      >
        Start again
      </Button>
    );
  } else {
    primary = null;
  }

  return (
    <Page
      view={view}
      step="mic_check"
      title="Mic check"
      icon="microphone"
      footer={
        <>
          {started && !failed && <RecTag state={recState} />}
          <span className="spacer" />
          {primary}
        </>
      }
    >
      <p style={{ margin: 0 }}>
        <strong>From now until the end of the game, your microphone is recorded</strong> (you agreed to this
        in the consent form). There is no mute button: the facilitator can pause the recording for everyone.
      </p>
      <p className="muted small" style={{ margin: 0 }}>
        <Icon name="info" /> Wear the headset at your seat, its microphone at the corner of your mouth (about
        two fingers away). If your device asks which microphone to use, choose the headset.
      </p>

      {error ? (
        <Callout tone="danger" icon="microphoneWarning">
          <strong>{error.title}</strong>
          <MicFixSteps error={error} />
        </Callout>
      ) : !started ? (
        <Callout icon="microphone">
          Click <strong>Start mic check</strong>. Your browser will ask to use the microphone: choose{" "}
          <strong>Allow</strong>. Then read a short sentence aloud.
        </Callout>
      ) : (
        <div className="col" style={{ gap: "var(--s3)" }}>
          <div className="row" style={{ gap: "var(--s3)" }}>
            <span className="small upper muted">Your microphone</span>
            <MicLevelMeter conn={conn} state={st} />
          </div>
          {c.passed ? (
            <Callout tone="live" icon="ok">
              <strong>Mic check passed.</strong> We can hear you clearly. Recording continues while you go on
            </Callout>
          ) : (
            <>
              <span className="small upper muted">Read this aloud, in your normal voice</span>
              <blockquote
                className="strong"
                style={{
                  margin: 0,
                  padding: "var(--s3) var(--s4)",
                  borderLeft: "3px solid var(--primary)",
                  background: "var(--sunken)",
                  fontSize: "var(--fs-title)",
                }}
              >
                {a.micCheckPhrase ?? "One, two, three, four, five."}
              </blockquote>
              <span className="row" style={{ gap: "var(--s2)" }}>
                <span className="small upper muted">Speech heard</span>
                <SpeechProgress ms={c.result?.speechMs ?? 0} need={need} />
              </span>
            </>
          )}
          {st === "no_signal" && (
            <Callout tone="warn" icon="microphoneWarning">
              No sound from your microphone. Check that it is plugged in, switched on and not muted (some
              headsets have a mute switch on the cable).
            </Callout>
          )}
          {gaveUp && (
            <Callout tone="warn" icon="microphoneWarning">
              <strong>We could not hear you clearly yet.</strong> Move the microphone closer and speak a
              little louder, or check that the right microphone is selected in your browser. Then click{" "}
              <strong>Start again</strong>. The facilitator can also help you.
            </Callout>
          )}
        </div>
      )}
    </Page>
  );
}
