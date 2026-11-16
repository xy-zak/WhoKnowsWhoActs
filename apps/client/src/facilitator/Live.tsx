import {
  type DashboardMsg,
  type GameState,
  isOnboardingComplete,
  K_LABELS,
  type KLabel,
  P_LABELS,
  type PLabel,
  quotaLimit,
  quotaUsed,
  roundActiveMs,
  roundRemainingMs,
  type Scenario,
  SEAT_COLOURS,
  seatList,
} from "@wkwa/shared";
import { useEffect, useState } from "react";
import { fmtDuration } from "../common/format";
import { useStore } from "../net/store";
import { CompositeMap, PlayerMirrors } from "./Composite";
import type { FacilitatorConnection } from "./connection";
import { EventLog, TelemetryFeed } from "./EventLog";
import { Timeline } from "./Timeline";

function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** Button that needs a second click to confirm (no browser dialogs). */
export function ConfirmButton({
  label,
  confirmLabel = "Click again to confirm",
  onConfirm,
  className = "",
  disabled,
}: {
  label: string;
  confirmLabel?: string;
  onConfirm: () => void;
  className?: string;
  disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      type="button"
      className={armed ? "danger" : className}
      disabled={disabled}
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else setArmed(true);
      }}
    >
      {armed ? confirmLabel : label}
    </button>
  );
}

function canStartReason(st: GameState): string | null {
  if (st.phase === "onboarding") {
    const waiting = seatList(st)
      .filter((s) => s.bound && !s.withdrawn && !isOnboardingComplete(st, s))
      .map((s) => `${s.seat}${s.consent === "declined" ? " (declined — withdraw or replace)" : ""}`);
    return waiting.length ? `Waiting for onboarding: seat ${waiting.join(", ")}` : null;
  }
  if (st.phase === "round_complete") return st.round < st.config.roundCount ? null : "All rounds played";
  return "—";
}

function Controls({ conn, st }: { conn: FacilitatorConnection; st: GameState }) {
  const [broadcast, setBroadcast] = useState("");
  const [note, setNote] = useState("");
  const [abortReason, setAbortReason] = useState("");
  const now = useNow();
  const seats = seatList(st);
  const unbound = seats.filter((s) => !s.bound).length;
  const unlabelled = seats.filter((s) => !s.k || !s.p).length;
  const startWhy = canStartReason(st);
  const remaining = roundRemainingMs(st, now);
  const run = (name: string, payload: unknown = {}, ok?: string) =>
    void conn.cmd(name, payload, ok).catch(() => {});

  return (
    <div className="panel col">
      <div className="row">
        <strong>Session flow</strong>
        <span className="spacer" />
        {st.createdTs && <span className="small muted">session {fmtDuration(now - st.createdTs)}</span>}
        {st.phase === "round_active" && (
          <span className="pill">
            round time {fmtDuration(roundActiveMs(st, now))}
            {remaining !== null && ` · ${fmtDuration(remaining)} left`}
          </span>
        )}
      </div>
      <div className="row">
        {st.phase === "lobby" && (
          <>
            <button
              type="button"
              className="primary big"
              disabled={unbound > 0 || unlabelled > 0}
              onClick={() => run("onboarding:start", {}, "Onboarding started")}
            >
              Start onboarding
            </button>
            <span className="small muted">
              {unbound > 0 ? `Bind ${unbound} more seat(s). ` : ""}
              {unlabelled > 0 ? "Assign labels. " : ""}
              Seats are locked once onboarding starts.
            </span>
          </>
        )}
        {(st.phase === "onboarding" || st.phase === "round_complete") && (
          <>
            <button
              type="button"
              className="primary big"
              disabled={startWhy !== null}
              onClick={() => run("round:start", {}, `Round ${st.round + 1} started`)}
            >
              Start round {st.round + 1} of {st.config.roundCount}
            </button>
            {startWhy && <span className="small muted">{startWhy}</span>}
            {st.phase === "round_complete" && st.config.roundAdvance === "auto" && (
              <span className="small muted">(auto-advance after {st.config.autoAdvanceDelaySec} s)</span>
            )}
          </>
        )}
        {st.phase === "round_active" && (
          <>
            {st.paused ? (
              <button type="button" className="primary big" onClick={() => run("game:resume", {}, "Resumed")}>
                ▶ Resume
              </button>
            ) : (
              <button type="button" className="big" onClick={() => run("game:pause", {}, "Paused")}>
                ⏸ Pause
              </button>
            )}
            <ConfirmButton label="End round now" onConfirm={() => run("round:end", {}, "Round ended")} />
            {st.paused && (
              <span className="pill bad">
                paused{st.pauseReason === "disconnect" ? " — a player disconnected" : ""}
              </span>
            )}
          </>
        )}
        {st.phase === "game_complete" && (
          <>
            <span className="pill ok">Game complete</span>
            <ConfirmButton
              label="Close session"
              onConfirm={() => run("session:close", {}, "Session closed")}
            />
            <span className="small muted">
              Hand out takedown cards and export the data (Data tab) before closing.
            </span>
          </>
        )}
        {(st.phase === "closed" || st.phase === "aborted") && (
          <span className="pill">Session {st.phase}. Create a new session in the Setup tab.</span>
        )}
      </div>
      {["onboarding", "round_active", "round_complete"].includes(st.phase) && (
        <div className="row">
          <ConfirmButton
            label="End game early"
            className="danger"
            onConfirm={() => run("game:end", {}, "Game ended")}
          />
        </div>
      )}
      {!["closed", "aborted"].includes(st.phase) && (
        <>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              if (broadcast.trim())
                conn.cmd("broadcast", { text: broadcast.trim() }, "Message sent").then(
                  () => setBroadcast(""),
                  () => {},
                );
            }}
          >
            <input
              type="text"
              value={broadcast}
              maxLength={300}
              onChange={(e) => setBroadcast(e.target.value)}
              placeholder="Message to all players…"
              style={{ flex: 1 }}
            />
            <button type="submit" disabled={!broadcast.trim()}>
              Broadcast
            </button>
          </form>
          <details>
            <summary className="small">Abort session…</summary>
            <div className="row" style={{ marginTop: 6 }}>
              <input
                type="text"
                value={abortReason}
                maxLength={200}
                onChange={(e) => setAbortReason(e.target.value)}
                placeholder="Reason (no names)"
                style={{ flex: 1 }}
              />
              <ConfirmButton
                label="Abort"
                className="danger"
                onConfirm={() => run("session:abort", { reason: abortReason }, "Session aborted")}
              />
            </div>
          </details>
        </>
      )}
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (note.trim())
            conn.cmd("note", { text: note.trim() }, "Note added").then(
              () => setNote(""),
              () => {},
            );
        }}
      >
        <input
          type="text"
          value={note}
          maxLength={500}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Facilitator note for the log — never type names"
          style={{ flex: 1 }}
        />
        <button type="submit" disabled={!note.trim()}>
          Add note
        </button>
      </form>
    </div>
  );
}

type Draft = Record<number, { k: KLabel | ""; p: PLabel | ""; view: string }>;

function SeatsPanel({
  conn,
  dash,
  scenario,
}: {
  conn: FacilitatorConnection;
  dash: DashboardMsg;
  scenario: Scenario | null;
}) {
  const st = dash.state!;
  const now = useNow();
  const seats = seatList(st);
  const free = dash.terminals.filter((t) => t.connected && t.seat === null);
  const labelsEditable = ["lobby", "onboarding", "round_complete"].includes(st.phase);
  const manualView = st.config.viewAssignment === "manual";
  const fromState = (): Draft =>
    Object.fromEntries(seats.map((s) => [s.seat, { k: s.k ?? "", p: s.p ?? "", view: s.view ?? "" }]));
  const [draft, setDraft] = useState<Draft>(fromState);
  const [dirty, setDirty] = useState(false);
  const stateKey = seats.map((s) => `${s.k}${s.p}${s.view}`).join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-sync when labels change on the server
  useEffect(() => {
    if (!dirty) setDraft(fromState());
  }, [stateKey, dirty]);
  const setField = (seat: number, field: "k" | "p" | "view", v: string) => {
    setDirty(true);
    setDraft((d) => ({ ...d, [seat]: { ...d[seat]!, [field]: v } }));
  };
  const apply = () => {
    const assignments = seats.map((s) => ({
      seat: s.seat,
      k: draft[s.seat]!.k,
      p: draft[s.seat]!.p,
      ...(manualView ? { view: draft[s.seat]!.view } : {}),
    }));
    if (assignments.some((a) => !a.k || !a.p))
      return conn.toast("Choose a K and P label for every seat", "error");
    conn.cmd("labels:set", { assignments }, "Labels saved").then(
      () => setDirty(false),
      () => {},
    );
  };

  return (
    <div className="panel col">
      <div className="row">
        <strong>Seats</strong>
        {st.phase === "lobby" && free.length > 0 && (
          <span className="small muted">
            Unassigned terminals:{" "}
            {free.map((t) => (
              <span key={t.terminal} className="pill" style={{ marginRight: 4 }}>
                T{t.terminal}
              </span>
            ))}
          </span>
        )}
        <span className="spacer" />
        {labelsEditable && (
          <>
            <button
              type="button"
              onClick={() =>
                conn.cmd("labels:randomise", {}, "Labels randomised").then(
                  () => setDirty(false),
                  () => {},
                )
              }
            >
              🎲 Randomise labels
            </button>
            <button type="button" className={dirty ? "primary" : ""} disabled={!dirty} onClick={apply}>
              Save labels
            </button>
          </>
        )}
      </div>
      <div style={{ overflowX: "auto" }}>
        <table className="grid">
          <thead>
            <tr>
              <th>Seat</th>
              <th>Terminal</th>
              <th>Participant code</th>
              <th>K</th>
              <th>P</th>
              <th>View</th>
              <th>Onboarding</th>
              <th>Progress</th>
              <th>Activity</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {seats.map((s) => {
              const stats = dash.stats[s.seat];
              const d = draft[s.seat] ?? { k: "", p: "", view: "" };
              const pLim = quotaLimit(st, "propose");
              const dLim = quotaLimit(st, "decide");
              return (
                <tr key={s.seat}>
                  <td>
                    <span className="seat-dot" style={{ background: SEAT_COLOURS[s.seat] }} />{" "}
                    <strong>{s.seat}</strong>
                  </td>
                  <td>
                    {s.bound ? (
                      <>
                        T{s.terminal}{" "}
                        {s.withdrawn ? (
                          <span className="pill">withdrawn</span>
                        ) : s.connected ? (
                          <span className="pill ok">online</span>
                        ) : (
                          <span className="pill bad">offline</span>
                        )}
                      </>
                    ) : st.phase === "lobby" ? (
                      <select
                        value=""
                        onChange={(e) =>
                          e.target.value &&
                          void conn
                            .cmd(
                              "seat:bind",
                              { terminal: Number(e.target.value), seat: s.seat },
                              `Seat ${s.seat} bound`,
                            )
                            .catch(() => {})
                        }
                      >
                        <option value="">bind terminal…</option>
                        {free.map((t) => (
                          <option key={t.terminal} value={t.terminal}>
                            Terminal {t.terminal}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="mono small">{s.participantCode ?? <span className="muted">—</span>}</td>
                  <td>
                    {labelsEditable ? (
                      <select value={d.k} onChange={(e) => setField(s.seat, "k", e.target.value)}>
                        <option value="">–</option>
                        {K_LABELS.map((k) => (
                          <option key={k}>{k}</option>
                        ))}
                      </select>
                    ) : (
                      s.k
                    )}
                  </td>
                  <td>
                    {labelsEditable ? (
                      <select value={d.p} onChange={(e) => setField(s.seat, "p", e.target.value)}>
                        <option value="">–</option>
                        {P_LABELS.map((p) => (
                          <option key={p}>{p}</option>
                        ))}
                      </select>
                    ) : (
                      s.p
                    )}
                  </td>
                  <td className="small">
                    {labelsEditable && manualView ? (
                      <select value={d.view} onChange={(e) => setField(s.seat, "view", e.target.value)}>
                        <option value="">–</option>
                        {Object.keys(scenario?.views ?? {}).map((v) => (
                          <option key={v}>{v}</option>
                        ))}
                      </select>
                    ) : s.view ? (
                      `${s.view} · ${scenario?.views[s.view]?.name ?? ""}`
                    ) : (
                      "–"
                    )}
                  </td>
                  <td className="small">
                    {st.phase === "lobby" || !s.bound ? (
                      <span className="muted">—</span>
                    ) : (
                      <span className="row" style={{ gap: 3 }}>
                        <span
                          className={`pill ${s.consent === "given" || s.consent === "skipped" ? "ok" : s.consent === "declined" ? "bad" : ""}`}
                        >
                          consent {s.consent}
                        </span>
                        <span className={`pill ${s.demographics ? "ok" : ""}`}>
                          demo {s.demographics ? "✓" : "…"}
                        </span>
                        <span className={`pill ${s.briefing ? "ok" : ""}`}>
                          brief {s.briefing ? "✓" : "…"}
                        </span>
                      </span>
                    )}
                  </td>
                  <td className="small">
                    {st.round > 0 && s.bound ? (
                      <>
                        P {quotaUsed(st, s.seat, "propose")}/{pLim ?? "∞"} · D{" "}
                        {quotaUsed(st, s.seat, "decide")}/{dLim ?? "∞"}
                        {s.rejections > 0 && <span className="muted"> · {s.rejections} rejected</span>}
                      </>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="small">
                    {stats && s.bound ? (
                      <span className="row" style={{ gap: 3 }}>
                        {stats.screen && <span className="pill">{stats.screen}</span>}
                        {stats.focused === false && <span className="pill warn">unfocused</span>}
                        {stats.visible === false && <span className="pill bad">tab hidden</span>}
                        {stats.idle && <span className="pill warn">idle</span>}
                        {s.lastActionTs && (
                          <span className="muted">last action {fmtDuration(now - s.lastActionTs)} ago</span>
                        )}
                        {stats.rttMs !== null && <span className="muted">· {stats.rttMs} ms</span>}
                        {s.reconnects > 0 && <span className="muted">· {s.reconnects} reconnects</span>}
                      </span>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>
                    {st.phase === "lobby" && s.bound && (
                      <button
                        type="button"
                        className="small"
                        onClick={() =>
                          void conn
                            .cmd("seat:unbind", { seat: s.seat, reason: "facilitator" }, "Unbound")
                            .catch(() => {})
                        }
                      >
                        Unbind
                      </button>
                    )}
                    {st.phase !== "lobby" &&
                      s.bound &&
                      !s.withdrawn &&
                      !["closed", "aborted"].includes(st.phase) && (
                        <ConfirmButton
                          label="Withdraw"
                          confirmLabel="Confirm withdraw"
                          className="small"
                          onConfirm={() =>
                            void conn
                              .cmd("participant:withdraw", { seat: s.seat }, "Withdrawn")
                              .catch(() => {})
                          }
                        />
                      )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {st.phase === "lobby" && free.length === 0 && seats.some((s) => !s.bound) && (
        <span className="small muted">
          Waiting for player browsers to connect. Each shows its terminal number in large type.
        </span>
      )}
    </div>
  );
}

export function Live({ conn }: { conn: FacilitatorConnection }) {
  const fs = useStore(conn.store);
  const now = useNow(1000);
  const dash = fs.dashboard;
  const st = dash?.state;
  const scenario = fs.scenario;
  if (!dash || !st)
    return <div className="panel">No session attached. Create one in Setup, or resume one in Data.</div>;
  const regionName = (id: string) => scenario?.regions.find((r) => r.id === id)?.name ?? id;
  const revoke = (seq: number) =>
    void conn.cmd("action:revoke", { seq, reason: "facilitator" }, `Action #${seq} revoked`).catch(() => {});
  const boundSeats = seatList(st)
    .filter((s) => s.bound || s.withdrawn)
    .map((s) => s.seat);
  return (
    <div className="col" style={{ gap: 10 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(320px, 420px) minmax(0, 1fr)",
          gap: 10,
          alignItems: "start",
        }}
      >
        <Controls conn={conn} st={st} />
        <SeatsPanel conn={conn} dash={dash} scenario={scenario} />
      </div>
      {scenario && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 3fr) minmax(0, 2fr)",
            gap: 10,
            alignItems: "start",
          }}
        >
          <CompositeMap scenario={scenario} state={st} presence={fs.presence} onRevoke={revoke} />
          <PlayerMirrors scenario={scenario} state={st} presence={fs.presence} now={now} />
        </div>
      )}
      <Timeline events={fs.events} seats={boundSeats} now={now} />
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 3fr) minmax(0, 2fr)",
          gap: 10,
          alignItems: "start",
        }}
      >
        <EventLog events={fs.events} state={st} regionName={regionName} onRevoke={revoke} />
        <TelemetryFeed items={fs.telemetry} regionName={regionName} />
      </div>
    </div>
  );
}
