import {
  type GameState,
  isOnboardingComplete,
  nextOnboardingStep,
  quotaLimit,
  quotaUsed,
  roundActiveMs,
  roundRemainingMs,
  seatList,
} from "@wkwa/shared";
import { useEffect, useState } from "react";
import { fmtDuration } from "../../common/format";
import { useStore } from "../../net/store";
import {
  Button,
  Callout,
  Check,
  Panel,
  Popup,
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
import { Timeline } from "../Timeline";

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/* ─────────────────────────── lifecycle (order of events) ─────────────────────────── */

function lifecycle(st: GameState): { steps: StepDef[]; current: number; done: (i: number) => boolean } {
  const steps: StepDef[] = [{ key: "onboarding", label: "Onboarding" }];
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
  st: GameState;
  onWrapUp: () => void;
}) {
  const now = useNow();
  const confirm = useConfirm();
  const run = (name: string, payload: unknown = {}, ok?: string) =>
    void conn.cmd(name, payload, ok).catch(() => {});
  const active = seatList(st).filter((s) => s.bound && !s.withdrawn);

  let prompt: React.ReactNode;
  let primary: React.ReactNode = null;
  let secondary: React.ReactNode = null;
  let action: (() => void) | null = null;

  if (st.phase === "onboarding") {
    const waiting = active.filter((s) => !isOnboardingComplete(st, s));
    const declined = waiting.filter((s) => s.consent === "declined");
    if (waiting.length === 0) {
      prompt = "Everyone is ready.";
      action = () => run("round:start", {}, "Round 1 started");
      primary = (
        <Button variant="primary" size="lg" icon="start" kbd="N" onClick={action}>
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
    action = () => run(st.paused ? "game:resume" : "game:pause", {}, st.paused ? "Resumed" : "Paused");
    primary = st.paused ? (
      <Button variant="primary" size="lg" icon="start" kbd="P" onClick={action}>
        Resume
      </Button>
    ) : (
      <Button size="lg" icon="pause" kbd="P" onClick={action}>
        Pause
      </Button>
    );
    secondary = (
      <Button
        icon="endRound"
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
            run("round:end", {}, "Round ended");
        }}
      >
        End round now
      </Button>
    );
  } else if (st.phase === "round_complete") {
    prompt = `Round ${st.round} complete.${st.config.roundAdvance === "auto" ? ` Round ${st.round + 1} starts automatically in ${st.config.autoAdvanceDelaySec} s.` : ""}`;
    action = () => run("round:start", {}, `Round ${st.round + 1} started`);
    primary = (
      <Button variant="primary" size="lg" icon="start" kbd="N" onClick={action}>
        Start round {st.round + 1} of {st.config.roundCount}
      </Button>
    );
  } else if (st.phase === "game_complete") {
    prompt = "Game complete. Players see their participant code. Wrap up: takedown cards → export → close.";
    action = onWrapUp;
    primary = (
      <Button variant="primary" size="lg" icon="next" kbd="N" onClick={onWrapUp}>
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
      run: () => run(st.paused ? "game:resume" : "game:pause", {}, st.paused ? "Resumed" : "Paused"),
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
  st: GameState;
  onLabels: () => void;
}) {
  const confirm = useConfirm();
  const [broadcast, setBroadcast] = useState("");
  const [note, setNote] = useState("");
  const [abortReason, setAbortReason] = useState("");
  const run = (name: string, payload: unknown = {}, ok?: string) =>
    conn.cmd(name, payload, ok).catch(() => {});
  const canLabels = st.phase === "onboarding" || st.phase === "round_complete";
  return (
    <Panel title="Tools" icon="setup">
      <div className="col">
        <form
          className="row nowrap"
          onSubmit={(e) => {
            e.preventDefault();
            if (broadcast.trim())
              void run("broadcast", { text: broadcast.trim() }, "Message sent").then(() => setBroadcast(""));
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
          <Button type="submit" icon="broadcast" disabled={!broadcast.trim()}>
            Broadcast
          </Button>
        </form>
        <form
          className="row nowrap"
          onSubmit={(e) => {
            e.preventDefault();
            if (note.trim()) void run("note", { text: note.trim() }, "Note added").then(() => setNote(""));
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
          <Button type="submit" icon="notes" disabled={!note.trim()}>
            Add note
          </Button>
        </form>
        <div className="row">
          <Button
            icon="labels"
            disabled={!canLabels}
            onClick={onLabels}
            title="Possible during onboarding and between rounds"
          >
            Edit labels
          </Button>
          <span className="spacer" />
          {["onboarding", "round_active", "round_complete"].includes(st.phase) && (
            <Button
              variant="danger"
              icon="stop"
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
                  void run("game:end", {}, "Game ended");
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
                  void run("session:abort", { reason: abortReason }, "Session aborted");
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

function WrapUp({ conn, st, onClose }: { conn: FacilitatorConnection; st: GameState; onClose: () => void }) {
  const [step, setStep] = useState(0);
  const [cardsDone, setCardsDone] = useState(false);
  const [exported, setExported] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const id = st.sessionId!;
  const doExport = async () => {
    setBusy(true);
    const r = await conn
      .api<{ dir: string }>(`/api/sessions/${id}/export`, { method: "POST" })
      .catch(() => null);
    setBusy(false);
    if (r) {
      setExported(r.dir);
      conn.toast("Standard export written");
    }
  };
  const canNext = step === 0 ? cardsDone : step === 1 ? Boolean(exported) : true;
  const next = () => {
    if (!canNext) return;
    if (step < 2) setStep(step + 1);
    else void conn.cmd("session:close", {}, "Session closed").then(onClose, () => {});
  };
  return (
    <Popup
      title={WRAP_STEPS[step]!.label}
      icon={step === 0 ? "cards" : step === 1 ? "export" : "archive"}
      step={{ index: step, total: 3 }}
      stepper={
        <Stepper steps={WRAP_STEPS} current={step} completed={(i) => i < step} onSelect={(i) => setStep(i)} />
      }
      onClose={onClose}
      onPrimary={canNext && !busy ? next : undefined}
      footer={
        <>
          <Button icon="back" disabled={step === 0} onClick={() => setStep(step - 1)}>
            Back
          </Button>
          <span className="spacer" />
          <Button
            variant="primary"
            icon={step === 2 ? "archive" : "next"}
            kbd="Enter"
            disabled={!canNext || busy}
            onClick={next}
          >
            {step === 2 ? "Close session" : "Next"}
          </Button>
        </>
      }
    >
      {step === 0 && (
        <div className="col">
          <p>
            Each player's screen now shows their participant code. Hand every participant the takedown card of
            their seat.
          </p>
          <div className="row">
            <Button
              variant="primary"
              icon="print"
              onClick={() => void conn.openPrintable(`/api/sessions/${id}/print/cards`).catch(() => {})}
            >
              Print takedown cards
            </Button>
          </div>
          <Check label="Cards are handed out." checked={cardsDone} onChange={setCardsDone} />
        </div>
      )}
      {step === 1 && (
        <div className="col">
          <p>Write the standard (pseudonymised) export of this session for analysis.</p>
          <div className="row">
            <Button variant="primary" icon="export" disabled={busy} onClick={() => void doExport()}>
              Export session
            </Button>
          </div>
          {exported && (
            <Callout tone="live" icon="ok">
              Written to <code>{exported}</code>. Move it to institutional storage and delete the local copy.
            </Callout>
          )}
        </div>
      )}
      {step === 2 && (
        <div className="col">
          <p>
            Closing archives the session: no further events except erasure markers. Players keep their end
            screen until the next session.
          </p>
          <Callout icon="keysheet">Lock the key sheet away, separate from the data.</Callout>
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
  if (!dash || !st) return null;
  const regionName = (id: string) => scenario?.regions.find((r) => r.id === id)?.name ?? id;
  const confirmRevoke = async (seq: number) => {
    const a = st.actions.find((x) => x.seq === seq);
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
      void conn
        .cmd("action:revoke", { seq, reason: "facilitator" }, `Action #${seq} revoked`)
        .catch(() => {});
  };
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
              <Button icon="close" kbd="Esc" onClick={() => setLabels(false)}>
                Done
              </Button>
            </>
          }
        >
          <Callout tone="warn" icon="warning">
            Changing labels mid-session is logged (<code>LabelsAssigned</code>) and changes what players see
            from now on.
          </Callout>
          <LabelsEditor conn={conn} st={st} scenario={scenario} onSaved={() => setLabels(false)} />
        </Popup>
      )}
    </div>
  );
}
