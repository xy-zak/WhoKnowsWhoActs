import type { PlayerView } from "@wkwa/shared";
import type { ReactNode } from "react";
import type { MicErrorInfo } from "../audio";
import { useStore } from "../net/store";
import { Button, RecordingBanner, RecTag } from "../ui";
import type { PlayerConnection } from "./connection";
import { needsClick, type RecordingSnapshot, recStateFor } from "./recording";

/*
 * The player's recording indicator (docs/AESTHETIC-RULES.md § 8.1): calm, static, never a red
 * REC dot. RecordingLine is the slim line on the onboarding screens; RecordingTag sits in the
 * game's status line; RecordingProblem is the game's non-blocking banner when the microphone
 * needs the participant (blocked, unplugged, silent, or the browser waits for a click).
 */

export function useRecording(conn: PlayerConnection): RecordingSnapshot {
  return useStore(conn.recording.store);
}

/** The steps a participant can take to fix a microphone problem, as a short numbered list. */
export function MicFixSteps({ error }: { error: MicErrorInfo }) {
  return (
    <ol className="small" style={{ margin: "var(--s1) 0 0", paddingLeft: "1.4em", textAlign: "left" }}>
      {error.steps.map((s) => (
        <li key={s}>{s}</li>
      ))}
    </ol>
  );
}

/** The message and the fix of a problem state, or null when the recording needs nothing. */
function problem(conn: PlayerConnection, view: PlayerView, snap: RecordingSnapshot): ReactNode | null {
  if (needsClick(view, snap)) {
    return (
      <span className="row" style={{ gap: "var(--s2)" }}>
        <span>Recording is waiting for you: your browser needs a click to use the microphone again.</span>
        <Button
          size="sm"
          icon="microphone"
          onClick={() => conn.recording.fixFromClick()}
          tip="Let the browser use the microphone again (recording carries on)"
        >
          Resume recording
        </Button>
      </span>
    );
  }
  const st = snap.status.state;
  if ((st === "denied" || st === "error") && view.audio.record) {
    const e = snap.status.error;
    return (
      <span className="col" style={{ gap: "var(--s1)" }}>
        <span className="row" style={{ gap: "var(--s2)" }}>
          <strong>{e?.title ?? "The microphone stopped working"}.</strong>
          <span>The game goes on; please fix it when you can, or ask the facilitator.</span>
          <Button
            size="sm"
            icon="refresh"
            onClick={() => conn.recording.fixFromClick()}
            tip="Ask the browser for the microphone again"
          >
            Try again
          </Button>
        </span>
        {e && <MicFixSteps error={e} />}
      </span>
    );
  }
  return null;
}

/** Onboarding chrome: `[REC] Your microphone is being recorded`, or what to do when it is not. */
export function RecordingLine({ conn, view }: { conn: PlayerConnection; view: PlayerView }) {
  const snap = useRecording(conn);
  const state = recStateFor(view, snap);
  if (!state) return null;
  return <RecordingBanner state={state}>{problem(conn, view, snap)}</RecordingBanner>;
}

/** Game status line: the recording state as a tag. */
export function RecordingTag({ conn, view }: { conn: PlayerConnection; view: PlayerView }) {
  const snap = useRecording(conn);
  const state = recStateFor(view, snap);
  if (!state) return null;
  const tip =
    state === "recording"
      ? "Your microphone is being recorded until the end of the game. The facilitator can pause it for everyone"
      : state === "paused" && !view.audio.paused
        ? "Recording is waiting for a click: use Resume recording above the map"
        : undefined;
  return <RecTag state={state} tip={tip} />;
}

/** Game: a non-blocking banner with the fix, only while the microphone needs the participant. */
export function RecordingProblem({ conn, view }: { conn: PlayerConnection; view: PlayerView }) {
  const snap = useRecording(conn);
  const state = recStateFor(view, snap);
  if (!state) return null;
  const fix = problem(conn, view, snap);
  if (fix) return <RecordingBanner state={state}>{fix}</RecordingBanner>;
  if (state === "no_signal") return <RecordingBanner state="no_signal" />;
  return null;
}
