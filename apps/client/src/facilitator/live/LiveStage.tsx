import {
  calibrationNotReadySeats,
  calibrationWaitingSeats,
  canStartFirstRound,
  fakeSeats,
  hasParticipants,
  isOnboardingComplete,
  isSimulated,
  nextOnboardingStep,
  pairingName,
  pairingText,
  quotaLimit,
  quotaUsed,
  type ReadonlyGameState,
  roundActiveMs,
  roundRemainingMs,
  seatList,
} from "@wkwa/shared";
import { useCallback, useEffect, useState } from "react";
import { fmtDuration } from "../../common/format";
import { useStore } from "../../net/store";
import {
  Button,
  Callout,
  Check,
  Panel,
  Popup,
  SeatDot,
  StatusTag,
  type StepDef,
  Stepper,
  useConfirm,
  useShortcuts,
} from "../../ui";
import { CompositeMap, PlayerMirrors } from "../Composite";
import type { FacilitatorConnection } from "../connection";
import { EventLog, TelemetryFeed } from "../EventLog";
import { LabelsEditor, SeatsPanel } from "../seats";
import { paceText, policySummary } from "../simulation";
import { Timeline } from "../Timeline";
import { AudioNext } from "./AudioControls";
import { AudioCheckView, CalibrationCard, RecordingControl, useAudioCheck } from "./AudioPanels";

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/* ─────────────────────────── lifecycle (order of events) ─────────────────────────── */

function lifecycle(st: ReadonlyGameState): {
  steps: StepDef[];
  current: number;
  done: (i: number) => boolean;
} {
  const simulated = isSimulated(st);
  const steps: StepDef[] = [
    simulated ? { key: "onboarding", label: "Agents" } : { key: "onboarding", label: "Onboarding" },
  ];
  for (let r = 1; r <= st.config.roundCount; r++) steps.push({ key: `r${r}`, label: `Round ${r}` });
  steps.push({ key: "wrapup", label: "Wrap-up" });
  const last = steps.length - 1;
  let current = 0;
  if (st.phase === "round_active") current = st.round;
  else if (st.phase === "round_complete")
    current = st.round; // round shown ✓, next is upcoming
  else if (st.phase === "game_complete") current = last;
  const done = (i: number) => {
    if (i === 0) return st.round > 0 || st.phase === "game_complete";
    if (i === last) return false;
    const rec = st.rounds.find((x) => x.round === i);
    return Boolean(rec?.endedTs);
  };
  return { steps, current: st.phase === "round_complete" ? Math.min(st.round + 1, last) : current, done };
}

/* ─────────────────────────── NEXT panel ─────────────────────────── */

function NextPanel({
  conn,
  st,
  onWrapUp,
}: {
  conn: FacilitatorConnection;
  st: ReadonlyGameState;
  onWrapUp: () => void;
}) {
  const now = useNow();
  const confirm = useConfirm();
  const active = seatList(st).filter((s) => s.bound && !s.withdrawn);

  let prompt: React.ReactNode;
  let primary: React.ReactNode = null;
  let secondary: React.ReactNode = null;
  let action: (() => void) | null = null;

  // sessions that record audio: the calibration runs after the mic checks, before round 1; it
  // starts by itself once every recorded seat has said it is ready
  const calStatus = st.audio.calibration.status;
  const calWaiting =
    st.phase === "onboarding" &&
    !canStartFirstRound(st) &&
    calStatus === "pending" &&
    !st.audio.recordingPaused &&
    calibrationWaitingSeats(st).length === 0;
  const showAudio = st.audio.enabled && (st.phase === "onboarding" || st.phase === "round_complete");

  if (st.phase === "onboarding") {
    const waiting = active.filter((s) => !isOnboardingComplete(st, s));
    const declined = waiting.filter((s) => s.consent === "declined");
    if (calWaiting) {
      const notReady = calibrationNotReadySeats(st);
      prompt = notReady.length
        ? `Every mic check is done. Waiting for seat ${notReady.join(", ")} to say they are ready for the calibration; it then starts by itself.`
        : "Everyone is ready: the calibration is starting.";
    } else if (waiting.length === 0 && calStatus === "running") {
      prompt = "Calibration running: each seat reads its sentence in turn. Keep the room quiet.";
    } else if (waiting.length === 0 && !canStartFirstRound(st)) {
      // round 1 waits for the calibration, which cannot run while recording is paused
      prompt = "Everyone is ready. Resume recording, then run the calibration (or skip it).";
    } else if (waiting.length === 0) {
      prompt = "Everyone is ready.";
      action = () => conn.run("round:start", {}, "Round 1 started");
      primary = (
        <Button
          variant="primary"
          size="lg"
          icon="start"
          kbd="N"
          onClick={action}
          tip="Start the first round: players can act until their quotas are used or you end the round"
        >
          Start round 1 of {st.config.roundCount}
        </Button>
      );
    } else {
      prompt = `Waiting for onboarding: ${waiting.map((s) => `seat ${s.seat} (${s.consent === "declined" ? "DECLINED" : nextOnboardingStep(st, s)})`).join(", ")}`;
      if (declined.length) {
        secondary = (
          <Callout tone="danger" icon="warning">
            Seat {declined.map((s) => s.seat).join(", ")} declined consent. Withdraw the seat in the Seats
            panel to continue with fewer players, or abort and set up a new session.
          </Callout>
        );
      }
    }
  } else if (st.phase === "round_active") {
    const total = active.reduce(
      (n, s) => n + quotaUsed(st, s.seat, "propose") + quotaUsed(st, s.seat, "decide"),
      0,
    );
    const pl = quotaLimit(st, "propose");
    const dl = quotaLimit(st, "decide");
    const max = pl === null || dl === null ? null : active.length * (pl + dl);
    const left = roundRemainingMs(st, now);
    prompt = st.paused
      ? `Round ${st.round} paused${st.pauseReason === "disconnect" ? " — a player disconnected" : ""}.`
      : `Round ${st.round} of ${st.config.roundCount} in progress · ${total}${max !== null ? `/${max}` : ""} actions · ${fmtDuration(roundActiveMs(st, now))}${left !== null ? ` · ${fmtDuration(left)} left` : ""}`;
    action = () => conn.run(st.paused ? "game:resume" : "game:pause", {}, st.paused ? "Resumed" : "Paused");
    primary = st.paused ? (
      <Button
        variant="primary"
        size="lg"
        icon="start"
        kbd="P"
        onClick={action}
        tip="Let players act again; the round clock carries on"
      >
        Resume
      </Button>
    ) : (
      <Button
        size="lg"
        icon="pause"
        kbd="P"
        onClick={action}
        tip="Freeze the game: players cannot act and the round clock stops"
      >
        Pause
      </Button>
    );
    secondary = (
      <Button
        icon="endRound"
        tip="End this round now, even if players still have actions left"
        onClick={async () => {
          if (
            await confirm({
              title: `End round ${st.round} now?`,
              message: "The round ends immediately, even if players still have actions left.",
              confirmLabel: "End round",
              danger: true,
              icon: "endRound",
            })
          )
            conn.run("round:end", {}, "Round ended");
        }}
      >
        End round now
      </Button>
    );
  } else if (st.phase === "round_complete" && calStatus === "running") {
    prompt = `Round ${st.round} complete. Calibration running again: keep the room quiet.`;
  } else if (st.phase === "round_complete") {
    prompt = `Round ${st.round} complete.${st.config.roundAdvance === "auto" ? ` Round ${st.round + 1} starts automatically in ${st.config.autoAdvanceDelaySec} s.` : ""}`;
    action = () => conn.run("round:start", {}, `Round ${st.round + 1} started`);
    primary = (
      <Button
        variant="primary"
        size="lg"
        icon="start"
        kbd="N"
        onClick={action}
        tip="Start the next round with fresh quotas; scores carry over"
      >
        Start round {st.round + 1} of {st.config.roundCount}
      </Button>
    );
  } else if (st.phase === "game_complete") {
    prompt = isSimulated(st)
      ? "Simulation complete. Wrap up: export → close."
      : hasParticipants(st)
        ? "Game complete. Players see their participant code. Wrap up: takedown cards → export → close."
        : "Game complete (fake players only). Wrap up: export → close.";
    action = onWrapUp;
    primary = (
      <Button
        variant="primary"
        size="lg"
        icon="next"
        kbd="N"
        onClick={onWrapUp}
        tip="Go to wrap-up: payout cards, export and close"
      >
        Wrap up session
      </Button>
    );
  }

  useShortcuts([
    {
      key: "n",
      label: "next",
      run: () => action?.(),
      enabled: () => Boolean(action) && st.phase !== "round_active",
    },
    {
      key: "p",
      label: "pause/resume",
      run: () => action?.(),
      enabled: () => st.phase === "round_active",
    },
  ]);

  return (
    <Panel title="Next" icon="next">
      <div className="col">
        <div className="next-action">
          <span className="prompt">{prompt}</span>
          <span className="spacer" />
          {primary}
        </div>
        {secondary && <div className="row">{secondary}</div>}
        {showAudio && <AudioNext conn={conn} st={st} />}
      </div>
    </Panel>
  );
}

/* ─────────────────────────── tools ─────────────────────────── */

function ToolsPanel({
  conn,
  st,
  onLabels,
}: {
  conn: FacilitatorConnection;
  st: ReadonlyGameState;
  onLabels: () => void;
}) {
  const confirm = useConfirm();
  const [broadcast, setBroadcast] = useState("");
  const [note, setNote] = useState("");
  const [abortReason, setAbortReason] = useState("");
  const canLabels = st.phase === "onboarding" || st.phase === "round_complete";
  return (
    <Panel title="Tools" icon="setup">
      <div className="col">
        <form
          className="row nowrap"
          onSubmit={(e) => {
            e.preventDefault();
            if (broadcast.trim())
              void conn.cmd("broadcast", { text: broadcast.trim() }, "Message sent").then(
                () => setBroadcast(""),
                () => {},
              );
          }}
        >
          <input
            type="text"
            aria-label="Message to all players"
            value={broadcast}
            maxLength={300}
            onChange={(e) => setBroadcast(e.target.value)}
            placeholder="Message to all players…"
            style={{ flex: 1 }}
          />
          <Button
            type="submit"
            icon="broadcast"
            disabled={!broadcast.trim()}
            tip="Show this message on every player's screen (it is also logged)"
          >
            Broadcast
          </Button>
        </form>
        <form
          className="row nowrap"
          onSubmit={(e) => {
            e.preventDefault();
            if (note.trim())
              void conn.cmd("note", { text: note.trim() }, "Note added").then(
                () => setNote(""),
                () => {},
              );
          }}
        >
          <input
            type="text"
            aria-label="Facilitator note"
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note for the log — never type names"
            style={{ flex: 1 }}
          />
          <Button
            type="submit"
            icon="notes"
            disabled={!note.trim()}
            tip="Add a timestamped facilitator note to the event log; it is exported, so never type names"
          >
            Add note
          </Button>
        </form>
        <RecordingControl conn={conn} st={st} />
        <div className="row">
          <Button
            icon="labels"
            disabled={!canLabels}
            onClick={onLabels}
            tip="Change seat labels and pairing; possible during onboarding and between rounds"
          >
            Edit labels
          </Button>
          <span className="spacer" />
          {["onboarding", "round_active", "round_complete"].includes(st.phase) && (
            <Button
              variant="danger"
              icon="stop"
              tip="End the current round and mark the game complete; actions so far are kept"
              onClick={async () => {
                if (
                  await confirm({
                    title: "End the game early?",
                    message:
                      "The current round ends and the game is marked complete. Players see their end screen.",
                    confirmLabel: "End game",
                    danger: true,
                    icon: "stop",
                  })
                )
                  conn.run("game:end", {}, "Game ended");
              }}
            >
              End game early
            </Button>
          )}
        </div>
        <details>
          <summary className="small upper muted">Abort session…</summary>
          <div className="row nowrap" style={{ marginTop: 6 }}>
            <input
              type="text"
              aria-label="Abort reason"
              value={abortReason}
              maxLength={200}
              onChange={(e) => setAbortReason(e.target.value)}
              placeholder="Reason (no names)"
              style={{ flex: 1 }}
            />
            <Button
              variant="danger"
              icon="stop"
              tip="Mark the session aborted (data is kept); players see their end screen"
              onClick={async () => {
                if (
                  await confirm({
                    title: "Abort the session?",
                    message:
                      "The session is marked aborted. Its data is kept; players see the end screen with their code.",
                    confirmLabel: "Abort session",
                    danger: true,
                    icon: "stop",
                  })
                )
                  conn.run("session:abort", { reason: abortReason }, "Session aborted");
              }}
            >
              Abort
            </Button>
          </div>
        </details>
      </div>
    </Panel>
  );
}

/* ─────────────────────────── wrap-up (3 popups) ─────────────────────────── */

const WRAP_STEPS: StepDef[] = [
  { key: "cards", label: "Takedown cards" },
  { key: "export", label: "Export" },
  { key: "close", label: "Close" },
];

function WrapUp({
  conn,
  st,
  onClose,
}: {
  conn: FacilitatorConnection;
  st: ReadonlyGameState;
  onClose: () => void;
}) {
  const simulated = isSimulated(st);
  // no participants (agents or fake players only): no takedown cards
  const steps = hasParticipants(st) ? WRAP_STEPS : WRAP_STEPS.filter((s) => s.key !== "cards");
  const [step, setStep] = useState(0);
  const [cardsDone, setCardsDone] = useState(false);
  const [exported, setExported] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = st.sessionId!;
  const key = steps[step]!.key;
  const last = steps.length - 1;
  const audio = useAudioCheck(conn, st);
  const uploading = audio?.lines.some((l) => l.kind === "upload") ?? false;
  const doExport = async () => {
    setBusy(true);
    const r = await conn
      .api<{ dir: string }>(`/api/sessions/${id}/export`, { method: "POST" })
      .catch(() => null);
    setBusy(false);
    if (r) {
      setExported(r.dir);
      conn.toast(simulated ? "Simulation export written" : "Standard export written");
    }
  };
  const canNext = key === "cards" ? cardsDone : key === "export" ? Boolean(exported) : true;
  const next = () => {
    if (!canNext) return;
    if (step < last) setStep(step + 1);
    else void conn.cmd("session:close", {}, "Session closed").then(onClose, () => {});
  };
  return (
    <Popup
      title={steps[step]!.label}
      icon={key === "cards" ? "cards" : key === "export" ? "export" : "archive"}
      step={{ index: step, total: steps.length }}
      stepper={
        <Stepper steps={steps} current={step} completed={(i) => i < step} onSelect={(i) => setStep(i)} />
      }
      onClose={onClose}
      onPrimary={canNext && !busy ? next : undefined}
      footer={
        <>
          <Button
            icon="back"
            disabled={step === 0}
            onClick={() => setStep(step - 1)}
            tip="Previous wrap-up step"
          >
            Back
          </Button>
          <span className="spacer" />
          <Button
            variant="primary"
            icon={key === "close" ? "archive" : "next"}
            kbd="Enter"
            disabled={!canNext || busy}
            onClick={next}
            tip={
              key === "close"
                ? `Archive the session: no further events; it can still be replayed and exported${uploading ? ". Audio is still uploading: what has not arrived is lost" : ""}`
                : "Next wrap-up step"
            }
          >
            {key === "close" ? (uploading ? "Close anyway" : "Close session") : "Next"}
          </Button>
        </>
      }
    >
      {audio && <AudioCheckView check={audio} />}
      {key === "cards" && (
        <div className="col">
          <p>
            Each player's screen now shows their participant code. Hand every participant the takedown card of
            their seat.
          </p>
          <div className="col" style={{ gap: 4 }}>
            {seatList(st)
              .filter((x) => x.participantCode)
              .map((x) => (
                <div key={x.seat} className="row">
                  <SeatDot seat={x.seat} />
                  <strong>SEAT {x.seat}</strong>
                  <span className="spacer" />
                  <Button
                    size="sm"
                    icon="export"
                    tip={`Download takedown-card-${id}-seat${x.seat}.pdf (A6) to print`}
                    onClick={() =>
                      void conn
                        .download(
                          `/api/sessions/${id}/cards/${x.seat}`,
                          `takedown-card-${id}-seat${x.seat}.pdf`,
                        )
                        .catch(() => {})
                    }
                  >
                    Card PDF
                  </Button>
                </div>
              ))}
          </div>
          <p className="hint">
            One PDF per participant; delete the downloaded files after printing (they contain the codes).
          </p>
          <Check label="Cards are handed out." checked={cardsDone} onChange={setCardsDone} />
        </div>
      )}
      {key === "export" && (
        <div className="col">
          <p>
            {simulated
              ? "Write the export of this simulation (no personal data) to exports/simulations/."
              : "Write the standard (pseudonymised) export of this session for analysis."}
          </p>
          <div className="row">
            <Button
              variant="primary"
              icon="export"
              disabled={busy}
              onClick={() => void doExport()}
              tip="Write this session's CSV and JSON export files to the exports folder"
            >
              Export session
            </Button>
          </div>
          {exported && (
            <Callout tone="live" icon="ok">
              Written to <code>{exported}</code>.
              {simulated ? "" : " Move it to institutional storage and delete the local copy."}
            </Callout>
          )}
        </div>
      )}
      {key === "close" && (
        <div className="col">
          {simulated ? (
            <p>
              Closing archives the simulation. It stays in the simulation database (DATABASE → Simulations).
            </p>
          ) : (
            <>
              <p>
                Closing archives the session: no further events except erasure markers. Players keep their end
                screen until the next session.
              </p>
              <Callout icon="keysheet">Lock the key sheet away, separate from the data.</Callout>
            </>
          )}
        </div>
      )}
    </Popup>
  );
}

/* ─────────────────────────── stage ─────────────────────────── */

export function LiveStage({ conn }: { conn: FacilitatorConnection }) {
  const fs = useStore(conn.store);
  const now = useNow();
  const [wrapUp, setWrapUp] = useState(false);
  const [labels, setLabels] = useState(false);
  const confirm = useConfirm();
  const dash = fs.dashboard;
  const st = dash?.state;
  const scenario = fs.scenario;
  // stable between the 1 s ticks, so the memoised event log does not re-render on each one
  const regionName = useCallback(
    (id: string) => scenario?.regions.find((r) => r.id === id)?.name ?? id,
    [scenario],
  );
  const confirmRevoke = useCallback(
    async (seq: number) => {
      const a = st?.actions.find((x) => x.seq === seq);
      if (
        await confirm({
          title: `Revoke action #${seq}?`,
          message: a
            ? `Seat ${a.seat}'s ${a.kind} on ${regionName(a.regionId)} disappears for everyone and the seat gets its quota back. The original event stays in the log.`
            : "The action disappears for everyone; the original event stays in the log.",
          confirmLabel: "Revoke",
          icon: "revoke",
        })
      )
        conn.run("action:revoke", { seq, reason: "facilitator" }, `Action #${seq} revoked`);
    },
    [st, confirm, conn, regionName],
  );
  if (!dash || !st) return null;
  const seats = seatList(st)
    .filter((s) => s.bound || s.withdrawn)
    .map((s) => s.seat);
  const lc = lifecycle(st);

  return (
    <div className="col" style={{ gap: "var(--s3)" }}>
      <Panel title="Session" icon="live">
        <div className="row">
          <Stepper steps={lc.steps} current={lc.current} completed={lc.done} />
          <span className="spacer" />
          {st.paused && (
            <StatusTag tone="warn" icon="pause">
              paused
            </StatusTag>
          )}
          {isSimulated(st) && (
            <StatusTag
              icon="simulation"
              title={`Agents: ${policySummary(st.config.simulation, st.config.seatCount)} · pause ${paceText(st.config.simulation)} · seed ${st.config.simulation.seed}`}
            >
              simulation · {policySummary(st.config.simulation, st.config.seatCount)} · seed{" "}
              {st.config.simulation.seed}
            </StatusTag>
          )}
          {fakeSeats(st).length > 0 && (
            <StatusTag
              icon="fake"
              title="Fake players: test clients the server created (no participant, no code, no onboarding)"
            >
              fake players · seat {fakeSeats(st).join(", ")}
            </StatusTag>
          )}
          {st.labelPairing && (
            <StatusTag icon="labels" title={pairingText(st.labelPairing)}>
              pairing {pairingName(st.labelPairing)}
            </StatusTag>
          )}
          {st.config.tags.map((t) => (
            <StatusTag key={t} icon="tag">
              {t}
            </StatusTag>
          ))}
        </div>
      </Panel>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 3fr) minmax(320px, 2fr)",
          gap: "var(--s3)",
          alignItems: "start",
        }}
      >
        <NextPanel conn={conn} st={st} onWrapUp={() => setWrapUp(true)} />
        <ToolsPanel conn={conn} st={st} onLabels={() => setLabels(true)} />
      </div>
      <CalibrationCard st={st} />
      <SeatsPanel conn={conn} dash={dash} scenario={scenario} />
      {scenario && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 3fr) minmax(0, 2fr)",
            gap: "var(--s3)",
            alignItems: "start",
          }}
        >
          <CompositeMap scenario={scenario} state={st} presence={fs.presence} onRevoke={confirmRevoke} />
          <PlayerMirrors scenario={scenario} state={st} presence={fs.presence} now={now} />
        </div>
      )}
      <Timeline events={fs.events} seats={seats} now={now} />
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 3fr) minmax(0, 2fr)",
          gap: "var(--s3)",
          alignItems: "start",
        }}
      >
        <EventLog events={fs.events} state={st} regionName={regionName} onRevoke={confirmRevoke} />
        <TelemetryFeed items={fs.telemetry} regionName={regionName} />
      </div>
      {wrapUp && st.phase === "game_complete" && (
        <WrapUp conn={conn} st={st} onClose={() => setWrapUp(false)} />
      )}
      {labels && (
        <Popup
          title="Edit labels"
          icon="labels"
          width={820}
          onClose={() => setLabels(false)}
          footer={
            <>
              <span className="spacer" />
              <Button icon="close" kbd="Esc" onClick={() => setLabels(false)} tip="Close the label editor">
                Done
              </Button>
            </>
          }
        >
          <Callout tone="warn" icon="warning">
            Each change of the pairing is saved at once, logged (<code>LabelsAssigned</code>) and changes what
            players see from now on.
          </Callout>
          <LabelsEditor conn={conn} st={st} scenario={scenario} />
        </Popup>
      )}
    </div>
  );
}
