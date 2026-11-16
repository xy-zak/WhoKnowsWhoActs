import { useEffect, useState } from "react";
import { useStore } from "../net/store";
import type { FacilitatorConnection } from "./connection";
import { DataPanel } from "./Data";
import { Live } from "./Live";
import { Replay } from "./Replay";
import { Setup } from "./Setup";

type Tab = "live" | "setup" | "data" | "replay";

export function App({ conn }: { conn: FacilitatorConnection }) {
  const fs = useStore(conn.store);
  const st = fs.dashboard?.state ?? null;
  const [tab, setTab] = useState<Tab>("live");
  const [replayId, setReplayId] = useState<string | null>(null);
  const [chosen, setChosen] = useState(false);

  // first load: go to Setup if nothing is attached
  useEffect(() => {
    if (!chosen && fs.dashboard) {
      setTab(fs.dashboard.state ? "live" : "setup");
      setChosen(true);
    }
  }, [fs.dashboard, chosen]);

  if (fs.authError) {
    return (
      <div style={{ padding: "3rem", maxWidth: 640 }} className="col">
        <h1>Facilitator access denied</h1>
        <p>
          The dashboard only works on the server computer itself (
          <code>http://localhost:PORT/facilitator</code>), or from another device when the server was started
          with <code>ADMIN_TOKEN</code> and you open <code>/facilitator?token=…</code>.
        </p>
      </div>
    );
  }

  const tabs: Array<[Tab, string]> = [
    ["live", "Live"],
    ["setup", "Setup"],
    ["data", "Sessions & data"],
    ["replay", "Replay"],
  ];
  return (
    <div style={{ padding: 10 }} className="col">
      <header className="row panel" style={{ padding: "0.5rem 0.9rem" }}>
        <strong style={{ fontSize: "1.1rem" }}>WhoKnowsWhoActs · Facilitator</strong>
        {st ? (
          <>
            <span className="mono">{st.sessionId}</span>
            <span className="pill">{st.phase.replace("_", " ")}</span>
            {st.round > 0 && (
              <span className="pill">
                round {st.round}/{st.config.roundCount}
              </span>
            )}
            {st.paused && <span className="pill bad">paused</span>}
            {st.config.condition && <span className="pill">condition: {st.config.condition}</span>}
          </>
        ) : (
          <span className="muted">no session attached</span>
        )}
        <span className="spacer" />
        {!fs.connected && <span className="pill bad">server connection lost</span>}
        <nav className="row" style={{ gap: 4 }}>
          {tabs.map(([t, label]) => (
            <button key={t} type="button" className={tab === t ? "primary" : ""} onClick={() => setTab(t)}>
              {label}
            </button>
          ))}
        </nav>
      </header>
      {tab === "live" && <Live conn={conn} />}
      {tab === "setup" && (
        <Setup conn={conn} hasLiveSession={Boolean(fs.dashboard?.live)} onCreated={() => setTab("live")} />
      )}
      {tab === "data" && (
        <DataPanel
          conn={conn}
          attachedId={st?.sessionId ?? null}
          onResumed={() => setTab("live")}
          onReplay={(id) => {
            setReplayId(id);
            setTab("replay");
          }}
        />
      )}
      {tab === "replay" && (
        <Replay conn={conn} sessionId={replayId} onPick={(id) => setReplayId(id || null)} />
      )}
      {fs.toast && (
        <div className="toast" style={{ background: fs.toast.kind === "error" ? "var(--danger)" : "#222" }}>
          {fs.toast.text}
        </div>
      )}
    </div>
  );
}
