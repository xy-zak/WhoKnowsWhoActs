import { normaliseTags, type SessionConfig, seatList } from "@wkwa/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useStore } from "../../net/store";
import {
  Button,
  Callout,
  Check,
  Icon,
  type IconName,
  Panel,
  Popup,
  StatusTag,
  type StepDef,
  Stepper,
  useConfirm,
  useShortcuts,
} from "../../ui";
import type { FacilitatorConnection } from "../connection";
import { BindEditor, LabelsEditor, labelsComplete, SeatsPanel } from "../seats";
import { inLobby } from "../stage";
import {
  OnboardingStep,
  PlayersStep,
  ReviewStep,
  RoundsStep,
  type ScenarioInfo,
  ScenarioStep,
  TagsStep,
} from "./ConfigSteps";
import {
  clearDraft,
  type Draft,
  emptyDraft,
  finalConfig,
  keySheetConfirmed,
  loadDraft,
  saveDraft,
  setKeySheetConfirmed,
} from "./draft";

/** The ten setup steps. 01–06 configure (no session yet); 07–10 prepare the created session (lobby). */
export const SETUP_STEPS: Array<StepDef & { icon: IconName; title: string }> = [
  { key: "scenario", label: "Scenario", title: "Choose the scenario", icon: "scenario" },
  { key: "rounds", label: "Rounds", title: "Rounds", icon: "rounds" },
  { key: "players", label: "Players", title: "Players & visibility", icon: "visibility" },
  { key: "onboarding", label: "Onboarding", title: "Onboarding", icon: "onboarding" },
  { key: "tags", label: "Tags", title: "Tags & notes", icon: "tag" },
  { key: "review", label: "Review", title: "Review & create", icon: "review" },
  { key: "connect", label: "Connect", title: "Connect & bind terminals", icon: "terminal" },
  { key: "labels", label: "Labels", title: "Assign labels", icon: "labels" },
  { key: "keysheet", label: "Key sheet", title: "Print the key sheet", icon: "keysheet" },
  { key: "start", label: "Start", title: "Start onboarding", icon: "start" },
];
const LAST_CONFIG = 5;

export function SetupStage({ conn }: { conn: FacilitatorConnection }) {
  const fs = useStore(conn.store);
  const confirm = useConfirm();
  const dash = fs.dashboard;
  const st = dash?.state ?? null;
  const lobby = inLobby(st);
  const sessionId = lobby ? st!.sessionId! : null;

  const [scenarios, setScenarios] = useState<ScenarioInfo[]>([]);
  const [draft, setDraftState] = useState<Draft | null>(loadDraft);
  const [step, setStep] = useState<number>(() => (lobby ? 6 : (loadDraft()?.reached ?? 0)));
  // auto-open the wizard, except right after a session ended (the facilitator may want DATABASE first)
  const [open, setOpen] = useState(() => !(st && ["closed", "aborted"].includes(st.phase)));
  const [busy, setBusy] = useState(false);
  const [keySheet, setKeySheet] = useState(false);
  const [urls, setUrls] = useState<Array<{ url: string; iface: string }>>([]);

  useEffect(() => {
    conn.api<ScenarioInfo[]>("/api/scenarios").then(setScenarios, () => {});
    conn.api<{ playerUrls: Array<{ url: string; iface: string }> }>("/api/server-info").then(
      (r) => setUrls(r.playerUrls),
      () => {},
    );
    if (!loadDraft()) {
      conn.api<SessionConfig>("/api/config/session-defaults").then(
        (def) => setDraftState((cur) => cur ?? emptyDraft(def)),
        () => setDraftState((cur) => cur ?? emptyDraft()),
      );
    }
  }, [conn]);
  // first usable scenario as default
  useEffect(() => {
    if (draft && !draft.scenarioId && scenarios.length) {
      const first = scenarios.find((s) => !s.error);
      if (first) upd({ scenarioId: first.id });
    }
  });
  useEffect(() => {
    if (sessionId) setKeySheet(keySheetConfirmed(sessionId));
  }, [sessionId]);

  const upd = useCallback((patch: Partial<Draft>) => {
    setDraftState((cur) => {
      const next = { ...(cur ?? emptyDraft()), ...patch };
      saveDraft(next);
      return next;
    });
  }, []);

  /* derived step state */
  const allBound = lobby && seatList(st!).every((s) => s.bound);
  const labelled = lobby && labelsComplete(st!);
  const done = (i: number): boolean => {
    if (i <= LAST_CONFIG) return lobby || i < (draft?.reached ?? 0);
    if (!lobby) return false;
    if (i === 6) return allBound;
    if (i === 7) return labelled;
    if (i === 8) return keySheet;
    return false;
  };
  const firstOpenLobbyStep = !allBound ? 6 : !labelled ? 7 : !keySheet ? 8 : 9;
  // when a session appears (created or resumed) jump to the lobby steps
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the attached lobby session changes
  useEffect(() => {
    if (lobby) setStep((s) => (s <= LAST_CONFIG ? firstOpenLobbyStep : s));
    else setStep((s) => (s > LAST_CONFIG ? (draft?.reached ?? 0) : s));
  }, [sessionId]);

  const final = useMemo(() => (draft ? finalConfig(draft) : { error: "loading" }), [draft]);
  const canNext = (i: number): boolean => {
    if (!draft && i <= LAST_CONFIG) return false;
    switch (i) {
      case 0:
        return Boolean(draft?.scenarioId);
      case 1:
      case 2:
      case 3:
      case 4:
        return true;
      case 5:
        return "config" in final;
      case 6:
        return allBound;
      case 7:
        return labelled;
      case 8:
        return keySheet;
      default:
        return true;
    }
  };

  const goTo = (i: number) => {
    setStep(i);
    setOpen(true);
    if (draft && i <= LAST_CONFIG && i > draft.reached) upd({ reached: i });
  };

  const create = async () => {
    if (!draft || !("config" in final)) return;
    setBusy(true);
    try {
      await conn.cmd(
        "session:create",
        { scenarioId: draft.scenarioId, config: final.config, notes: draft.notes },
        "Session created",
      );
      clearDraft();
      setDraftState(emptyDraft(final.config));
      setStep(6);
    } catch {
    } finally {
      setBusy(false);
    }
  };

  const startOnboarding = async () => {
    setBusy(true);
    try {
      await conn.cmd("onboarding:start", {}, "Onboarding started — now LIVE");
    } catch {
    } finally {
      setBusy(false);
    }
  };

  const next = () => {
    if (!canNext(step)) return;
    if (step === LAST_CONFIG) return void create();
    if (step === 9) return void startOnboarding();
    goTo(step + 1);
  };
  const back = () => {
    const minStep = lobby ? 6 : 0;
    if (step > minStep) goTo(step - 1);
  };

  const discard = async () => {
    if (
      await confirm({
        title: "Discard this session?",
        message:
          "The session is marked as aborted (its few setup events are kept). You can then configure a new one.",
        confirmLabel: "Discard",
        danger: true,
        icon: "stop",
      })
    ) {
      void conn
        .cmd("session:abort", { reason: "discarded during setup" }, "Session discarded")
        .catch(() => {});
    }
  };

  useShortcuts([{ key: "n", label: "resume setup", run: () => setOpen(true) }]);

  const def = SETUP_STEPS[step]!;
  const stepper = (
    <Stepper
      steps={SETUP_STEPS}
      current={step}
      completed={done}
      locked={(i) => lobby && i <= LAST_CONFIG}
      onSelect={(i) => goTo(i)}
    />
  );

  /* ─── step bodies ─── */
  const body = (() => {
    if (step <= LAST_CONFIG && !draft) return <span className="muted">Loading defaults…</span>;
    const d = draft!;
    switch (step) {
      case 0:
        return <ScenarioStep conn={conn} d={d} upd={upd} scenarios={scenarios} />;
      case 1:
        return <RoundsStep d={d} upd={upd} />;
      case 2:
        return <PlayersStep d={d} upd={upd} />;
      case 3:
        return <OnboardingStep d={d} upd={upd} />;
      case 4:
        return <TagsStep d={d} upd={upd} />;
      case 5:
        return (
          <ReviewStep
            d={d}
            scenarios={scenarios}
            config={"config" in final ? final.config : null}
            error={"error" in final ? final.error : null}
            goTo={goTo}
          />
        );
      case 6:
        return dash && lobby ? (
          <div className="col">
            <Callout icon="terminal">
              On each player PC, open{" "}
              {urls.length ? (
                urls.map((u, i) => (
                  <span key={u.url}>
                    {i > 0 && " or "}
                    <strong className="mono">{u.url}</strong> <span className="faint">({u.iface})</span>
                  </span>
                ))
              ) : (
                <strong>the player URL printed when the server started</strong>
              )}{" "}
              in full-screen (F11). Then bind each terminal to a seat.
            </Callout>
            <BindEditor conn={conn} dash={dash} />
          </div>
        ) : null;
      case 7:
        return lobby ? <LabelsEditor conn={conn} st={st!} scenario={fs.scenario} /> : null;
      case 8:
        return lobby ? (
          <div className="col">
            <p>
              The <strong>key sheet</strong> is the only place where a participant code meets a name, and the
              name is written <strong>by hand</strong>. Print it now, fill in names as participants arrive,
              and store it separately from all data.
            </p>
            <div className="row">
              <Button
                icon="print"
                variant="primary"
                onClick={() =>
                  void conn.openPrintable(`/api/sessions/${sessionId}/print/keysheet`).catch(() => {})
                }
              >
                Print key sheet
              </Button>
              <span className="hint">Opens a printable page. Don't save it as a file.</span>
            </div>
            <Check
              label="The key sheet is printed and will be stored separately (e.g. a locked drawer)."
              checked={keySheet}
              onChange={(v) => {
                setKeySheet(v);
                if (sessionId) setKeySheetConfirmed(sessionId, v);
              }}
            />
          </div>
        ) : null;
      case 9:
        return lobby ? (
          <div className="col">
            <table className="grid">
              <tbody>
                {(
                  [
                    ["Session created", true, sessionId],
                    [
                      "All seats bound",
                      allBound,
                      `${seatList(st!).filter((s) => s.bound).length}/${st!.config.seatCount}`,
                    ],
                    [
                      "Labels assigned",
                      labelled,
                      seatList(st!)
                        .map((s) => `${s.seat}:${s.k ?? "–"}/${s.p ?? "–"}`)
                        .join(" "),
                    ],
                    ["Key sheet printed", keySheet, ""],
                  ] as Array<[string, boolean, string | null]>
                ).map(([k, ok, v]) => (
                  <tr key={k}>
                    <td style={{ width: 30 }}>{ok ? <Icon name="ok" /> : <Icon name="warning" />}</td>
                    <td className={ok ? "" : "t-warn"}>{k}</td>
                    <td className="mono small">{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Callout icon="onboarding">
              Seat the participants first. <strong>Start onboarding</strong> locks the seats and sends every
              player to{" "}
              {[
                st!.config.onboarding.consent && "consent",
                st!.config.onboarding.demographics && "demographics",
                st!.config.onboarding.briefing && "the briefing",
              ]
                .filter(Boolean)
                .join(" → ") || "the waiting screen"}
              . The tab then switches to <span className="t-live strong">LIVE</span>.
            </Callout>
          </div>
        ) : null;
      default:
        return null;
    }
  })();

  const primaryLabel = step === LAST_CONFIG ? "Create session" : step === 9 ? "Start onboarding" : "Next";
  const primaryIcon: IconName = step === LAST_CONFIG ? "create" : step === 9 ? "start" : "next";
  const configOnly = step <= LAST_CONFIG && lobby; // config steps are locked once a session exists

  return (
    <div className="col" style={{ gap: "var(--s3)" }}>
      <Panel title="Session setup" icon="setup">
        <div className="col">
          {stepper}
          <div className="row">
            <span className="prompt strong t-primary">
              ▶ STEP {String(step + 1).padStart(2, "0")}/10 · {def.title.toUpperCase()}
            </span>
            {!open && (
              <Button variant="primary" icon="next" kbd="N" onClick={() => setOpen(true)}>
                Resume step {step + 1}
              </Button>
            )}
            <span className="spacer" />
            {lobby && (
              <Button variant="danger" icon="stop" onClick={() => void discard()}>
                Discard session
              </Button>
            )}
          </div>
          {!lobby && st && ["closed", "aborted"].includes(st.phase) && (
            <span className="small muted">
              Previous session {st.sessionId} is {st.phase}. Its data is in DATABASE; configure the next one
              here.
            </span>
          )}
        </div>
      </Panel>

      {lobby && dash && <SeatsPanel conn={conn} dash={dash} scenario={fs.scenario} />}
      {!lobby && draft && (
        <Panel title="Draft" icon="review">
          <div className="row small">
            <StatusTag icon="scenario">{draft.scenarioId || "no scenario"}</StatusTag>
            <StatusTag icon="rounds">
              {draft.config.roundCount} rounds · P{draft.config.defaultRound.quota.propose ?? "∞"} D
              {draft.config.defaultRound.quota.decide ?? "∞"}
            </StatusTag>
            <StatusTag icon="seats">{draft.config.seatCount} seats</StatusTag>
            <StatusTag icon={draft.config.appearance.playerTheme === "mocha" ? "themeDark" : "themeLight"}>
              players {draft.config.appearance.playerTheme}
              {draft.config.appearance.playerCrt ? " + CRT" : ""}
            </StatusTag>
            {normaliseTags(draft.tagsText).map((t) => (
              <StatusTag key={t} icon="tag">
                {t}
              </StatusTag>
            ))}
            <span className="hint">Saved in this browser until the session is created.</span>
          </div>
        </Panel>
      )}

      {open && !configOnly && (
        <Popup
          title={def.title}
          icon={def.icon}
          step={{ index: step, total: SETUP_STEPS.length }}
          stepper={stepper}
          focusKey={`${step}-${draft ? 1 : 0}-${scenarios.length}`}
          width={step === 0 || step === 2 || step === 6 || step === 7 ? 900 : 760}
          onClose={() => setOpen(false)}
          onPrimary={canNext(step) && !busy ? next : undefined}
          footer={
            <>
              <Button icon="back" disabled={step === 0 || (lobby && step === 6)} onClick={back}>
                Back
              </Button>
              <span className="hint">Esc closes — progress is kept.</span>
              <span className="spacer" />
              <Button
                variant="primary"
                icon={primaryIcon}
                kbd="Enter"
                disabled={!canNext(step) || busy}
                onClick={next}
              >
                {primaryLabel}
              </Button>
            </>
          }
        >
          {body}
        </Popup>
      )}
      {open && configOnly && (
        <Popup
          title={def.title}
          icon="lock"
          step={{ index: step, total: SETUP_STEPS.length }}
          stepper={stepper}
          onClose={() => setOpen(false)}
          footer={
            <>
              <span className="spacer" />
              <Button variant="primary" icon="next" kbd="Enter" onClick={() => goTo(firstOpenLobbyStep)}>
                Continue at step {firstOpenLobbyStep + 1}
              </Button>
            </>
          }
          onPrimary={() => goTo(firstOpenLobbyStep)}
        >
          <Callout icon="lock">
            This session has been created; its configuration is locked and recorded in{" "}
            <code>SessionCreated</code>.
          </Callout>
        </Popup>
      )}
    </div>
  );
}
