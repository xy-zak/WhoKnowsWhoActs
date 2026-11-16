import { useEffect, useState } from "react";
import { fmtDuration } from "../common/format";
import { useStore } from "../net/store";
import {
  Button,
  Icon,
  type IconName,
  Popup,
  setPrefs,
  THEME_LABEL,
  THEME_NAMES,
  type ThemeName,
  ToastView,
  usePrefs,
  useShortcuts,
  useSignalClass,
} from "../ui";
import type { FacilitatorConnection } from "./connection";
import { Database } from "./Database";
import { LiveStage } from "./live/LiveStage";
import { Replay } from "./Replay";
import { SetupStage } from "./setup/SetupStage";
import { PHASE_LABEL, stageOf } from "./stage";

type Tab = "main" | "replay" | "database";

const THEME_ICON: Record<ThemeName, IconName> = {
  latte: "themeLight",
  mocha: "themeDark",
  contrast: "themeContrast",
};
const nextTheme = (t: ThemeName): ThemeName =>
  THEME_NAMES[(THEME_NAMES.indexOf(t) + 1) % THEME_NAMES.length]!;

export const SHORTCUTS_HELP: Array<[string, string]> = [
  ["1", "SETUP / LIVE tab"],
  ["2", "REPLAY tab"],
  ["3", "DATABASE tab"],
  ["N", "Next action (setup: resume the current step · live: the NEXT panel's action)"],
  ["P", "Pause / resume the round (live)"],
  ["T", "Next theme: Latte → Mocha → High contrast"],
  ["A", "Animations on/off (tab switches, popups, connect/disconnect)"],
  ["?", "This help"],
  ["Enter", "Primary action in a popup"],
  ["Esc", "Close a popup (setup progress is kept)"],
];

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function App({ conn }: { conn: FacilitatorConnection }) {
  const fs = useStore(conn.store);
  const prefs = usePrefs();
  const [tab, setTab] = useState<Tab>("main");
  const [replayId, setReplayId] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const now = useNow();
  const st = fs.dashboard?.state ?? null;
  const stage = stageOf(st);
  const isLive = stage === "live";
  const signal = useSignalClass(fs.connected);

  useShortcuts([
    { key: "1", label: "SETUP/LIVE", run: () => setTab("main") },
    { key: "2", label: "REPLAY", run: () => setTab("replay") },
    { key: "3", label: "DATABASE", run: () => setTab("database") },
    { key: "t", label: "theme", run: () => setPrefs({ theme: nextTheme(prefs.theme) }) },
    { key: "a", label: "animations", run: () => setPrefs({ animations: !prefs.animations }) },
    { key: "?", label: "help", run: () => setHelp(true) },
  ]);

  if (fs.authError) {
    return (
      <div className="screen-center">
        <div className="panel col" style={{ maxWidth: 640 }}>
          <span className="panel-title">
            <Icon name="warning" /> ACCESS DENIED
          </span>
          <p>
            The facilitator manager only opens on the server computer itself (
            <code>http://localhost:PORT/facilitator</code>), or from another device when the server was
            started with <code>ADMIN_TOKEN</code> and you open <code>/facilitator?token=…</code>.
          </p>
        </div>
      </div>
    );
  }

  const online = st ? Object.values(st.seats).filter((s) => s.connected).length : 0;
  const bound = st ? Object.values(st.seats).filter((s) => s.bound).length : 0;

  return (
    <div className="app-shell col" style={{ gap: "var(--s2)" }}>
      <header className="topbar">
        <span className="brand">WhoKnowsWhoActs</span>
        <span className="faint">│</span>
        <span className="muted small upper">Facilitator</span>
        {isLive && st && (
          <button
            type="button"
            className="live-indicator"
            onClick={() => setTab("main")}
            title="Go to the live session"
          >
            <span className="live-dot" /> LIVE <span className="mono">{st.sessionId}</span>
          </button>
        )}
        <span className="spacer" />
        <nav className="tabs" aria-label="Sections">
          <button
            type="button"
            className={`tab${tab === "main" ? " active" : ""}`}
            onClick={() => setTab("main")}
          >
            <kbd>1</kbd>
            <Icon name={isLive ? "live" : "setup"} />
            {isLive ? "LIVE" : "SETUP"}
          </button>
          <button
            type="button"
            className={`tab${tab === "replay" ? " active" : ""}`}
            onClick={() => setTab("replay")}
          >
            <kbd>2</kbd>
            <Icon name="replay" />
            REPLAY
          </button>
          <button
            type="button"
            className={`tab${tab === "database" ? " active" : ""}`}
            onClick={() => setTab("database")}
          >
            <kbd>3</kbd>
            <Icon name="database" />
            DATABASE
          </button>
        </nav>
      </header>

      {/* key → remount on tab/stage change, which plays the CRT screen-switch animation */}
      <main key={`${tab}-${stage}`} className={`screen-switch ${signal}`}>
        {tab === "main" && (stage === "live" ? <LiveStage conn={conn} /> : <SetupStage conn={conn} />)}
        {tab === "replay" && (
          <Replay conn={conn} sessionId={replayId} onPick={(id) => setReplayId(id || null)} />
        )}
        {tab === "database" && (
          <Database
            conn={conn}
            attachedId={st?.sessionId ?? null}
            onResumed={() => setTab("main")}
            onReplay={(id) => {
              setReplayId(id);
              setTab("replay");
            }}
          />
        )}
      </main>

      <footer className="statusbar">
        <span className="seg conn-flicker" key={fs.connected ? "on" : "off"}>
          <Icon name={fs.connected ? "connected" : "disconnected"} />
          <strong className={fs.connected ? "t-live" : "t-danger"}>
            {fs.connected ? "ONLINE" : "OFFLINE — reconnecting"}
          </strong>
        </span>
        <span className="seg">
          SESSION <strong>{st?.sessionId ?? "—"}</strong>
        </span>
        {st && (
          <span className="seg">
            <strong>{PHASE_LABEL[st.phase]}</strong>
            {st.round > 0 && ` ${st.round}/${st.config.roundCount}`}
            {st.paused && <strong className="t-warn"> PAUSED</strong>}
          </span>
        )}
        {st?.createdTs && (
          <span className="seg">
            <Icon name="clock" /> {fmtDuration(now - st.createdTs)}
          </span>
        )}
        {st && (
          <span className="seg">
            <Icon name="seats" /> {online}/{st.config.seatCount} online
            {bound < st.config.seatCount ? ` · ${bound} bound` : ""}
          </span>
        )}
        {st && st.config.tags.length > 0 && (
          <span className="seg">
            <Icon name="tag" /> {st.config.tags.join(", ")}
          </span>
        )}
        <span className="spacer" />
        <button
          type="button"
          className="seg"
          onClick={() => setPrefs({ theme: nextTheme(prefs.theme) })}
          title="Next theme (T)"
        >
          <Icon name={THEME_ICON[prefs.theme]} /> <kbd>T</kbd> {THEME_LABEL[prefs.theme].toUpperCase()}
        </button>
        <button
          type="button"
          className="seg"
          onClick={() => setPrefs({ animations: !prefs.animations })}
          title="Animations on/off (A)"
        >
          <Icon name="animations" /> <kbd>A</kbd> ANIMATIONS {prefs.animations ? "ON" : "OFF"}
        </button>
        <button type="button" className="seg" onClick={() => setHelp(true)} title="Keyboard shortcuts (?)">
          <Icon name="help" /> <kbd>?</kbd> HELP
        </button>
      </footer>

      {help && (
        <Popup
          title="Keyboard shortcuts"
          icon="help"
          width={560}
          onClose={() => setHelp(false)}
          footer={
            <>
              <span className="spacer" />
              <Button variant="primary" kbd="Enter" onClick={() => setHelp(false)}>
                Close
              </Button>
            </>
          }
          onPrimary={() => setHelp(false)}
        >
          <table className="grid">
            <tbody>
              {SHORTCUTS_HELP.map(([k, d]) => (
                <tr key={k}>
                  <td style={{ width: 80 }}>
                    <kbd>{k}</kbd>
                  </td>
                  <td>{d}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small muted">
            Single-key shortcuts are ignored while you type in a field or while a popup is open.
          </p>
        </Popup>
      )}
      <ToastView toast={fs.toast} />
    </div>
  );
}
