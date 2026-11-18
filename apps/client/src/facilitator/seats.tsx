import {
  type DashboardMsg,
  DISSOCIATED_PAIRINGS,
  FAKE_PLAYER_PACES,
  type FakePlayerPace,
  fakeSeats,
  type GameState,
  isOnboardingComplete,
  isSimulated,
  K_LABELS,
  type KLabel,
  type LabelPairing,
  nextOnboardingStep,
  P_LABELS,
  type PairingMode,
  pairedP,
  pairingName,
  pairingText,
  quotaLimit,
  quotaUsed,
  type Scenario,
  type SeatState,
  seatList,
} from "@wkwa/shared";
import { useEffect, useState } from "react";
import { fmtDuration } from "../common/format";
import {
  ActSwatch,
  AsciiProgress,
  Button,
  Callout,
  ConnTag,
  Field,
  Icon,
  LabelTag,
  Panel,
  SeatDot,
  StatusTag,
  useConfirm,
} from "../ui";
import type { FacilitatorConnection } from "./connection";
import { policyLabel } from "./simulation";

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/* ─────────────────────────── Who holds a seat ─────────────────────────── */

/** Status tags of a seat's occupant: an agent, or a client (connection state) that may be a fake player. */
export function OccupantTags({ seat: s }: { seat: SeatState }) {
  if (s.agent) {
    return (
      <StatusTag icon="agent" title={`Agent: ${policyLabel(s.agent.policy)}`}>
        {s.withdrawn ? "withdrawn" : "agent"}
      </StatusTag>
    );
  }
  return (
    <>
      <ConnTag connected={s.connected} withdrawn={s.withdrawn} />
      {s.fake && (
        <StatusTag icon="fake" title="Fake player: a test client the server created">
          fake
        </StatusTag>
      )}
    </>
  );
}

/* ─────────────────────────── Bind clients → seats (setup step 7) ─────────────────────────── */

export function BindEditor({ conn, dash }: { conn: FacilitatorConnection; dash: DashboardMsg }) {
  const st = dash.state!;
  const seats = seatList(st);
  const free = dash.terminals.filter((t) => t.connected && t.seat === null);
  const bound = seats.filter((s) => s.bound).length;
  const fakes = fakeSeats(st).length;
  const unbound = seats.filter((s) => !s.bound).length;
  const [pace, setPace] = useState<FakePlayerPace>("normal");
  const [busy, setBusy] = useState(false);
  const addFakes = (seatsToFill: number[] | null) => {
    setBusy(true);
    void conn
      .cmd<{ seats: number[] }>("fake:add", { seats: seatsToFill, pace })
      .then(
        (r) => conn.toast(`Fake player${r.seats.length === 1 ? "" : "s"} in seat ${r.seats.join(", ")}`),
        () => {},
      )
      .finally(() => setBusy(false));
  };
  return (
    <div className="col">
      <div className="row">
        <StatusTag tone={bound === seats.length ? "live" : "warn"} icon="seats">
          {bound}/{seats.length} seats bound
        </StatusTag>
        <StatusTag tone={free.length ? "primary" : "neutral"} icon="client">
          {free.length} unassigned client{free.length === 1 ? "" : "s"}
        </StatusTag>
        {fakes > 0 && (
          <StatusTag
            icon="fake"
            title="Test clients the server created: no participant, no code, no onboarding"
          >
            {fakes} fake player{fakes === 1 ? "" : "s"}
          </StatusTag>
        )}
      </div>
      <table className="grid">
        <thead>
          <tr>
            <th>Seat</th>
            <th>Client</th>
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
                    <Icon name="client" /> C{s.terminal} <OccupantTags seat={s} />
                  </span>
                ) : (
                  <span className="row nowrap">
                    <select
                      aria-label={`Bind a client to seat ${s.seat}`}
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
                      <option value="">{free.length ? "bind client…" : "waiting for clients…"}</option>
                      {free.map((t) => (
                        <option key={t.terminal} value={t.terminal}>
                          Client {t.terminal}
                          {t.fake ? " (fake)" : ""}
                        </option>
                      ))}
                    </select>
                    <Button
                      size="sm"
                      icon="fake"
                      disabled={busy}
                      tip={`Let the server create a fake player for seat ${s.seat}: a test client that connects like a browser, skips consent and the questionnaire, gets no participant code and proposes/decides at random.`}
                      onClick={() => addFakes([s.seat])}
                    >
                      Fake player
                    </Button>
                  </span>
                )}
              </td>
              <td className="mono">
                {s.fake ? (
                  <span className="faint">none (fake player)</span>
                ) : (
                  (s.participantCode ?? <span className="faint">—</span>)
                )}
              </td>
              <td style={{ textAlign: "right" }}>
                {s.bound && (
                  <Button
                    size="sm"
                    icon="withdraw"
                    tip="Free this seat so another client can be bound to it"
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
        <Callout icon="client">
          Open the player URL on each PC. Each screen shows its <strong>client number</strong> in large type,
          then appears here.
        </Callout>
      )}
      <div className="row">
        <Icon name="fake" />
        <span className="small upper muted">Testing without people</span>
        <select
          aria-label="Fake player pace"
          value={pace}
          onChange={(e) => setPace(e.target.value as FakePlayerPace)}
        >
          {(Object.keys(FAKE_PLAYER_PACES) as FakePlayerPace[]).map((p) => (
            <option key={p} value={p}>
              {FAKE_PLAYER_PACES[p].label}
            </option>
          ))}
        </select>
        <Button
          icon="fake"
          disabled={busy || unbound === 0}
          tip="Fill every unbound seat with a fake player (test client). They are logged as fake and stored with this session in the participant database."
          onClick={() => addFakes(null)}
        >
          Fill empty seats with fake players
        </Button>
        <span className="hint">
          Fake players are test clients the server creates: they connect like a browser, skip consent and the
          questionnaire, get no participant code and are marked fake in the log and the exports.
        </span>
      </div>
    </div>
  );
}

/* ─────────────────────────── Agents (setup step 7 of a simulated session) ─────────────────────────── */

export function AgentsTable({ st }: { st: GameState }) {
  return (
    <table className="grid">
      <thead>
        <tr>
          <th>Seat</th>
          <th>Agent policy</th>
          <th>Seed</th>
          <th>Client / code</th>
        </tr>
      </thead>
      <tbody>
        {seatList(st).map((s) => (
          <tr key={s.seat}>
            <td>
              <span className="row nowrap">
                <SeatDot seat={s.seat} /> <strong>SEAT {s.seat}</strong>
              </span>
            </td>
            <td>
              {s.agent ? (
                <span className="row nowrap">
                  <Icon name="agent" /> {policyLabel(s.agent.policy)}
                </span>
              ) : (
                <span className="faint">—</span>
              )}
            </td>
            <td className="mono small">{s.agent?.seed ?? "—"}</td>
            <td className="faint small">none (simulated)</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ─────────────────────────── Labels (setup step 8, and between rounds) ─────────────────────────── */

type Draft = Record<number, { k: KLabel | ""; view: string }>;
type PairingChoice = { mode: PairingMode; id: number | null };

export function labelsComplete(st: GameState): boolean {
  return seatList(st).every((s) => s.k && s.p && s.view) && st.labelPairing !== null;
}

/** 4×4 K×P matrix of a pairing; ■ = held by the same seat. Highlights the K labels in use. */
export function PairingMatrix({ pairing, usedK }: { pairing: LabelPairing | null; usedK?: Set<string> }) {
  return (
    <table className="grid" style={{ width: "auto" }} aria-label="K–P pairing matrix">
      <thead>
        <tr>
          <th>{pairing ? pairingName(pairing) : "—"}</th>
          {P_LABELS.map((p) => (
            <th key={p}>
              <LabelTag label={p} filled />
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {K_LABELS.map((k) => (
          <tr key={k}>
            <td className={usedK && !usedK.has(k) ? "faint" : "strong"}>
              <LabelTag label={k} />
            </td>
            {P_LABELS.map((p) => {
              const on = pairing ? pairedP(k, pairing) === p : false;
              return (
                <td key={p} className={on ? "t-primary strong" : "faint"} style={{ textAlign: "center" }}>
                  {on ? "■" : "·"}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * K per seat + one of two pairing kinds. P is never chosen: it follows from
 * the pairing — aligned (Ka–Pa …) or fully dissociated D1–D6 (see
 * docs/DATA-TYPES.md § Label pairings).
 */
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
    Object.fromEntries(
      seats.map((s, i) => [s.seat, { k: s.k ?? K_LABELS[i % K_LABELS.length]!, view: s.view ?? "" }]),
    );
  const [draft, setDraft] = useState<Draft>(fromState);
  const [pairing, setPairing] = useState<PairingChoice>(st.labelPairing ?? { mode: "aligned", id: null });
  const [dirty, setDirty] = useState(st.labelPairing === null);
  const key = `${seats.map((s) => `${s.k}${s.view}`).join("|")}|${pairingName(st.labelPairing)}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-sync when labels change on the server
  useEffect(() => {
    if (!dirty) {
      setDraft(fromState());
      if (st.labelPairing) setPairing(st.labelPairing);
    }
  }, [key, dirty]);

  const setK = (seat: number, field: "k" | "view", v: string) => {
    setDirty(true);
    setDraft((d) => ({ ...d, [seat]: { ...d[seat]!, [field]: v } }));
  };
  const setPair = (p: PairingChoice) => {
    setDirty(true);
    setPairing(p);
  };
  const ks = seats.map((s) => draft[s.seat]?.k).filter(Boolean) as string[];
  const dupes = new Set(ks.filter((v, i) => ks.indexOf(v) !== i));
  const complete = seats.every((s) => draft[s.seat]?.k && (!manualView || draft[s.seat]?.view));
  const valid = complete && dupes.size === 0;
  const preview: LabelPairing | null =
    pairing.mode === "aligned"
      ? { mode: "aligned", id: null }
      : pairing.id
        ? { mode: "dissociated", id: pairing.id }
        : null;

  const done = () => {
    setDirty(false);
    onSaved?.();
  };
  const save = () => {
    const assignments = seats.map((s) => ({
      seat: s.seat,
      k: draft[s.seat]!.k,
      ...(manualView ? { view: draft[s.seat]!.view } : {}),
    }));
    conn.cmd("labels:set", { assignments, pairing }, "Labels saved").then(done, () => {});
  };
  const shuffle = () =>
    conn
      .cmd("labels:randomise", { pairing, shuffleK: true }, "K shuffled across seats (seed logged)")
      .then(done, () => {});

  return (
    <div className="col">
      <div className="grid-2" style={{ alignItems: "start" }}>
        <div className="col">
          <span className="small upper muted">1 · K–P pairing</span>
          <label className="check" style={{ alignItems: "center" }}>
            <input
              type="radio"
              name="pairing-mode"
              checked={pairing.mode === "aligned"}
              onChange={() => setPair({ mode: "aligned", id: null })}
            />
            <span>
              <strong>Aligned</strong> <span className="muted">— Ka–Pa · Kb–Pb · Kc–Pc · Kd–Pd</span>
            </span>
          </label>
          <label className="check" style={{ alignItems: "center" }}>
            <input
              type="radio"
              name="pairing-mode"
              checked={pairing.mode === "dissociated"}
              onChange={() => setPair({ mode: "dissociated", id: pairing.id ?? null })}
            />
            <span>
              <strong>Dissociated</strong>{" "}
              <span className="muted">— no seat holds the same letter, no two seats mirror each other</span>
            </span>
          </label>
          {pairing.mode === "dissociated" && (
            <Field
              label="Which dissociative pairing (D1–D6)"
              hint="The number is stored with the labels and in the exports."
            >
              <select
                aria-label="Dissociative pairing"
                value={pairing.id ?? ""}
                onChange={(e) =>
                  setPair({ mode: "dissociated", id: e.target.value ? Number(e.target.value) : null })
                }
              >
                <option value="">random (D1–D6, seed logged)</option>
                {DISSOCIATED_PAIRINGS.map((_, i) => {
                  const p: LabelPairing = { mode: "dissociated", id: i + 1 };
                  return (
                    <option key={pairingText(p)} value={i + 1}>
                      D{i + 1} · {pairingText(p)}
                    </option>
                  );
                })}
              </select>
            </Field>
          )}
          {st.labelPairing && (
            <span className="hint">
              In force: <strong>{pairingName(st.labelPairing)}</strong> · {pairingText(st.labelPairing)}
            </span>
          )}
        </div>
        <div className="col">
          <span className="small upper muted">Matrix {preview ? "" : "(chosen when saved)"}</span>
          <PairingMatrix pairing={preview} usedK={new Set(ks)} />
        </div>
      </div>

      <span className="small upper muted">2 · Knowledge type per seat</span>
      <table className="grid">
        <thead>
          <tr>
            <th>Seat</th>
            <th>Knowledge (K)</th>
            <th>Power (P) — from the pairing</th>
            <th>Map view</th>
          </tr>
        </thead>
        <tbody>
          {seats.map((s) => {
            const d = draft[s.seat] ?? { k: "", view: "" };
            const view = manualView ? d.view : d.k;
            const p = d.k && preview ? pairedP(d.k as KLabel, preview) : null;
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
                    onChange={(e) => setK(s.seat, "k", e.target.value)}
                    style={dupes.has(d.k) ? { borderColor: "var(--danger)" } : undefined}
                  >
                    {K_LABELS.map((k) => (
                      <option key={k}>{k}</option>
                    ))}
                  </select>
                </td>
                <td className="strong">
                  {p ? (
                    <LabelTag
                      label={p}
                      filled
                      tip={`Power type ${p}: seat ${s.seat}'s proposals and decisions land on the K${p[1]} sub-squares`}
                    />
                  ) : (
                    <span className="faint">random D1–D6</span>
                  )}
                </td>
                <td className="small">
                  {manualView ? (
                    <select
                      aria-label={`View of seat ${s.seat}`}
                      value={d.view}
                      onChange={(e) => setK(s.seat, "view", e.target.value)}
                    >
                      <option value="">–</option>
                      {Object.keys(scenario?.views ?? {}).map((v) => (
                        <option key={v}>{v}</option>
                      ))}
                    </select>
                  ) : view ? (
                    <span data-tip={`Seat ${s.seat} sees the scores of the ${view} sub-squares`}>
                      {view} · {scenario?.views[view]?.name ?? ""}
                    </span>
                  ) : (
                    <span className="faint">follows K</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {dupes.size > 0 && (
        <Callout tone="danger" icon="warning">
          Each K label can only be held by one seat: {[...dupes].join(", ")}
        </Callout>
      )}
      <div className="row">
        <Button
          icon="randomise"
          onClick={shuffle}
          tip="Deal the K labels to the seats at random (the seed is logged); the pairing then sets each P"
        >
          Shuffle K across seats
        </Button>
        <span className="hint">
          {manualView ? "Views are chosen per seat." : "The K label also selects the seat's map view."}
        </span>
        <span className="spacer" />
        <Button
          variant={dirty ? "primary" : "secondary"}
          icon="ok"
          disabled={!dirty || !valid}
          onClick={save}
          tip="Assign these labels and views to the seats (logged)"
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
  const simulated = isSimulated(st);

  const withdraw = async (seat: number) => {
    if (
      await confirm({
        title: `Withdraw seat ${seat}`,
        message: simulated ? (
          <p>The agent stops playing. Rounds complete without this seat from now on (logged).</p>
        ) : (
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
              <th>{simulated ? "Agent" : "Client"}</th>
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
                        {s.agent ? (
                          <>
                            <Icon name="agent" /> {s.agent.policy}
                          </>
                        ) : (
                          `C${s.terminal}`
                        )}
                        <OccupantTags seat={s} />
                      </span>
                    ) : (
                      <span className="faint">unbound</span>
                    )}
                  </td>
                  <td className="mono small">{s.participantCode ?? <span className="faint">—</span>}</td>
                  <td>
                    {s.k ? (
                      <LabelTag label={s.k} tip={`Knowledge type of seat ${s.seat}`} />
                    ) : (
                      <span className="faint">–</span>
                    )}
                  </td>
                  <td>
                    {s.p ? (
                      <LabelTag
                        label={s.p}
                        filled
                        tip={`Power type of seat ${s.seat}: acts on the K${s.p[1]} sub-squares`}
                      />
                    ) : (
                      <span className="faint">–</span>
                    )}
                  </td>
                  <td className="small">
                    {s.view ? (scenario?.views[s.view]?.name ?? s.view) : <span className="faint">–</span>}
                  </td>
                  <td className="small">
                    {st.phase === "lobby" || !s.bound || s.agent ? (
                      <span className="faint">—</span>
                    ) : s.fake ? (
                      <StatusTag icon="fake">skipped (fake)</StatusTag>
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
                        <span className="row nowrap" style={{ gap: 4 }} data-tip="Proposals used this round">
                          <ActSwatch kind="propose" k={s.p ? `K${s.p[1]}` : null} />
                          <AsciiProgress used={quotaUsed(st, s.seat, "propose")} limit={pLim} />
                        </span>
                        <span className="row nowrap" style={{ gap: 4 }} data-tip="Decisions used this round">
                          <ActSwatch kind="decide" k={s.p ? `K${s.p[1]}` : null} />
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
                        tip="Stop this seat taking part; rounds complete without it from now on"
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
