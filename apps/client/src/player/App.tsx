import type { PlayerView } from "@wkwa/shared";
import { useEffect, useMemo, useRef } from "react";
import { useStore } from "../net/store";
import { applyAppearance, Icon, Popup, StatusTag, ToastView, useSignalClass } from "../ui";
import { Centered, OnboardingStepper } from "./chrome";
import type { PlayerConnection } from "./connection";
import { Game } from "./Game";
import { BriefingScreen, ConsentScreen, DeclinedScreen, DemographicsScreen } from "./Onboarding";

type Screen =
  | "waiting"
  | "lobby"
  | "consent"
  | "declined"
  | "demographics"
  | "briefing"
  | "ready"
  | "game"
  | "round_break"
  | "paused"
  | "end"
  | "withdrawn";

function screenFor(seat: number | null, v: PlayerView | null): Screen {
  if (seat === null || !v) return "waiting";
  if (v.me.withdrawn) return "withdrawn";
  switch (v.phase) {
    case "lobby":
      return "lobby";
    case "onboarding":
      if (v.me.consent === "declined") return "declined";
      return v.me.nextStep ?? "ready";
    case "round_active":
      return v.paused ? "paused" : "game";
    case "round_complete":
      return "round_break";
    default:
      return "end";
  }
}

export function App({ conn }: { conn: PlayerConnection }) {
  const st = useStore(conn.store);
  const screen = screenFor(st.seat, st.view);

  // Appearance is decided per session (identical for every seat); Mocha with animations before a session is known.
  const theme = st.view?.appearance.playerTheme ?? "mocha";
  const crt = st.view?.appearance.playerAnimations ?? true;
  useEffect(() => applyAppearance(theme, crt), [theme, crt]);

  // screen_view telemetry
  const lastScreen = useRef<string | null>(null);
  useEffect(() => {
    if (st.seat !== null && lastScreen.current !== screen) {
      lastScreen.current = screen;
      conn.track("screen_view", { screen });
    }
  }, [screen, st.seat, conn]);

  useGlobalTelemetry(conn);
  const signal = useSignalClass(st.connected);
  // the game screen stays mounted through pauses and round breaks (keeps tool / selection)
  const screenKey = screen === "paused" || screen === "round_break" ? "game" : screen;

  const body = useMemo(() => {
    const v = st.view;
    switch (screen) {
      case "waiting":
        return <Waiting terminal={st.terminal} connected={st.connected} notice={st.notice} />;
      case "lobby":
        return (
          <Centered title="Welcome" icon="seat">
            <h1>Seat {st.seat}</h1>
            <p className="muted cursor">The session will start shortly. Please wait</p>
          </Centered>
        );
      case "consent":
        return <ConsentScreen conn={conn} view={v!} />;
      case "declined":
        return <DeclinedScreen />;
      case "demographics":
        return <DemographicsScreen conn={conn} view={v!} />;
      case "briefing":
        return <BriefingScreen conn={conn} view={v!} />;
      case "ready": {
        const ready = (v?.others ?? []).filter((o) => o.ready).length + 1;
        const total = (v?.others.length ?? 0) + 1;
        return (
          <Centered title="Ready" icon="ok">
            <OnboardingStepper v={v!} current="ready" />
            <h1>You're all set</h1>
            <p className="muted cursor">
              Waiting for the other players ({ready}/{total} ready) and for round 1
            </p>
          </Centered>
        );
      }
      case "game":
      case "paused":
      case "round_break":
        return <Game conn={conn} view={v!} />;
      case "end":
      case "withdrawn":
        return <EndScreen view={v!} withdrawn={screen === "withdrawn"} />;
    }
  }, [screen, st.view, st.terminal, st.connected, st.notice, st.seat, conn]);

  return (
    <>
      {!st.connected && st.terminal !== null && (
        <Popup title="Connection lost" icon="disconnected" closable={false} width={480}>
          <p className="cursor">Reconnecting to the game server. Please do not close this window</p>
        </Popup>
      )}
      <div key={screenKey} className={`screen-switch ${signal}`} style={{ height: "100%" }}>
        {body}
      </div>
      <ToastView toast={st.toast ? { text: st.toast, kind: "warn" } : null} />
    </>
  );
}

function Waiting({
  terminal,
  connected,
  notice,
}: {
  terminal: number | null;
  connected: boolean;
  notice: string | null;
}) {
  return (
    <Centered title="Client" icon="client" width={560}>
      <div className="client-number">{terminal ?? "··"}</div>
      <p
        key={connected ? "on" : "off"}
        className={`conn-flicker ${connected ? "muted cursor" : "t-warn cursor"}`}
      >
        {connected
          ? "Connected. Waiting for the facilitator to assign a seat"
          : "Connecting to the game server"}
      </p>
      {notice && <StatusTag>{notice}</StatusTag>}
    </Centered>
  );
}

function EndScreen({ view, withdrawn }: { view: PlayerView; withdrawn: boolean }) {
  const study = view.study;
  return (
    <Centered title={withdrawn ? "Stopped" : "Session complete"} icon="done" width={680}>
      <h1>{withdrawn ? "You have stopped participating" : "Thank you for taking part"}</h1>
      {!withdrawn && view.phase === "aborted" && <p className="muted">The session was ended early.</p>}
      {view.me.participantCode && (
        <>
          <p className="muted upper small">Your personal participant code</p>
          <div
            className="strong"
            style={{
              fontSize: 32,
              letterSpacing: "0.1em",
              padding: "var(--s2) var(--s4)",
              border: "1px dashed var(--control)",
              color: "var(--primary)",
            }}
          >
            {view.me.participantCode}
          </div>
          <p className="small">
            {study?.takedownInstructions ??
              "Keep this code. Quote it if you want your data removed from the study."}
          </p>
          {study && (
            <p className="small muted">
              <Icon name="info" /> {study.researcher} — {study.contactEmail}
            </p>
          )}
        </>
      )}
      <p className="muted cursor">You may now let the facilitator know you are finished</p>
    </Centered>
  );
}

/** focus/visibility/idle telemetry for the whole page. */
function useGlobalTelemetry(conn: PlayerConnection) {
  useEffect(() => {
    const onFocus = () => conn.track("focus_change", { focused: true });
    const onBlur = () => conn.track("focus_change", { focused: false });
    const onVis = () => conn.track("visibility_change", { visible: document.visibilityState === "visible" });
    let idleSince: number | null = null;
    let last = performance.now();
    const activity = () => {
      last = performance.now();
      if (idleSince !== null) {
        conn.track("idle", { state: "end", durationMs: Math.round(performance.now() - idleSince) });
        idleSince = null;
      }
    };
    const idleTimer = setInterval(() => {
      if (idleSince === null && performance.now() - last > 30_000) {
        idleSince = last;
        conn.track("idle", { state: "start", durationMs: null });
      }
    }, 1000);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVis);
    for (const ev of ["pointermove", "pointerdown", "keydown", "wheel"])
      window.addEventListener(ev, activity, { passive: true });
    return () => {
      clearInterval(idleTimer);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVis);
      for (const ev of ["pointermove", "pointerdown", "keydown", "wheel"])
        window.removeEventListener(ev, activity);
    };
  }, [conn]);
}
