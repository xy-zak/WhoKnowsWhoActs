import {
  fakeSeats,
  hasParticipants,
  isSimulated,
  normaliseTags,
  pairingName,
  type ServerInfo,
  type SessionConfig,
  seatList,
} from "@wkwa/shared";
import {
  type CSSProperties,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLatest } from "../../net/latest";
import { useStore } from "../../net/store";
import {
  Button,
  Callout,
  Check,
  Icon,
  type IconName,
  StatusTag,
  type StepDef,
  useConfirm,
  useShortcuts,
} from "../../ui";
import type { FacilitatorConnection } from "../connection";
import { AgentsTable, BindEditor, LabelsEditor, labelsComplete } from "../seats";
import { paceText, policySummary } from "../simulation";
import { inLobby } from "../stage";
import {
  CreateStep,
  OnboardingStep,
  onboardingStepsText,
  PlayersStep,
  RoundsStep,
  type ScenarioInfo,
  ScenarioStep,
  TagsStep,
  WhoPlaysStep,
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

/** Connect step: what participants see when they open the HTTPS address, and the fingerprint to compare. */
function TlsNote({ tls }: { tls: ServerInfo["tls"] }) {
  if (!tls.enabled)
    return (
      <p className="hint">
        HTTPS is off (<span className="mono">WKWA_TLS=off</span>): fine for tests, but browsers on other PCs
        cannot use the microphone over plain HTTP.
      </p>
    );
  return (
    <p className="hint">
      {tls.mode === "auto" ? (
        <>
          HTTPS with this laptop's own <strong>self-signed certificate</strong>: each browser shows a security
          warning once; accept it (SESSION-RUNBOOK § 10). The welcome page tells participants beforehand.{" "}
        </>
      ) : (
        "HTTPS with your own certificate (TLS_CERT). "
      )}
      Certificate SHA-256 fingerprint, to compare with the browser's:{" "}
      <strong className="mono" style={{ overflowWrap: "anywhere" }}>
        {tls.fingerprintSha256}
      </strong>
    </p>
  );
}

/** Addresses for the player PCs, one per LAN interface: `https://… (wlan0) or https://… (eth0)`. */
function UrlList({ urls }: { urls: ServerInfo["playerUrls"] }) {
  return (
    <>
      {urls.map((u, k) => (
        <span key={u.url}>
          {k > 0 && " or "}
          <strong className="mono">{u.url}</strong> <span className="faint">({u.iface})</span>
        </span>
      ))}
    </>
  );
}

type SetupStepDef = StepDef & { icon: IconName; title: string };

/**
 * The eleven setup steps. 01–07 configure (no session yet; 07 creates it); 08–11 prepare the
 * created session (lobby).
 */
export const SETUP_STEPS: SetupStepDef[] = [
  { key: "scenario", label: "Scenario", title: "Scenario", icon: "scenario" },
  { key: "rounds", label: "Rounds", title: "Rounds", icon: "rounds" },
  { key: "who", label: "Who plays", title: "Who plays", icon: "seats" },
  { key: "players", label: "Seats", title: "Seats & visibility", icon: "visibility" },
  { key: "onboarding", label: "Onboarding", title: "Onboarding", icon: "onboarding" },
  { key: "tags", label: "Tags", title: "Tags & notes", icon: "tag" },
  { key: "create", label: "Create", title: "Create session", icon: "create" },
  { key: "connect", label: "Connect", title: "Connect & bind clients", icon: "client" },
  { key: "labels", label: "Labels", title: "Assign labels", icon: "labels" },
  { key: "keysheet", label: "Key sheet", title: "Print the key sheet", icon: "keysheet" },
  { key: "start", label: "Start", title: "Start onboarding", icon: "start" },
];
const stepIndex = (key: string) => SETUP_STEPS.findIndex((s) => s.key === key);
const WHO = stepIndex("who");
const PLAYERS = stepIndex("players");
const ONBOARDING = stepIndex("onboarding");
const TAGS = stepIndex("tags");
/** Creates the session: the last configuration step. */
const CREATE = stepIndex("create");
const CONNECT = stepIndex("connect");
const LABELS = stepIndex("labels");
const KEYSHEET = stepIndex("keysheet");
const START = stepIndex("start");
const STEP_COUNT = SETUP_STEPS.length;
/** "07": a step's number as shown. */
const num = (i: number) => String(i + 1).padStart(2, "0");

/** How the lobby steps read when the players are simulated (agents); keys are 0-based step indexes. */
const SIMULATED_STEPS: Record<number, Partial<SetupStepDef>> = {
  [CONNECT]: { label: "Agents", title: "Simulated players", icon: "agent" },
  [KEYSHEET]: { label: "Key sheet", title: "Key sheet (not needed)" },
  [START]: { label: "Start", title: "Start simulation", icon: "simulation" },
};
/** Steps a simulated session skips (shown with the – glyph). */
const SKIPPED_WHEN_SIMULATED = new Set([ONBOARDING, KEYSHEET]);

type ChecklistRow = [label: string, ok: boolean, value: string | null];

/** The final check before starting: ✓ or ⚠ per row, with a short value. */
function Checklist({ rows }: { rows: ChecklistRow[] }) {
  return (
    <table className="grid">
      <tbody>
        {rows.map(([k, ok, v]) => (
          <tr key={k}>
            <td style={{ width: 30 }}>{ok ? <Icon name="ok" /> : <Icon name="warning" />}</td>
            <td className={ok ? "" : "t-warn"}>{k}</td>
            <td className="mono small">{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function setupSteps(simulated: boolean) {
  return SETUP_STEPS.map((d, i) => (simulated ? { ...d, ...SIMULATED_STEPS[i] } : d));
}

/** Steps drawn in the accent (review) colour: the two "commit" points of the setup. */
const ACCENT_STEPS = new Set([CREATE, START]);

/**
 * SETUP: the eleven steps as a vertical accordion. Exactly one step (the current
 * one) is expanded; finished steps collapse into a one-line summary and can
 * be reopened; steps 01–07 lock (■) once the session has been created.
 */
export function SetupStage({ conn }: { conn: FacilitatorConnection }) {
  const fs = useStore(conn.store);
  const confirm = useConfirm();
  const dash = fs.dashboard;
  const st = dash?.state ?? null;
  /** the attached session while it is in its lobby (steps 08–11), else null */
  const ls = st && inLobby(st) ? st : null;
  const lobby = ls !== null;
  const sessionId = ls?.sessionId ?? null;

  const [scenarios, setScenarios] = useState<ScenarioInfo[]>([]);
  const [draft, setDraftState] = useState<Draft | null>(loadDraft);
  const [step, setStep] = useState<number>(() => (lobby ? CONNECT : (loadDraft()?.reached ?? 0)));
  const [busy, setBusy] = useState(false);
  const [keySheet, setKeySheet] = useState(false);
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const urls = info?.playerUrls ?? [];
  const landing = info?.landingUrls ?? [];
  const stepRefs = useRef<Array<HTMLElement | null>>([]);
  const didMount = useRef(false);
  const wayRef = useRef<HTMLElement | null>(null);
  const [wayH, setWayH] = useState(90);
  // the pinned wayfinder's height keeps scrolled-to steps clear of it (scroll-margin-top)
  useEffect(() => {
    const el = wayRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWayH(Math.ceil(el.getBoundingClientRect().height)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const upd = useCallback((patch: Partial<Draft>) => {
    setDraftState((cur) => {
      const next = { ...(cur ?? emptyDraft()), ...patch };
      saveDraft(next);
      return next;
    });
  }, []);

  const latest = useLatest();
  useEffect(() => {
    const ifLatest = latest();
    conn.api<ScenarioInfo[]>("/api/scenarios").then(ifLatest(setScenarios), () => {});
    conn.api<ServerInfo>("/api/server-info").then(ifLatest(setInfo), () => {});
    if (!loadDraft()) {
      conn.api<SessionConfig>("/api/config/session-defaults").then(
        (def) => setDraftState((cur) => cur ?? emptyDraft(def)),
        () => setDraftState((cur) => cur ?? emptyDraft()),
      );
    }
  }, [conn, latest]);
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
  // simulated players: from the attached session once created, from the draft before
  const simulated = lobby ? isSimulated(ls) : draft?.config.players === "simulated";
  const steps = setupSteps(simulated);
  const allBound = lobby && seatList(ls).every((s) => s.bound);
  const fakes = lobby ? fakeSeats(ls) : [];
  // all seats taken by agents or fake players: nobody to write on a key sheet
  const noParticipants = allBound && !hasParticipants(ls);
  const skipped = (i: number) =>
    (simulated && SKIPPED_WHEN_SIMULATED.has(i)) || (noParticipants && i === KEYSHEET);
  const labelled = lobby && labelsComplete(ls);
  const labelsRow: ChecklistRow = [
    `Labels assigned (${lobby ? pairingName(ls.labelPairing) : "—"})`,
    labelled,
    lobby
      ? seatList(ls)
          .map((s) => `${s.seat}:${s.k ?? "–"}/${s.p ?? "–"}`)
          .join(" ")
      : "",
  ];
  const keySheetDone = keySheet || simulated || noParticipants;
  const done = (i: number): boolean => {
    if (i <= CREATE) return lobby || i < (draft?.reached ?? 0);
    if (!lobby) return false;
    if (i === CONNECT) return allBound;
    if (i === LABELS) return labelled;
    if (i === KEYSHEET) return keySheetDone;
    return false;
  };
  const locked = (i: number) => lobby && i <= CREATE;
  const firstOpenLobbyStep = !allBound ? CONNECT : !labelled ? LABELS : !keySheetDone ? KEYSHEET : START;
  const reachable = (i: number) =>
    !locked(i) &&
    ((i !== step && done(i)) ||
      (!lobby && i <= (draft?.reached ?? 0)) ||
      (lobby && i >= CONNECT && i <= firstOpenLobbyStep));
  const glyphOf = (i: number) =>
    i === step ? "▶" : locked(i) ? "■" : skipped(i) && done(i) ? "–" : done(i) ? "✓" : "·";
  // when a session appears (created or resumed) jump to the lobby steps
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the attached lobby session changes
  useEffect(() => {
    if (lobby) setStep((s) => (s <= CREATE ? firstOpenLobbyStep : s));
    else setStep((s) => (s > CREATE ? (draft?.reached ?? 0) : s));
  }, [sessionId]);

  const final = useMemo(() => (draft ? finalConfig(draft) : { error: "loading" }), [draft]);
  const canNext = (i: number): boolean => {
    if (!draft && i <= CREATE) return false;
    switch (i) {
      case 0:
        return Boolean(draft?.scenarioId);
      case CREATE:
        return "config" in final;
      case CONNECT:
        return allBound;
      case LABELS:
        return labelled;
      case KEYSHEET:
        return keySheetDone;
      default:
        return true;
    }
  };

  const goTo = (i: number) => {
    if (locked(i)) return;
    setStep(i);
    if (draft && i <= CREATE && i > draft.reached) upd({ reached: i });
  };

  // bring the expanded step into view and focus its first field (not on the first render)
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
      setStep(CONNECT);
    } catch {
    } finally {
      setBusy(false);
    }
  };

  const startOnboarding = async () => {
    setBusy(true);
    try {
      if (simulated) await conn.cmd("simulation:start", {}, "Simulation started — now LIVE");
      else await conn.cmd("onboarding:start", {}, "Onboarding started — now LIVE");
    } catch {
    } finally {
      setBusy(false);
    }
  };

  const next = () => {
    if (!canNext(step) || busy) return;
    if (step === CREATE) return void create();
    if (step === START) return void startOnboarding();
    goTo(step + 1);
  };
  const back = () => {
    const minStep = lobby ? CONNECT : 0;
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
      conn.run("session:abort", { reason: "discarded during setup" }, "Session discarded");
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
  const cfg = lobby ? ls.config : draft?.config;
  const sc = scenarios.find((s) => s.id === (lobby ? ls.scenario?.id : draft?.scenarioId));
  const summary = (i: number): string => {
    if (!cfg) return "";
    const r = cfg.defaultRound;
    if (simulated) {
      const s = simulatedSummary(i);
      if (s !== null) return s;
    }
    switch (i) {
      case 0:
        return sc
          ? `${sc.title} · ${sc.board ? `${sc.board.cols} × ${sc.board.rows} squares` : `${sc.regionCount} sub-squares`} · rules ${cfg.rules}`
          : "not chosen";
      case 1:
        return `${cfg.roundCount} rounds · propose ${r.quota.propose ?? "∞"} · decide ${r.quota.decide ?? "∞"}${r.timeLimitSec ? ` · ${r.timeLimitSec}s` : ""}`;
      case WHO:
        return "real participants · participant database";
      case PLAYERS:
        return `${cfg.seatCount} seats · view ${cfg.viewAssignment === "byKnowledgeType" ? "follows K" : "manual"}`;
      case ONBOARDING:
        return onboardingStepsText(cfg, { mic_check: "mic check & calibration (audio)" }) || "no onboarding";
      case TAGS: {
        const tags = lobby ? cfg.tags : normaliseTags(draft?.tagsText ?? "");
        return tags.length ? `tags: ${tags.join(", ")}` : "no tags";
      }
      case CREATE:
        return lobby ? `created · ${sessionId}` : `creates the session and locks steps 01–${num(CREATE)}`;
      case CONNECT:
        return lobby
          ? `${seatList(ls).filter((s) => s.bound).length}/${cfg.seatCount} seats bound${fakes.length ? ` (${fakes.length} fake)` : ""}`
          : "after the session is created";
      case LABELS:
        return lobby && labelled
          ? `${pairingName(ls.labelPairing)} · ${seatList(ls)
              .map((s) => `${s.seat}:${s.k}/${s.p}`)
              .join("  ")}`
          : "the K–P pairing: aligned or dissociated D1–D6";
      case KEYSHEET:
        return keySheet ? "printed ✓" : "print, fill in names by hand, store separately";
      case START:
        return "locks the seats and flips this tab to LIVE";
      default:
        return "";
    }
  };

  /** Summaries that read differently for simulated players (null = same as for real ones). */
  function simulatedSummary(i: number): string | null {
    if (!cfg) return null;
    switch (i) {
      case WHO:
        return `simulated · ${policySummary(cfg.simulation, cfg.seatCount)} · pause ${paceText(cfg.simulation)}`;
      case PLAYERS:
        return `${cfg.seatCount} simulated seats · view ${cfg.viewAssignment === "byKnowledgeType" ? "follows K" : "manual"}`;
      case ONBOARDING:
        return "skipped: agents have no onboarding";
      case CONNECT:
        return lobby
          ? `${seatList(ls).filter((s) => s.agent).length} agents · seed ${cfg.simulation.seed}`
          : "every seat gets an agent when the session is created";
      case KEYSHEET:
        return "skipped: no participants, so no names or codes";
      case START:
        return "locks the seats, starts round 1 with the agents and flips this tab to LIVE";
      default:
        return null;
    }
  }

  /* step bodies */
  const body = (i: number) => {
    if (simulated && lobby && (i === CONNECT || i === KEYSHEET || i === START)) return simulatedBody(i);
    if (i <= CREATE && !draft) return <span className="muted cursor">Loading defaults</span>;
    const d = draft!;
    switch (i) {
      case 0:
        return <ScenarioStep conn={conn} d={d} upd={upd} scenarios={scenarios} />;
      case 1:
        return <RoundsStep d={d} upd={upd} />;
      case WHO:
        return <WhoPlaysStep d={d} upd={upd} />;
      case PLAYERS:
        return <PlayersStep d={d} upd={upd} />;
      case ONBOARDING:
        return <OnboardingStep d={d} upd={upd} httpsEnabled={info ? info.tls.enabled : null} />;
      case TAGS:
        return <TagsStep d={d} upd={upd} />;
      case CREATE:
        return <CreateStep lastStep={num(CREATE)} error={"error" in final ? final.error : null} />;
      case CONNECT:
        return dash && lobby ? (
          <div className="col">
            <Callout icon="client">
              {landing.length ? (
                <>
                  On each player PC, open the welcome page <UrlList urls={landing} /> in full-screen (F11) and
                  click <strong>Join live session</strong> (it appears now that the session exists). It leads
                  to the game page <UrlList urls={urls} />.
                </>
              ) : (
                <>
                  On each player PC, open{" "}
                  {urls.length ? (
                    <UrlList urls={urls} />
                  ) : (
                    <strong>the player URL printed when the server started</strong>
                  )}{" "}
                  in full-screen (F11).
                </>
              )}{" "}
              Each one appears here as a numbered <strong>client</strong>; bind each client to a seat.
            </Callout>
            {info && <TlsNote tls={info.tls} />}
            <BindEditor conn={conn} dash={dash} />
          </div>
        ) : null;
      case LABELS:
        return lobby ? <LabelsEditor conn={conn} st={ls} scenario={fs.scenario} /> : null;
      case KEYSHEET:
        if (lobby && noParticipants) {
          return (
            <Callout icon="fake">
              Not needed: every seat is a fake player, so there are no participants, codes or names.
            </Callout>
          );
        }
        return lobby ? (
          <div className="col">
            <p>
              The <strong>key sheet</strong> is the only place where a participant code meets a name, and the
              name is written <strong>by hand</strong>. Print it now, fill in names as participants arrive,
              and store it separately from all data.
            </p>
            {fakes.length > 0 && (
              <Callout icon="fake">
                Seat {fakes.join(", ")} {fakes.length === 1 ? "is a" : "are"} fake player
                {fakes.length === 1 ? "" : "s"}: listed as FAKE PLAYER on the sheet, with no code and no name.
              </Callout>
            )}
            <div className="row">
              <Button
                icon="print"
                tip="Open the printable sheet of seats and participant codes; names are written on it by hand, never typed"
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
      case START:
        return lobby ? (
          <div className="col">
            <Checklist
              rows={[
                ["Session created", true, sessionId],
                [
                  "All seats bound",
                  allBound,
                  `${seatList(ls).filter((s) => s.bound).length}/${ls.config.seatCount}`,
                ],
                labelsRow,
                ["Key sheet printed", keySheetDone, noParticipants ? "not needed (fake players only)" : ""],
                ...(fakes.length
                  ? ([
                      [
                        "Fake players (test clients, no onboarding, no code)",
                        true,
                        `seat ${fakes.join(", ")}`,
                      ],
                    ] as ChecklistRow[])
                  : []),
              ]}
            />
            <Callout icon="onboarding">
              Seat the participants first. <strong>Start onboarding</strong> locks the seats and sends every
              player to{" "}
              {onboardingStepsText(ls.config, { mic_check: "the mic check", briefing: "the briefing" }) ||
                "the waiting screen"}
              . The tab then switches to <span className="t-live strong">LIVE</span>.
              {fakes.length > 0 && " Fake players skip onboarding and are ready at once."}
            </Callout>
          </div>
        ) : null;
      default:
        return null;
    }
  };

  /** The connect, key sheet and start steps of a simulated session. */
  function simulatedBody(i: number) {
    if (!ls) return null; // lobby steps: only reachable in the lobby
    switch (i) {
      case CONNECT:
        return (
          <div className="col">
            <Callout icon="agent">
              Every seat is taken by an <strong>agent</strong>: no player PCs, client binding or participant
              codes. The agents act once the simulation starts (step {num(START)}).
            </Callout>
            <AgentsTable st={ls} />
          </div>
        );
      case KEYSHEET:
        return (
          <Callout icon="keysheet">
            Not needed. A simulated session has no participants, so there are no names or codes to keep apart.
          </Callout>
        );
      case START:
        return (
          <div className="col">
            <Checklist
              rows={[
                ["Session created (simulation database)", true, sessionId],
                [
                  "Agents in every seat",
                  allBound,
                  `${seatList(ls).filter((s) => s.agent).length}/${ls.config.seatCount} · ${policySummary(ls.config.simulation, ls.config.seatCount)}`,
                ],
                labelsRow,
              ]}
            />
            <Callout icon="simulation">
              <strong>Start simulation</strong> locks the seats and starts round 1 straight away. The agents
              then take a turn every {paceText(ls.config.simulation)} (seed{" "}
              <span className="mono">{ls.config.simulation.seed}</span>). Rounds after the first start{" "}
              {ls.config.roundAdvance === "auto"
                ? `automatically after ${ls.config.autoAdvanceDelaySec} s`
                : "when you start them in LIVE"}
              . The tab switches to <span className="t-live strong">LIVE</span>.
            </Callout>
          </div>
        );
      default:
        return null;
    }
  }

  const primary = (i: number): { label: string; icon: IconName; tip?: string } =>
    i === CREATE
      ? {
          label: "Create session",
          icon: "create",
          tip: `Create the session with these settings; steps 01–${num(CREATE)} are then locked`,
        }
      : i === START
        ? simulated
          ? { label: "Start simulation", icon: "start", tip: "Run the game with the simulated players" }
          : {
              label: "Start onboarding",
              icon: "start",
              tip: "Send every player to consent, the short questionnaire and the briefing",
            }
        : { label: "Next", icon: "next" };
  const blockedHint: Record<number, string> = {
    [CONNECT]: "Bind every seat to continue.",
    [LABELS]: "Choose the pairing to continue.",
    [KEYSHEET]: "Tick the box to continue.",
  };

  return (
    <div className="col" style={{ gap: "var(--s3)", "--wayfinder-h": `${wayH}px` } as CSSProperties}>
      <nav ref={wayRef} className="wayfinder" aria-label="Session setup steps">
        <div className="row">
          <Icon name="setup" />
          <span className="strong upper">Session setup</span>
          <span className="strong">
            ▶ STEP {num(step)}/{STEP_COUNT} · {steps[step]!.title.toUpperCase()}
          </span>
          {simulated && <StatusTag icon="simulation">simulated players</StatusTag>}
          <span className="spacer" />
          <span className="hint">
            01–{num(CREATE)} configure · {num(CONNECT)}–{num(START)}{" "}
            {simulated ? "prepare the agents" : "prepare the room"} · <kbd>Enter</kbd> next · <kbd>N</kbd>{" "}
            current step
          </span>
          {lobby && (
            <Button
              variant="danger"
              size="sm"
              icon="stop"
              onClick={() => void discard()}
              tip="Abandon this session (marked aborted) and configure a new one"
            >
              Discard session
            </Button>
          )}
        </div>
        <div className="wayfinder-strip">
          {steps.map((def, i) => {
            const cls =
              i === step
                ? "current"
                : locked(i)
                  ? "locked"
                  : done(i)
                    ? `done${skipped(i) ? " skipped" : ""}`
                    : "upcoming";
            return (
              <button
                key={def.key}
                type="button"
                className={cls}
                aria-current={i === step ? "step" : undefined}
                disabled={i === step || !reachable(i)}
                onClick={() => goTo(i)}
                title={`${num(i)} ${def.title}${locked(i) ? " (locked)" : skipped(i) ? " (skipped)" : ""}`}
              >
                {glyphOf(i)} {num(i)} {def.label}
              </button>
            );
          })}
        </div>
      </nav>
      {!lobby && st && ["closed", "aborted"].includes(st.phase) && (
        <p className="small muted" style={{ margin: 0 }}>
          Previous session {st.sessionId} is {st.phase}. Its data is in DATABASE; configure the next one
          below.
        </p>
      )}

      <div className="accordion">
        {steps.map((def, i) => {
          const isCurrent = i === step;
          const isLocked = locked(i);
          const isDone = !isCurrent && done(i);
          const state = isCurrent ? "current" : isDone ? `done${skipped(i) ? " skipped" : ""}` : "upcoming";
          const glyph = glyphOf(i);
          const p = primary(i);
          return (
            <section
              key={def.key}
              ref={(el) => {
                stepRefs.current[i] = el;
              }}
              className={`acc-step ${state}${ACCENT_STEPS.has(i) ? " accent" : ""}${isLocked ? " locked" : ""}`}
              data-step={def.key}
            >
              <button
                type="button"
                className="acc-head"
                aria-expanded={isCurrent}
                disabled={isCurrent || !reachable(i)}
                onClick={() => goTo(i)}
                title={isLocked ? "Locked: the session has been created" : undefined}
              >
                <span className="glyph">{glyph}</span>
                <span className="num">{num(i)}</span>
                <Icon name={isLocked ? "lock" : def.icon} />
                <span className="title">{def.title}</span>
                <span className="summary">{isCurrent ? "" : summary(i)}</span>
                {isCurrent && (
                  <StatusTag tone={ACCENT_STEPS.has(i) ? "neutral" : "primary"}>
                    step {i + 1}/{STEP_COUNT}
                  </StatusTag>
                )}
                {isLocked && <StatusTag>locked</StatusTag>}
              </button>
              {isCurrent && (
                <div className="acc-body" onKeyDown={onBodyKey}>
                  {body(i)}
                  <div className="acc-foot">
                    <Button icon="back" disabled={i === 0 || (lobby && i === CONNECT)} onClick={back}>
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
                      tip={p.tip}
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
