import { normaliseTags, pairingName, type SessionConfig, seatList } from "@wkwa/shared";
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../../net/store";
import {
  Button,
  Callout,
  Check,
  Icon,
  type IconName,
  Panel,
  StatusTag,
  type StepDef,
  useConfirm,
  useShortcuts,
} from "../../ui";
import type { FacilitatorConnection } from "../connection";
import { BindEditor, LabelsEditor, labelsComplete } from "../seats";
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
  { key: "scenario", label: "Scenario", title: "Scenario", icon: "scenario" },
  { key: "rounds", label: "Rounds", title: "Rounds", icon: "rounds" },
  { key: "players", label: "Players", title: "Players & visibility", icon: "visibility" },
  { key: "onboarding", label: "Onboarding", title: "Onboarding", icon: "onboarding" },
  { key: "tags", label: "Tags", title: "Tags & notes", icon: "tag" },
  { key: "review", label: "Review", title: "Review & create", icon: "review" },
  { key: "connect", label: "Connect", title: "Connect & bind clients", icon: "client" },
  { key: "labels", label: "Labels", title: "Assign labels", icon: "labels" },
  { key: "keysheet", label: "Key sheet", title: "Print the key sheet", icon: "keysheet" },
  { key: "start", label: "Start", title: "Start onboarding", icon: "start" },
];
const LAST_CONFIG = 5;
const REVIEW = 5;

/**
 * SETUP: the ten steps as a vertical accordion. Exactly one step (the current
 * one) is expanded; finished steps collapse into a one-line summary and can
 * be reopened; steps 01–06 lock (■) once the session has been created.
 */
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
  const [busy, setBusy] = useState(false);
  const [keySheet, setKeySheet] = useState(false);
  const [urls, setUrls] = useState<Array<{ url: string; iface: string }>>([]);
  const stepRefs = useRef<Array<HTMLElement | null>>([]);
  const didMount = useRef(false);

  const upd = useCallback((patch: Partial<Draft>) => {
    setDraftState((cur) => {
      const next = { ...(cur ?? emptyDraft()), ...patch };
      saveDraft(next);
      return next;
    });
  }, []);

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
  }, [draft, scenarios, upd]);
  useEffect(() => {
    if (sessionId) setKeySheet(keySheetConfirmed(sessionId));
  }, [sessionId]);

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
  const locked = (i: number) => lobby && i <= LAST_CONFIG;
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
      case REVIEW:
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
    if (locked(i)) return;
    setStep(i);
    if (draft && i <= LAST_CONFIG && i > draft.reached) upd({ reached: i });
  };

  // bring the expanded step into view and focus its first field (not on the first render)
  // biome-ignore lint/correctness/useExhaustiveDependencies: on step change only
  useEffect(() => {
    if (!didMount.current) {
      didMount.current = true;
      return;
    }
    const el = stepRefs.current[step];
    if (!el) return;
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "nearest", behavior: smooth ? "smooth" : "auto" });
    el.querySelector<HTMLElement>(
      ".acc-body input, .acc-body select, .acc-body textarea, .acc-foot .btn-primary",
    )?.focus({ preventScroll: true });
  }, [step]);

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
    if (!canNext(step) || busy) return;
    if (step === REVIEW) return void create();
    if (step === 9) return void startOnboarding();
    goTo(step + 1);
  };
  const back = () => {
    const minStep = lobby ? 6 : 0;
    if (step > minStep) goTo(step - 1);
  };
  const onBodyKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (e.key !== "Enter" || ["TEXTAREA", "BUTTON", "SELECT"].includes(t.tagName)) return;
    e.preventDefault();
    next();
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

  useShortcuts([
    {
      key: "n",
      label: "current step",
      run: () => {
        stepRefs.current[step]?.scrollIntoView({ block: "nearest" });
        stepRefs.current[step]?.querySelector<HTMLElement>(".acc-foot .btn-primary")?.focus();
      },
    },
  ]);

  /* one-line summaries shown on collapsed steps */
  const cfg = lobby ? st!.config : draft?.config;
  const sc = scenarios.find((s) => s.id === (lobby ? st!.scenario?.id : draft?.scenarioId));
  const summary = (i: number): string => {
    if (!cfg) return "";
    const r = cfg.defaultRound;
    switch (i) {
      case 0:
        return sc ? `${sc.title} · ${sc.regionCount} regions · views ${sc.viewIds.join(" ")}` : "not chosen";
      case 1:
        return `${cfg.roundCount} rounds · propose ${r.quota.propose ?? "∞"} · decide ${r.quota.decide ?? "∞"}${r.timeLimitSec ? ` · ${r.timeLimitSec}s` : ""}`;
      case 2:
        return `${cfg.seatCount} seats · view ${cfg.viewAssignment === "byKnowledgeType" ? "follows K" : "manual"} · player screens ${cfg.appearance.playerTheme}${cfg.appearance.playerAnimations ? " + animations" : ""}`;
      case 3:
        return (
          [
            cfg.onboarding.consent && "consent",
            cfg.onboarding.demographics && "demographics",
            cfg.onboarding.briefing && "briefing",
          ]
            .filter(Boolean)
            .join(" → ") || "no onboarding"
        );
      case 4: {
        const tags = lobby ? cfg.tags : normaliseTags(draft?.tagsText ?? "");
        return tags.length ? `tags: ${tags.join(", ")}` : "no tags";
      }
      case REVIEW:
        return lobby ? `created · ${sessionId}` : "check everything, then create the session";
      case 6:
        return lobby
          ? `${seatList(st!).filter((s) => s.bound).length}/${cfg.seatCount} seats bound`
          : "after the session is created";
      case 7:
        return lobby && labelled
          ? `${pairingName(st!.labelPairing)} · ${seatList(st!)
              .map((s) => `${s.seat}:${s.k}/${s.p}`)
              .join("  ")}`
          : "K per seat; P from the pairing (aligned or dissociated D1–D6)";
      case 8:
        return keySheet ? "printed ✓" : "print, fill in names by hand, store separately";
      case 9:
        return "locks the seats and flips this tab to LIVE";
      default:
        return "";
    }
  };

  /* step bodies */
  const body = (i: number) => {
    if (i <= LAST_CONFIG && !draft) return <span className="muted cursor">Loading defaults</span>;
    const d = draft!;
    switch (i) {
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
      case REVIEW:
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
            <Callout icon="client">
              On each player PC, open{" "}
              {urls.length ? (
                urls.map((u, k) => (
                  <span key={u.url}>
                    {k > 0 && " or "}
                    <strong className="mono">{u.url}</strong> <span className="faint">({u.iface})</span>
                  </span>
                ))
              ) : (
                <strong>the player URL printed when the server started</strong>
              )}{" "}
              in full-screen (F11). Each one appears here as a numbered <strong>client</strong>; bind each
              client to a seat.
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
                      `Labels assigned (${pairingName(st!.labelPairing)})`,
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
  };

  const primary = (i: number): { label: string; icon: IconName } =>
    i === REVIEW
      ? { label: "Create session", icon: "create" }
      : i === 9
        ? { label: "Start onboarding", icon: "start" }
        : { label: "Next", icon: "next" };
  const blockedHint: Record<number, string> = {
    6: "Bind every seat to continue.",
    7: "Choose the pairing and save the labels to continue.",
    8: "Tick the box to continue.",
  };

  return (
    <div className="col" style={{ gap: "var(--s3)" }}>
      <Panel title="Session setup" icon="setup">
        <div className="row">
          <span className="strong t-primary">
            ▶ STEP {String(step + 1).padStart(2, "0")}/10 · {SETUP_STEPS[step]!.title.toUpperCase()}
          </span>
          <span className="hint">
            01–06 configure the session · 07–10 prepare the room · <kbd>Enter</kbd> next · <kbd>N</kbd>{" "}
            current step
          </span>
          <span className="spacer" />
          {lobby && (
            <Button variant="danger" icon="stop" onClick={() => void discard()}>
              Discard session
            </Button>
          )}
        </div>
        {!lobby && st && ["closed", "aborted"].includes(st.phase) && (
          <p className="small muted" style={{ marginTop: "var(--s2)" }}>
            Previous session {st.sessionId} is {st.phase}. Its data is in DATABASE; configure the next one
            below.
          </p>
        )}
      </Panel>

      <div className="accordion">
        {SETUP_STEPS.map((def, i) => {
          const isCurrent = i === step;
          const isLocked = locked(i);
          const isDone = !isCurrent && done(i);
          const reachable =
            !isLocked &&
            (isDone ||
              (!lobby && i <= (draft?.reached ?? 0)) ||
              (lobby && i >= 6 && i <= firstOpenLobbyStep));
          const state = isCurrent ? "current" : isDone ? "done" : "upcoming";
          const glyph = isCurrent ? "▶" : isLocked ? "■" : isDone ? "✓" : "·";
          const p = primary(i);
          return (
            <section
              key={def.key}
              ref={(el) => {
                stepRefs.current[i] = el;
              }}
              className={`acc-step ${state}${i === REVIEW ? " review" : ""}${isLocked ? " locked" : ""}`}
              data-step={def.key}
            >
              <button
                type="button"
                className="acc-head"
                aria-expanded={isCurrent}
                disabled={isCurrent || !reachable}
                onClick={() => goTo(i)}
                title={isLocked ? "Locked: the session has been created" : undefined}
              >
                <span className="glyph">{glyph}</span>
                <span className="num">{String(i + 1).padStart(2, "0")}</span>
                <Icon name={isLocked ? "lock" : def.icon} />
                <span className="title">{def.title}</span>
                <span className="summary">{isCurrent ? "" : summary(i)}</span>
                {isCurrent && (
                  <StatusTag tone={i === REVIEW ? "neutral" : "primary"}>step {i + 1}/10</StatusTag>
                )}
                {isLocked && <StatusTag>locked</StatusTag>}
              </button>
              {isCurrent && (
                // biome-ignore lint/a11y/noStaticElementInteractions: Enter anywhere in the step moves on (fields keep their own keys)
                <div className="acc-body" onKeyDown={onBodyKey}>
                  {body(i)}
                  <div className="acc-foot">
                    <Button icon="back" disabled={i === 0 || (lobby && i === 6)} onClick={back}>
                      Back
                    </Button>
                    <span className="spacer" />
                    {!canNext(i) && blockedHint[i] && <span className="hint">{blockedHint[i]}</span>}
                    <Button
                      variant="primary"
                      icon={p.icon}
                      kbd="Enter"
                      disabled={!canNext(i) || busy}
                      onClick={next}
                    >
                      {p.label}
                    </Button>
                  </div>
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
