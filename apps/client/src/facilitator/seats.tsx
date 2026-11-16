import {
  type DashboardMsg,
  type GameState,
  isOnboardingComplete,
  K_LABELS,
  type KLabel,
  nextOnboardingStep,
  P_LABELS,
  type PLabel,
  quotaLimit,
  quotaUsed,
  type Scenario,
  seatList,
} from "@wkwa/shared";
import { useEffect, useState } from "react";
import { fmtDuration } from "../common/format";
import { AsciiProgress, Button, Callout, Icon, Panel, SeatDot, StatusTag, useConfirm } from "../ui";
import type { FacilitatorConnection } from "./connection";

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/* ─────────────────────────── Bind terminals → seats (setup step 7) ─────────────────────────── */

export function BindEditor({ conn, dash }: { conn: FacilitatorConnection; dash: DashboardMsg }) {
  const st = dash.state!;
  const seats = seatList(st);
  const free = dash.terminals.filter((t) => t.connected && t.seat === null);
  const bound = seats.filter((s) => s.bound).length;
  return (
    <div className="col">
      <div className="row">
        <StatusTag tone={bound === seats.length ? "live" : "warn"} icon="seats">
          {bound}/{seats.length} seats bound
        </StatusTag>
        <StatusTag tone={free.length ? "primary" : "neutral"} icon="terminal">
          {free.length} unassigned terminal{free.length === 1 ? "" : "s"}
        </StatusTag>
      </div>
      <table className="grid">
        <thead>
          <tr>
            <th>Seat</th>
            <th>Terminal</th>
            <th>Participant code</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {seats.map((s) => (
            <tr key={s.seat}>
              <td>
                <span className="row nowrap">
                  <SeatDot seat={s.seat} /> <strong>SEAT {s.seat}</strong>
                </span>
              </td>
              <td>
                {s.bound ? (
                  <span className="row nowrap">
                    <Icon name="terminal" /> T{s.terminal}{" "}
                    {s.connected ? (
                      <StatusTag tone="live">online</StatusTag>
                    ) : (
                      <StatusTag tone="danger">offline</StatusTag>
                    )}
                  </span>
                ) : (
                  <select
                    aria-label={`Bind a terminal to seat ${s.seat}`}
                    value=""
                    disabled={free.length === 0}
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
                    <option value="">{free.length ? "bind terminal…" : "waiting for terminals…"}</option>
                    {free.map((t) => (
                      <option key={t.terminal} value={t.terminal}>
                        Terminal {t.terminal}
                      </option>
                    ))}
                  </select>
                )}
              </td>
              <td className="mono">{s.participantCode ?? <span className="faint">—</span>}</td>
              <td style={{ textAlign: "right" }}>
                {s.bound && (
                  <Button
                    size="sm"
                    icon="withdraw"
                    onClick={() =>
                      void conn
                        .cmd("seat:unbind", { seat: s.seat, reason: "facilitator" }, "Unbound")
                        .catch(() => {})
                    }
                  >
                    Unbind
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {free.length === 0 && bound < seats.length && (
        <Callout icon="terminal">
          Open the player URL on each PC. Each screen shows its <strong>terminal number</strong> in large
          type, then appears here.
        </Callout>
      )}
    </div>
  );
}

/* ─────────────────────────── Labels (setup step 8, and between rounds) ─────────────────────────── */

type Draft = Record<number, { k: KLabel | ""; p: PLabel | ""; view: string }>;

export function labelsComplete(st: GameState): boolean {
  return seatList(st).every((s) => s.k && s.p && s.view);
}

export function LabelsEditor({
  conn,
  st,
  scenario,
  onSaved,
}: {
  conn: FacilitatorConnection;
  st: GameState;
  scenario: Scenario | null;
  onSaved?: () => void;
}) {
  const seats = seatList(st);
  const manualView = st.config.viewAssignment === "manual";
  const fromState = (): Draft =>
    Object.fromEntries(seats.map((s) => [s.seat, { k: s.k ?? "", p: s.p ?? "", view: s.view ?? "" }]));
  const [draft, setDraft] = useState<Draft>(fromState);
  const [dirty, setDirty] = useState(false);
  const key = seats.map((s) => `${s.k}${s.p}${s.view}`).join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-sync when labels change on the server
  useEffect(() => {
    if (!dirty) setDraft(fromState());
  }, [key, dirty]);

  const set = (seat: number, field: "k" | "p" | "view", v: string) => {
    setDirty(true);
    setDraft((d) => ({ ...d, [seat]: { ...d[seat]!, [field]: v } }));
  };
  const dupes = (field: "k" | "p") => {
    const vals = seats.map((s) => draft[s.seat]?.[field]).filter(Boolean);
    return new Set(vals.filter((v, i) => vals.indexOf(v) !== i));
  };
  const dk = st.config.allowDuplicateLabels ? new Set() : dupes("k");
  const dp = st.config.allowDuplicateLabels ? new Set() : dupes("p");
  const complete = seats.every(
    (s) => draft[s.seat]?.k && draft[s.seat]?.p && (!manualView || draft[s.seat]?.view),
  );
  const valid = complete && dk.size === 0 && dp.size === 0;

  const save = () => {
    const assignments = seats.map((s) => ({
      seat: s.seat,
      k: draft[s.seat]!.k,
      p: draft[s.seat]!.p,
      ...(manualView ? { view: draft[s.seat]!.view } : {}),
    }));
    conn.cmd("labels:set", { assignments }, "Labels saved").then(
      () => {
        setDirty(false);
        onSaved?.();
      },
      () => {},
    );
  };

  return (
    <div className="col">
      <div className="row">
        <Button
          icon="randomise"
          onClick={() =>
            conn.cmd("labels:randomise", {}, "Labels randomised (seed logged)").then(
              () => {
                setDirty(false);
                onSaved?.();
              },
              () => {},
            )
          }
        >
          Randomise all
        </Button>
        <span className="hint">
          {st.config.allowDuplicateLabels ? "Labels may repeat." : "Each K and each P label once."}{" "}
          {manualView ? "Views are chosen per seat." : "The K label also selects the seat's map view."}
        </span>
      </div>
      <table className="grid">
        <thead>
          <tr>
            <th>Seat</th>
            <th>Knowledge (K)</th>
            <th>Power (P)</th>
            <th>Map view</th>
          </tr>
        </thead>
        <tbody>
          {seats.map((s) => {
            const d = draft[s.seat] ?? { k: "", p: "", view: "" };
            const view = manualView ? d.view : d.k;
            return (
              <tr key={s.seat}>
                <td>
                  <span className="row nowrap">
                    <SeatDot seat={s.seat} /> <strong>SEAT {s.seat}</strong>
                  </span>
                </td>
                <td>
                  <select
                    aria-label={`K label of seat ${s.seat}`}
                    value={d.k}
                    onChange={(e) => set(s.seat, "k", e.target.value)}
                    style={dk.has(d.k) ? { borderColor: "var(--danger)" } : undefined}
                  >
                    <option value="">–</option>
                    {K_LABELS.map((k) => (
                      <option key={k}>{k}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <select
                    aria-label={`P label of seat ${s.seat}`}
                    value={d.p}
                    onChange={(e) => set(s.seat, "p", e.target.value)}
                    style={dp.has(d.p) ? { borderColor: "var(--danger)" } : undefined}
                  >
                    <option value="">–</option>
                    {P_LABELS.map((p) => (
                      <option key={p}>{p}</option>
                    ))}
                  </select>
                </td>
                <td className="small">
                  {manualView ? (
                    <select
                      aria-label={`View of seat ${s.seat}`}
                      value={d.view}
                      onChange={(e) => set(s.seat, "view", e.target.value)}
                    >
                      <option value="">–</option>
                      {Object.keys(scenario?.views ?? {}).map((v) => (
                        <option key={v}>{v}</option>
                      ))}
                    </select>
                  ) : view ? (
                    `${view} · ${scenario?.views[view]?.name ?? ""}`
                  ) : (
                    <span className="faint">follows K</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {(dk.size > 0 || dp.size > 0) && (
        <Callout tone="danger" icon="warning">
          Duplicate labels: {[...dk, ...dp].join(", ")}
        </Callout>
      )}
      <div className="row">
        <span className="spacer" />
        <Button
          variant={dirty ? "primary" : "secondary"}
          icon="ok"
          disabled={!dirty || !valid}
          onClick={save}
        >
          Save labels
        </Button>
      </div>
    </div>
  );
}

/* ─────────────────────────── Seats overview (setup page + live) ─────────────────────────── */

export function SeatsPanel({
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
  const confirm = useConfirm();
  const seats = seatList(st);
  const pLim = quotaLimit(st, "propose");
  const dLim = quotaLimit(st, "decide");
  const final = ["closed", "aborted"].includes(st.phase);

  const withdraw = async (seat: number) => {
    if (
      await confirm({
        title: `Withdraw seat ${seat}`,
        message: (
          <>
            <p>
              The participant stops taking part. Their intents are rejected from now on and rounds complete
              without them.
            </p>
            <p className="muted">
              Data collected so far is kept unless you erase it later (DATABASE → Takedown).
            </p>
          </>
        ),
        confirmLabel: "Withdraw",
        danger: true,
        icon: "withdraw",
      })
    ) {
      void conn.cmd("participant:withdraw", { seat }, `Seat ${seat} withdrawn`).catch(() => {});
    }
  };

  return (
    <Panel title="Seats" icon="seats">
      <div style={{ overflowX: "auto" }}>
        <table className="grid">
          <thead>
            <tr>
              <th>Seat</th>
              <th>Terminal</th>
              <th>Code</th>
              <th>K</th>
              <th>P</th>
              <th>View</th>
              <th>Onboarding</th>
              <th>Quota</th>
              <th>Activity</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {seats.map((s) => {
              const stats = dash.stats[s.seat];
              const step = st.phase === "onboarding" ? nextOnboardingStep(st, s) : null;
              return (
                <tr key={s.seat}>
                  <td>
                    <span className="row nowrap">
                      <SeatDot seat={s.seat} /> <strong>{s.seat}</strong>
                    </span>
                  </td>
                  <td>
                    {s.bound ? (
                      <span className="row nowrap">
                        T{s.terminal}
                        {s.withdrawn ? (
                          <StatusTag>withdrawn</StatusTag>
                        ) : s.connected ? (
                          <StatusTag tone="live">online</StatusTag>
                        ) : (
                          <StatusTag tone="danger" icon="disconnected">
                            offline
                          </StatusTag>
                        )}
                      </span>
                    ) : (
                      <span className="faint">unbound</span>
                    )}
                  </td>
                  <td className="mono small">{s.participantCode ?? <span className="faint">—</span>}</td>
                  <td>{s.k ?? <span className="faint">–</span>}</td>
                  <td>{s.p ?? <span className="faint">–</span>}</td>
                  <td className="small">
                    {s.view ? (scenario?.views[s.view]?.name ?? s.view) : <span className="faint">–</span>}
                  </td>
                  <td className="small">
                    {st.phase === "lobby" || !s.bound ? (
                      <span className="faint">—</span>
                    ) : s.consent === "declined" ? (
                      <StatusTag tone="danger" icon="warning">
                        declined
                      </StatusTag>
                    ) : isOnboardingComplete(st, s) ? (
                      <StatusTag tone="live" icon="ok">
                        ready
                      </StatusTag>
                    ) : (
                      <StatusTag tone="warn">{step ?? "…"}</StatusTag>
                    )}
                  </td>
                  <td className="small">
                    {st.round > 0 && s.bound ? (
                      <span className="col" style={{ gap: 0 }}>
                        <span>
                          <span className="t-propose">P</span>{" "}
                          <AsciiProgress used={quotaUsed(st, s.seat, "propose")} limit={pLim} />
                        </span>
                        <span>
                          <span className="t-decide">D</span>{" "}
                          <AsciiProgress used={quotaUsed(st, s.seat, "decide")} limit={dLim} />
                        </span>
                      </span>
                    ) : (
                      <span className="faint">—</span>
                    )}
                  </td>
                  <td className="small">
                    {stats && s.bound && !s.withdrawn ? (
                      <span className="row" style={{ gap: 4 }}>
                        {stats.focused === false && (
                          <StatusTag tone="warn" title="Game window lost focus">
                            unfocused
                          </StatusTag>
                        )}
                        {stats.visible === false && (
                          <StatusTag tone="danger" icon="hidden">
                            tab hidden
                          </StatusTag>
                        )}
                        {stats.idle && (
                          <StatusTag tone="warn" icon="idle">
                            idle
                          </StatusTag>
                        )}
                        {s.lastActionTs && (
                          <span className="muted">last {fmtDuration(now - s.lastActionTs)}</span>
                        )}
                        {stats.rttMs !== null && <span className="faint">{stats.rttMs}ms</span>}
                        {s.reconnects > 0 && <span className="faint">↻{s.reconnects}</span>}
                        {s.rejections > 0 && <span className="faint">✗{s.rejections}</span>}
                      </span>
                    ) : (
                      <span className="faint">—</span>
                    )}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {st.phase !== "lobby" && s.bound && !s.withdrawn && !final && (
                      <Button
                        size="sm"
                        variant="danger"
                        icon="withdraw"
                        onClick={() => void withdraw(s.seat)}
                      >
                        Withdraw
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
