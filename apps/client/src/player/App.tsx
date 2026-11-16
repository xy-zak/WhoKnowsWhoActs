import type { PlayerView } from "@wkwa/shared";
import { useEffect, useMemo, useRef } from "react";
import { useStore } from "../net/store";
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

  // screen_view telemetry
  const lastScreen = useRef<string | null>(null);
  useEffect(() => {
    if (st.seat !== null && lastScreen.current !== screen) {
      lastScreen.current = screen;
      conn.track("screen_view", { screen });
    }
  }, [screen, st.seat, conn]);

  useGlobalTelemetry(conn);

  const body = useMemo(() => {
    const v = st.view;
    switch (screen) {
      case "waiting":
        return <Waiting terminal={st.terminal} connected={st.connected} notice={st.notice} />;
      case "lobby":
        return (
          <Centered>
            <h1>Welcome</h1>
            <p>
              You are <strong>seat {st.seat}</strong>.
            </p>
            <p className="muted">Please wait — the session will start shortly.</p>
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
          <Centered>
            <h1>You're all set</h1>
            <p className="muted">
              Waiting for the other players ({ready}/{total} ready) and for the facilitator to start round 1.
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
        <div className="overlay">
          <div className="panel">
            <h2>Connection lost</h2>
            <p className="muted">Reconnecting to the game server… Please do not close this window.</p>
          </div>
        </div>
      )}
      {body}
      {st.toast && <div className="toast">{st.toast}</div>}
    </>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: "100%", display: "grid", placeItems: "center", padding: "2rem" }}>
      <div className="panel" style={{ maxWidth: 640, width: "100%", textAlign: "center", padding: "2rem" }}>
        {children}
      </div>
    </div>
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
    <Centered>
      <p className="muted" style={{ margin: 0 }}>
        Terminal
      </p>
      <div style={{ fontSize: "7rem", fontWeight: 800, lineHeight: 1.1 }}>{terminal ?? "…"}</div>
      <p className="muted">
        {connected
          ? "Connected. Please wait for the facilitator to assign you a seat."
          : "Connecting to the game server…"}
      </p>
      {notice && <p className="small muted">({notice})</p>}
    </Centered>
  );
}

function EndScreen({ view, withdrawn }: { view: PlayerView; withdrawn: boolean }) {
  const study = view.study;
  return (
    <Centered>
      <h1>{withdrawn ? "You have stopped participating" : "Thank you for taking part!"}</h1>
      {!withdrawn && view.phase === "aborted" && <p className="muted">The session was ended early.</p>}
      {view.me.participantCode && (
        <>
          <p>Your personal participant code is:</p>
          <div
            className="mono"
            style={{
              fontSize: "2rem",
              fontWeight: 700,
              letterSpacing: "0.08em",
              padding: "0.5rem 1rem",
              border: "2px dashed var(--border)",
              borderRadius: 8,
              display: "inline-block",
            }}
          >
            {view.me.participantCode}
          </div>
          <p className="small muted" style={{ marginTop: "1rem" }}>
            {study?.takedownInstructions ??
              "Keep this code. Quote it if you want your data removed from the study."}
          </p>
          {study && (
            <p className="small">
              Contact: <strong>{study.researcher}</strong> — {study.contactEmail}
            </p>
          )}
        </>
      )}
      <p className="muted">You may now let the facilitator know you are finished.</p>
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
