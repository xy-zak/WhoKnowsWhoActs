import {
  AUDIO_CHUNK_SECONDS,
  type DashboardMsg,
  DISSOCIATED_PAIRINGS,
  fakeSeats,
  isFinalPhase,
  isOnboardingComplete,
  isSimulated,
  K_LABELS,
  type KLabel,
  type LabelPairing,
  micHasLevel,
  nextOnboardingStep,
  P_LABELS,
  type PairingMode,
  pairedP,
  pairingName,
  pairingText,
  quotaLimit,
  quotaUsed,
  type ReadonlyGameState,
  type ReadonlySeatState,
  type Scenario,
  type SeatMicStats,
  seatList,
} from "@wkwa/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { fmtDuration, fmtMinutes, plural } from "../common/format";
import {
  ActSwatch,
  AsciiProgress,
  Button,
  Callout,
  ConnTag,
  Field,
  GridTable,
  Icon,
  LabelTag,
  LevelMeter,
  Panel,
  RecTag,
  SeatDot,
  StatusTag,
  useBusy,
  useConfirm,
} from "../ui";
import {
  type BacklogTrend,
  backlogTone,
  chunkAge,
  micCell,
  micCheckStatus,
  nextBacklogTrend,
  STALE_CHUNK_MS,
} from "./audioLive";
import type { FacilitatorConnection } from "./connection";
import { policyLabel } from "./simulation";

/* ─────────────────────────── Who holds a seat ─────────────────────────── */

/** Status tags of a seat's occupant: an agent, or a client (connection state) that may be a fake player. */
export function OccupantTags({ seat: s }: { seat: ReadonlySeatState }) {
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

/* ─────────────────────────── Bind clients → seats (setup step 08) ─────────────────────────── */

export function BindEditor({ conn, dash }: { conn: FacilitatorConnection; dash: DashboardMsg }) {
  const st = dash.state!;
  const seats = seatList(st);
  const free = dash.terminals.filter((t) => t.connected && t.seat === null);
  const bound = seats.filter((s) => s.bound).length;
  const fakes = fakeSeats(st).length;
  const [busy, run] = useBusy();
  /** A fake player (test client) for one seat, at the normal pace. */
  const addFake = (seat: number) =>
    run(async () => {
      const r = await conn.cmd("fake:add", { seats: [seat], pace: "normal" });
      conn.toast(`Fake player in seat ${r.seats.join(", ")}`);
    });
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
      <GridTable head={["Seat", "Client", "Participant code", ""]}>
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
                      conn.run(
                        "seat:bind",
                        { terminal: Number(e.target.value), seat: s.seat },
                        `Seat ${s.seat} bound`,
                      )
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
                    onClick={() => addFake(s.seat)}
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
                  onClick={() => conn.run("seat:unbind", { seat: s.seat, reason: "facilitator" }, "Unbound")}
                >
                  Unbind
                </Button>
              )}
            </td>
          </tr>
        ))}
      </GridTable>
      {free.length === 0 && bound < seats.length && (
        <Callout icon="client">
          Open the player URL on each PC. Each screen shows its <strong>client number</strong> in large type,
          then appears here.
        </Callout>
      )}
    </div>
  );
}

/* ─────────────────────────── Agents (setup step 08 of a simulated session) ─────────────────────────── */

export function AgentsTable({ st }: { st: ReadonlyGameState }) {
  return (
    <GridTable head={["Seat", "Agent policy", "Seed", "Client / code"]}>
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
    </GridTable>
  );
}

/* ─────────────────────────── Labels (setup step 09, and between rounds) ─────────────────────────── */

type PairingChoice = { mode: PairingMode; id: number | null };

export function labelsComplete(st: ReadonlyGameState): boolean {
  return seatList(st).every((s) => s.k && s.p && s.view) && st.labelPairing !== null;
}

/** The K label a seat holds by default: seat 1 → Ka, seat 2 → Kb, … (seat order). */
function defaultK(seat: number): KLabel {
  return K_LABELS[(seat - 1) % K_LABELS.length]!;
}

/**
 * The K×P matrix of a pairing: one row per K label, with the seat that holds it (and its map view);
 * ■ marks the P that K is paired with. `views` is the manual view choice per seat, when the session
 * chooses views per seat.
 */
export function PairingMatrix({
  pairing,
  seats,
  scenario,
  views,
}: {
  pairing: LabelPairing | null;
  seats: Array<{ seat: number; k: KLabel; view: string }>;
  scenario: Scenario | null;
  views?: { set: (seat: number, view: string) => void };
}) {
  return (
    <table className="grid" style={{ width: "auto" }} aria-label="K–P pairing matrix">
      <thead>
        <tr>
          <th>Seat · knowledge (K)</th>
          {P_LABELS.map((p) => (
            <th key={p} style={{ textAlign: "center" }}>
              <LabelTag label={p} filled />
            </th>
          ))}
          <th>Map view</th>
        </tr>
      </thead>
      <tbody>
        {K_LABELS.map((k) => {
          const holder = seats.find((s) => s.k === k);
          const paired = pairing ? pairedP(k, pairing) : null;
          return (
            <tr key={k}>
              <td className={holder ? "strong" : "faint"}>
                <span className="row nowrap">
                  {holder ? (
                    <>
                      <SeatDot seat={holder.seat} /> SEAT {holder.seat}
                    </>
                  ) : (
                    <span className="faint">no seat</span>
                  )}
                  <LabelTag
                    label={k}
                    tip={
                      holder
                        ? `Seat ${holder.seat} knows ${k}: on the map it sees the scores of the ${k} sub-squares`
                        : undefined
                    }
                  />
                </span>
              </td>
              {P_LABELS.map((p) => {
                const on = paired === p;
                return (
                  <td
                    key={p}
                    className={on && holder ? "t-primary strong" : "faint"}
                    style={{ textAlign: "center" }}
                    data-tip={
                      on && holder
                        ? `Seat ${holder.seat} acts as ${p}: its proposals and decisions land on the K${p[1]} sub-squares`
                        : undefined
                    }
                  >
                    {on ? "■" : "·"}
                  </td>
                );
              })}
              <td className="small">
                {!holder ? null : views ? (
                  <select
                    aria-label={`View of seat ${holder.seat}`}
                    value={holder.view}
                    onChange={(e) => views.set(holder.seat, e.target.value)}
                  >
                    <option value="">–</option>
                    {Object.keys(scenario?.views ?? {}).map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                ) : (
                  <span className="muted">
                    {k} · {scenario?.views[k]?.name ?? ""}
                  </span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/**
 * The K–P pairing of the seats: aligned or one of the fully dissociated D1–D6 (see
 * docs/DATA-TYPES.md § Label pairings). Each seat keeps the K it holds (seat order, seat 1 → Ka,
 * for a session without labels yet); P is never chosen but follows from the pairing. Every choice
 * is saved at once (LabelsAssigned): there is no save button.
 */
export function LabelsEditor({
  conn,
  st,
  scenario,
}: {
  conn: FacilitatorConnection;
  st: ReadonlyGameState;
  scenario: Scenario | null;
}) {
  const seats = seatList(st);
  const manualView = st.config.viewAssignment === "manual";
  const fromState = () => Object.fromEntries(seats.map((s) => [s.seat, s.view ?? ""]));
  const [views, setViews] = useState<Record<number, string>>(fromState);
  const viewsKey = seats.map((s) => s.view).join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-sync when the views change on the server
  useEffect(() => setViews(fromState()), [viewsKey]);
  const held = seats.map((s) => ({ seat: s.seat, k: s.k ?? defaultK(s.seat), view: views[s.seat] ?? "" }));
  // the choice shows at once; the pairing in force (the server's, e.g. the drawn D-number) replaces it
  const [chosen, setChosen] = useState<PairingChoice | null>(st.labelPairing);
  const inForce = st.labelPairing ? pairingName(st.labelPairing) : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-sync when the pairing changes on the server
  useEffect(() => setChosen(st.labelPairing), [inForce]);
  // the matrix shows the pairing in force, or the aligned one just chosen (a drawn D-number is known once saved)
  const shown: LabelPairing | null =
    st.labelPairing && (!chosen || chosen.mode === st.labelPairing.mode)
      ? st.labelPairing
      : chosen?.mode === "aligned"
        ? { mode: "aligned", id: null }
        : null;
  const viewsMissing = manualView && held.some((h) => !h.view);

  const save = (next: PairingChoice, nextViews = views) => {
    setChosen(next);
    if (manualView && seats.some((s) => !nextViews[s.seat])) return;
    const assignments = held.map((h) => ({
      seat: h.seat,
      k: h.k,
      ...(manualView ? { view: nextViews[h.seat] } : {}),
    }));
    conn.run(
      "labels:set",
      { assignments, pairing: next },
      next.mode === "aligned"
        ? "Pairing: aligned"
        : `Pairing: ${next.id ? `D${next.id}` : "dissociated, drawn at random"}`,
    );
  };
  const setView = (seat: number, view: string) => {
    const next = { ...views, [seat]: view };
    setViews(next);
    if (chosen) save(chosen, next);
  };

  return (
    <div className="grid-2" style={{ alignItems: "start" }}>
      <div className="col">
        <span className="small upper muted">K–P pairing</span>
        <label className="check" style={{ alignItems: "center" }}>
          <input
            type="radio"
            name="pairing-mode"
            checked={chosen?.mode === "aligned"}
            onChange={() => save({ mode: "aligned", id: null })}
          />
          <span>
            <strong>Aligned</strong> <span className="muted">— Ka–Pa · Kb–Pb · Kc–Pc · Kd–Pd</span>
          </span>
        </label>
        <label className="check" style={{ alignItems: "center" }}>
          <input
            type="radio"
            name="pairing-mode"
            checked={chosen?.mode === "dissociated"}
            onChange={() => save({ mode: "dissociated", id: null })}
          />
          <span>
            <strong>Dissociated</strong>{" "}
            <span className="muted">— no seat holds the same letter, no two seats mirror each other</span>
          </span>
        </label>
        {chosen?.mode === "dissociated" && st.labelPairing?.mode === "dissociated" && (
          <Field
            label="Which dissociative pairing (D1–D6)"
            hint="Choosing Dissociated draws one at random (seed logged). The number is stored with the labels and in the exports."
          >
            <select
              aria-label="Dissociative pairing"
              value={chosen.id ?? ""}
              onChange={(e) =>
                save({ mode: "dissociated", id: e.target.value ? Number(e.target.value) : null })
              }
            >
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
        {st.labelPairing ? (
          <span className="hint">
            In force: <strong>{pairingName(st.labelPairing)}</strong> · {pairingText(st.labelPairing)}. Saved;
            logged as <code>LabelsAssigned</code>.
          </span>
        ) : (
          <span className="hint">Choose a pairing: it is saved at once.</span>
        )}
        {viewsMissing && (
          <Callout tone="warn" icon="warning">
            Choose a map view for every seat (right): the labels are saved once each seat has one.
          </Callout>
        )}
      </div>
      <div className="col">
        <span className="small upper muted">
          Matrix {shown ? `· ${pairingName(shown)}` : "· no pairing yet"}
        </span>
        <PairingMatrix
          pairing={shown}
          seats={held}
          scenario={scenario}
          views={manualView ? { set: setView } : undefined}
        />
        <span className="hint">
          Each seat keeps its K (seat 1 → Ka, seat 2 → Kb …).{" "}
          {manualView ? "Views are chosen per seat." : "The K label also selects the seat's map view."}
        </span>
      </div>
    </div>
  );
}

/* ─────────────────────────── Mic column (sessions that record audio) ─────────────────────────── */

/**
 * A seat's microphone in the seats table: recording state, level, upload backlog (`↑ n`), age of
 * the last stored chunk (warn when stale while recording), audio stored so far and, during
 * onboarding, the mic check status. Static: nothing animates (AESTHETIC-RULES § 8.1).
 */
function MicColumn({
  st,
  seat,
  mic,
  trend,
  serverNow,
}: {
  st: ReadonlyGameState;
  seat: ReadonlySeatState;
  mic: SeatMicStats | undefined;
  trend: BacklogTrend | undefined;
  serverNow: number;
}) {
  const cell = micCell(st, seat, mic);
  const check = st.phase === "onboarding" ? micCheckStatus(st, seat) : null;
  const meter = cell.state !== "off" && cell.state !== "skipped";
  if (!meter && !check) return <RecTag compact state={cell.state} tip={cell.tip} />;
  const pending = mic?.pendingChunks ?? 0;
  const pendingWarn = backlogTone(pending, trend?.growing ?? false) === "warn";
  const live = micHasLevel(cell.state);
  const age = live ? chunkAge(mic, serverNow) : { ageMs: null, stale: false };
  return (
    <span className="col" style={{ gap: 2 }}>
      <span className="row nowrap" style={{ gap: 6 }}>
        <RecTag compact state={cell.state} tip={cell.tip} />
        {meter && (
          <LevelMeter
            compact
            quietDb={null}
            db={cell.db}
            peakDb={cell.peakDb}
            label={`Microphone level of seat ${seat.seat}`}
          />
        )}
      </span>
      <span className="row nowrap small">
        {pending > 0 && (
          <span
            className={`row nowrap ${pendingWarn ? "t-warn" : "muted"}`}
            style={{ gap: 2 }}
            data-tip={`Upload backlog: ${plural(pending, "chunk")} (about ${pending * AUDIO_CHUNK_SECONDS} s of audio) recorded but not yet on the server${pendingWarn ? ". Growing or large: check this browser's network connection" : ""}`}
          >
            <Icon name="upload" /> ↑ {pending}
          </span>
        )}
        {age.ageMs !== null && (
          <span
            className={age.stale ? "row nowrap t-warn" : "faint"}
            style={{ gap: 2 }}
            data-tip={
              age.stale
                ? `No audio stored from this seat for more than ${STALE_CHUNK_MS / 1000} s although it says it records: check its browser and network`
                : `Time since the server last stored audio from this seat (chunks arrive every ${AUDIO_CHUNK_SECONDS} s)`
            }
          >
            {age.stale && <Icon name="clock" />}
            {fmtDuration(age.ageMs)} ago
          </span>
        )}
        {mic && mic.tracks > 0 && (
          <span
            className="faint"
            data-tip={`Audio stored for this seat so far, in ${plural(mic.tracks, "track")}`}
          >
            {fmtMinutes(mic.recordedMs)}
          </span>
        )}
        {check && (
          <span
            className={check === "pending" ? "muted" : "faint"}
            data-tip="The seat's own mic check (onboarding step after consent)"
          >
            check {check}
          </span>
        )}
      </span>
    </span>
  );
}

/* ─────────────────────────── Seats overview (setup page + live) ─────────────────────────── */

export function SeatsPanel({
  conn,
  dash,
  scenario,
  now,
}: {
  conn: FacilitatorConnection;
  dash: DashboardMsg;
  scenario: Scenario | null;
  now: number;
}) {
  const st = dash.state!;
  const confirm = useConfirm();
  const seats = seatList(st);
  const pLim = quotaLimit(st, "propose");
  const dLim = quotaLimit(st, "decide");
  const final = isFinalPhase(st.phase);
  const simulated = isSimulated(st);
  const audio = st.audio.enabled;
  // the server's clock now, for the age of the last stored chunk (the dashboard carries serverTs)
  const offset = useMemo(() => Date.now() - dash.serverTs, [dash.serverTs]);
  const trends = useRef({ sessionId: st.sessionId, bySeat: new Map<number, BacklogTrend>() });
  if (trends.current.sessionId !== st.sessionId)
    trends.current = { sessionId: st.sessionId, bySeat: new Map() };

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
      conn.run("participant:withdraw", { seat }, `Seat ${seat} withdrawn`);
    }
  };

  return (
    <Panel title="Seats" icon="seats">
      <GridTable
        head={[
          "Seat",
          simulated ? "Agent" : "Client",
          "Code",
          "K",
          "P",
          "View",
          "Onboarding",
          ...(audio ? ["Mic"] : []),
          "Quota",
          "Activity",
          "",
        ]}
        scroll
      >
        {seats.map((s) => {
          const stats = dash.stats[s.seat];
          const step = st.phase === "onboarding" ? nextOnboardingStep(st, s) : null;
          const mic = stats?.mic;
          const trend = nextBacklogTrend(trends.current.bySeat.get(s.seat), mic?.pendingChunks ?? 0);
          trends.current.bySeat.set(s.seat, trend);
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
              {audio && (
                <td className="small">
                  <MicColumn st={st} seat={s} mic={mic} trend={trend} serverNow={now - offset} />
                </td>
              )}
              <td className="small">
                {st.round > 0 && s.bound ? (
                  <span className="col" style={{ gap: 0 }}>
                    <span className="row nowrap gap-1" data-tip="Proposals used this round">
                      <ActSwatch kind="propose" k={s.p ? `K${s.p[1]}` : null} />
                      <AsciiProgress used={quotaUsed(st, s.seat, "propose")} limit={pLim} />
                    </span>
                    <span className="row nowrap gap-1" data-tip="Decisions used this round">
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
                  <span className="row gap-1">
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
      </GridTable>
    </Panel>
  );
}
