import { fakeSeats, isSimulated } from "@wkwa/shared";
import { useEffect, useState } from "react";
import { fmtDuration } from "../common/format";
import { useStore } from "../net/store";
import {
  Button,
  DisplaySettings,
  FONT_LABEL,
  facilitatorPrefs,
  Icon,
  nextFont,
  nextScale,
  nextTheme,
  Popup,
  SCALE_LABEL,
  StatusTag,
  THEME_LABEL,
  ToastView,
  TooltipLayer,
  useDisplayPrefs,
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

const setPrefs = facilitatorPrefs.set;

export const SHORTCUTS_HELP: Array<[string, string]> = [
  ["1", "SETUP / LIVE tab"],
  ["2", "REPLAY tab"],
  ["3", "DATABASE tab"],
  ["N", "Next action (setup: resume the current step · live: the NEXT panel's action)"],
  ["P", "Pause / resume the round (live)"],
  ["D", "Display settings (colours, font, text size, animations)"],
  ["T", "Next colour theme: Latte → Mocha → High contrast"],
  ["F", "Next font: JetBrains Mono → OpenDyslexic → System font"],
  ["S", "Text size: Small ↔ Large"],
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
  const prefs = useDisplayPrefs(facilitatorPrefs);
  const [tab, setTab] = useState<Tab>("main");
  const [replayId, setReplayId] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const [display, setDisplay] = useState(false);
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
    { key: "f", label: "font", run: () => setPrefs({ font: nextFont(prefs.font) }) },
    { key: "s", label: "text size", run: () => setPrefs({ scale: nextScale(prefs.scale) }) },
    { key: "a", label: "animations", run: () => setPrefs({ animations: !prefs.animations }) },
    { key: "d", label: "display", run: () => setDisplay(true) },
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
  const simulated = st ? isSimulated(st) : false;
  const agents = st ? Object.values(st.seats).filter((s) => s.agent && !s.withdrawn).length : 0;
  const fakes = st ? fakeSeats(st).length : 0;

  return (
    <div className="app-shell col" style={{ gap: "var(--s2)" }}>
      <header className="topbar">
        <span className="brand">Who Knows, Who Acts?</span>
        <span className="faint">│</span>
        <span className="muted small upper">Facilitator</span>
        {isLive && st && (
          <button
            type="button"
            className="live-indicator"
            onClick={() => setTab("main")}
            data-tip="Go to the live session"
          >
            <span className="live-dot" /> LIVE <span className="mono">{st.sessionId}</span>
          </button>
        )}
        {simulated && (
          <StatusTag
            icon="simulation"
            title="Simulated players: agents play every seat (simulation database)"
          >
            SIMULATION
          </StatusTag>
        )}
        {fakes > 0 && st && !["closed", "aborted"].includes(st.phase) && (
          <StatusTag
            icon="fake"
            title="This session has fake players: test clients the server created (marked fake in the log and exports)"
          >
            FAKE PLAYERS ×{fakes}
          </StatusTag>
        )}
        <span className="spacer" />
        <nav className="tabs" aria-label="Sections">
          <button
            type="button"
            className={`tab${tab === "main" ? " active" : ""}`}
            onClick={() => setTab("main")}
            data-tip={isLive ? "Run the live session (1)" : "Set up a new session (1)"}
          >
            <kbd>1</kbd>
            <Icon name={isLive ? "live" : "setup"} />
            {isLive ? "LIVE" : "SETUP"}
          </button>
          <button
            type="button"
            className={`tab${tab === "replay" ? " active" : ""}`}
            onClick={() => setTab("replay")}
            data-tip="Step through a recorded session event by event (2)"
          >
            <kbd>2</kbd>
            <Icon name="replay" />
            REPLAY
          </button>
          <button
            type="button"
            className={`tab${tab === "database" ? " active" : ""}`}
            onClick={() => setTab("database")}
            data-tip="Stored sessions, exports and erasure requests (3)"
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
        {st && simulated && (
          <span className="seg">
            <Icon name="agent" /> {agents}/{st.config.seatCount} agents
          </span>
        )}
        {st && !simulated && (
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
          onClick={() => setDisplay(true)}
          data-tip="Display settings (D): colours T · font F · text size S · animations A"
        >
          <Icon name="display" /> <kbd>D</kbd> {THEME_LABEL[prefs.theme].toUpperCase()} ·{" "}
          {FONT_LABEL[prefs.font].toUpperCase()} · {SCALE_LABEL[prefs.scale].toUpperCase()}
          {prefs.animations ? "" : " · NO ANIM"}
        </button>
        <button type="button" className="seg" onClick={() => setHelp(true)} data-tip="Keyboard shortcuts (?)">
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
      {display && (
        <Popup
          title="Display settings"
          icon="display"
          width={560}
          onClose={() => setDisplay(false)}
          footer={
            <>
              <span className="hint">Only in this browser. Shortcuts: T · F · S · A</span>
              <span className="spacer" />
              <Button variant="primary" kbd="Enter" onClick={() => setDisplay(false)}>
                Done
              </Button>
            </>
          }
          onPrimary={() => setDisplay(false)}
        >
          <DisplaySettings prefs={prefs} onChange={setPrefs} />
          <p className="small muted">
            Each player chooses their own display settings on their screen (the <strong>DISPLAY</strong>{" "}
            button, bottom right). They are never sent to the server or recorded.
          </p>
        </Popup>
      )}
      <ToastView toast={fs.toast} />
      <TooltipLayer />
    </div>
  );
}
