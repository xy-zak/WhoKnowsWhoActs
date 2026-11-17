import {
  getPolicy,
  listPolicies,
  MAX_TAG_LENGTH,
  MAX_TAGS,
  normaliseTags,
  type PlayerMode,
  policyParamRows,
  type RoundSpec,
  type Scenario,
  type SessionConfig,
  type SimulationConfig,
  seatPolicyId,
} from "@wkwa/shared";
import { useEffect, useMemo, useState } from "react";
import { MapView } from "../../map/MapView";
import {
  Button,
  Callout,
  Check,
  Chip,
  Field,
  Icon,
  type IconName,
  SeatDot,
  StatusTag,
  useConfirm,
} from "../../ui";
import type { FacilitatorConnection } from "../connection";
import { PACES, paceId, paceText, policySummary } from "../simulation";
import type { Draft } from "./draft";

export interface ScenarioInfo {
  id: string;
  title: string;
  version: string;
  description: string;
  regionCount: number;
  viewIds: string[];
  error?: string;
}

type Upd = (patch: Partial<Draft>) => void;
const setCfg = (d: Draft, upd: Upd, patch: Partial<SessionConfig>) =>
  upd({ config: { ...d.config, ...patch } });

/* ─── 01 SCENARIO ─── */

export function ScenarioStep({
  conn,
  d,
  upd,
  scenarios,
}: {
  conn: FacilitatorConnection;
  d: Draft;
  upd: Upd;
  scenarios: ScenarioInfo[];
}) {
  const [preview, setPreview] = useState<Scenario | null>(null);
  const [view, setView] = useState("");
  useEffect(() => {
    if (!d.scenarioId) return;
    conn.api<Scenario>(`/api/scenarios/${d.scenarioId}`).then(
      (s) => {
        setPreview(s);
        setView(Object.keys(s.views)[0] ?? "");
      },
      () => setPreview(null),
    );
  }, [conn, d.scenarioId]);
  const fills = useMemo(() => {
    const v = preview?.views[view];
    return v ? Object.fromEntries(Object.entries(v.regions).map(([id, c]) => [id, c.fill])) : {};
  }, [preview, view]);

  return (
    <div className="grid-2" style={{ alignItems: "start" }}>
      <div className="col">
        <span className="hint">
          Choose the map and datasets. Scenarios live in <code>scenarios/&lt;id&gt;/</code>.
        </span>
        <table className="grid">
          <tbody>
            {scenarios.map((s) => (
              <tr
                key={s.id}
                className={d.scenarioId === s.id ? "selected" : ""}
                onClick={() => !s.error && upd({ scenarioId: s.id })}
                style={{ cursor: s.error ? "not-allowed" : "pointer" }}
              >
                <td style={{ width: 24 }}>
                  <input
                    type="radio"
                    name="scenario"
                    aria-label={s.title}
                    checked={d.scenarioId === s.id}
                    disabled={Boolean(s.error)}
                    onChange={() => upd({ scenarioId: s.id })}
                  />
                </td>
                <td>
                  <strong>{s.title}</strong>
                  <div className="small muted">
                    {s.id} v{s.version} · {s.regionCount} regions · views {s.viewIds.join(" ")}
                  </div>
                  {s.error && (
                    <div className="small t-danger">
                      <Icon name="error" /> {s.error}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {preview?.description && <p className="small muted">{preview.description}</p>}
      </div>
      <div className="col">
        {preview ? (
          <>
            <div className="row">
              <span className="small muted upper">Preview</span>
              <select aria-label="Preview view" value={view} onChange={(e) => setView(e.target.value)}>
                {Object.entries(preview.views).map(([id, v]) => (
                  <option key={id} value={id}>
                    {id} — {v.name}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ height: 260 }}>
              <MapView geometry={preview} fills={fills} showNames />
            </div>
          </>
        ) : (
          <span className="faint">Select a scenario to preview it.</span>
        )}
      </div>
    </div>
  );
}

/* ─── 02 ROUNDS ─── */

function QuotaInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  return (
    <Field label={label}>
      <span className="row nowrap">
        <input
          type="number"
          min={0}
          aria-label={label}
          style={{ width: 80 }}
          value={value ?? ""}
          disabled={value === null}
          onChange={(e) => onChange(Math.max(0, Number(e.target.value)))}
        />
        <Check label="unlimited" checked={value === null} onChange={(u) => onChange(u ? null : 5)} />
      </span>
    </Field>
  );
}

export function RoundsStep({ d, upd }: { d: Draft; upd: Upd }) {
  const c = d.config;
  const r = c.defaultRound;
  const setRound = (patch: Partial<RoundSpec>) => setCfg(d, upd, { defaultRound: { ...r, ...patch } });
  let overridesOk = true;
  try {
    JSON.parse(d.overridesText.trim() || "{}");
  } catch {
    overridesOk = false;
  }
  return (
    <div className="col">
      <div className="grid-2">
        <Field label="Number of rounds">
          <input
            type="number"
            min={1}
            max={20}
            value={c.roundCount}
            onChange={(e) => setCfg(d, upd, { roundCount: Math.max(1, Number(e.target.value)) })}
          />
        </Field>
        <Field label="A round ends when">
          <select value={r.rule} onChange={(e) => setRound({ rule: e.target.value as RoundSpec["rule"] })}>
            <option value="quota">every player has used all quotas</option>
            <option value="manual">the facilitator ends it</option>
          </select>
        </Field>
        <QuotaInput
          label="Proposals per player"
          value={r.quota.propose}
          onChange={(v) => setRound({ quota: { ...r.quota, propose: v } })}
        />
        <QuotaInput
          label="Decisions per player"
          value={r.quota.decide}
          onChange={(v) => setRound({ quota: { ...r.quota, decide: v } })}
        />
        <Field label="Time limit (seconds)" hint="Empty = no limit. Paused time does not count.">
          <input
            type="number"
            min={1}
            value={r.timeLimitSec ?? ""}
            onChange={(e) => setRound({ timeLimitSec: e.target.value ? Number(e.target.value) : null })}
          />
        </Field>
        <Field label="Next round starts">
          <span className="row nowrap">
            <select
              value={c.roundAdvance}
              onChange={(e) =>
                setCfg(d, upd, { roundAdvance: e.target.value as SessionConfig["roundAdvance"] })
              }
            >
              <option value="facilitator">when the facilitator starts it</option>
              <option value="auto">automatically after</option>
            </select>
            {c.roundAdvance === "auto" && (
              <>
                <input
                  type="number"
                  min={0}
                  aria-label="Auto-advance delay"
                  style={{ width: 70 }}
                  value={c.autoAdvanceDelaySec}
                  onChange={(e) => setCfg(d, upd, { autoAdvanceDelaySec: Number(e.target.value) })}
                />
                s
              </>
            )}
          </span>
        </Field>
      </div>
      <details>
        <summary className="small upper">Per-round overrides (JSON)</summary>
        <textarea
          rows={5}
          style={{ width: "100%", marginTop: 6 }}
          value={d.overridesText}
          onChange={(e) => upd({ overridesText: e.target.value })}
          placeholder={
            '{ "3": { "rule": "quota", "quota": { "propose": 2, "decide": 2 }, "timeLimitSec": 300 } }'
          }
        />
        {!overridesOk && <span className="small t-danger">Not valid JSON.</span>}
      </details>
      <Callout icon="rounds">
        Default rule: {c.roundCount} rounds; a round ends when every player has made {r.quota.propose ?? "∞"}{" "}
        proposals and {r.quota.decide ?? "∞"} decisions
        {r.timeLimitSec ? `, or after ${r.timeLimitSec} s` : ""}.
      </Callout>
    </div>
  );
}

/* ─── 03 PLAYERS & VISIBILITY ─── */

const PLAYER_MODES: Array<{ id: PlayerMode; icon: IconName; title: string; text: string }> = [
  {
    id: "real",
    icon: "seats",
    title: "Real participants",
    text: "People on the player PCs. Consent, participant codes, client binding and the key sheet, as usual. Stored in the participant database (data/wkwa.db).",
  },
  {
    id: "simulated",
    icon: "agent",
    title: "Simulated players",
    text: "An agent plays every seat, following a policy. No consent, codes, clients or key sheet. Stored in the separate simulation database (data/wkwa-sim.db).",
  },
];

function PlayerModeChoice({ d, upd }: { d: Draft; upd: Upd }) {
  const mode = d.config.players;
  return (
    <div className="col">
      <h3>Who plays</h3>
      <table className="grid">
        <tbody>
          {PLAYER_MODES.map((m) => (
            <tr
              key={m.id}
              className={mode === m.id ? "selected" : ""}
              onClick={() => setCfg(d, upd, { players: m.id })}
              style={{ cursor: "pointer" }}
            >
              <td style={{ width: 24 }}>
                <input
                  type="radio"
                  name="players"
                  aria-label={m.title}
                  checked={mode === m.id}
                  onChange={() => setCfg(d, upd, { players: m.id })}
                />
              </td>
              <td>
                <strong>
                  <Icon name={m.icon} /> {m.title}
                </strong>
                <div className="small muted">{m.text}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Agent policies, pace, seed and parameters (only when players are simulated). */
function SimulationSettings({ d, upd }: { d: Draft; upd: Upd }) {
  const c = d.config;
  const sim = c.simulation;
  const set = (patch: Partial<SimulationConfig>) => setCfg(d, upd, { simulation: { ...sim, ...patch } });
  const policies = listPolicies();
  const main = getPolicy(sim.policy);
  const pace = paceId(sim);
  const used = [...new Set(Array.from({ length: c.seatCount }, (_, i) => seatPolicyId(sim, i + 1)))];
  let paramsOk = true;
  try {
    JSON.parse(d.simParamsText.trim() || "{}");
  } catch {
    paramsOk = false;
  }
  const setSeat = (seat: number, id: string) => {
    const seatPolicies = { ...sim.seatPolicies };
    if (id) seatPolicies[String(seat)] = id;
    else delete seatPolicies[String(seat)];
    set({ seatPolicies });
  };
  return (
    <div className="grid-2" style={{ alignItems: "start" }}>
      <div className="col">
        <h3>
          <Icon name="agent" /> Agents
        </h3>
        <Field label="Policy for every seat" hint={main?.description}>
          <select value={sim.policy} onChange={(e) => set({ policy: e.target.value })}>
            {policies.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.id} v{p.version})
              </option>
            ))}
          </select>
        </Field>
        <table className="grid">
          <tbody>
            {Array.from({ length: c.seatCount }, (_, i) => i + 1).map((seat) => (
              <tr key={seat}>
                <td style={{ width: 90 }}>
                  <span className="row nowrap">
                    <SeatDot seat={seat} /> <strong>SEAT {seat}</strong>
                  </span>
                </td>
                <td>
                  <select
                    aria-label={`Policy of seat ${seat}`}
                    value={sim.seatPolicies[String(seat)] ?? ""}
                    onChange={(e) => setSeat(seat, e.target.value)}
                  >
                    <option value="">same as every seat ({sim.policy})</option>
                    {policies.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.id})
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <span className="hint">
          Policies live in <code>packages/shared/src/simulation/policies.ts</code>. The rules for simulated
          players are added there.
        </span>
      </div>
      <div className="col">
        <h3>
          <Icon name="clock" /> Pace &amp; seed
        </h3>
        <Field
          label="Pause before each agent's turn"
          hint="Watch it live in LIVE, or run it as fast as possible."
        >
          <span className="row nowrap">
            <select
              value={pace}
              onChange={(e) => {
                const p = PACES.find((x) => x.id === e.target.value);
                if (p) set({ minDelayMs: p.min, maxDelayMs: p.max });
              }}
            >
              {PACES.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
              <option value="custom">Custom…</option>
            </select>
            {pace === "custom" && (
              <>
                <input
                  type="number"
                  min={0}
                  step={100}
                  aria-label="Shortest pause (ms)"
                  style={{ width: 80 }}
                  value={sim.minDelayMs}
                  onChange={(e) => set({ minDelayMs: Math.max(0, Number(e.target.value)) })}
                />
                –
                <input
                  type="number"
                  min={0}
                  step={100}
                  aria-label="Longest pause (ms)"
                  style={{ width: 80 }}
                  value={sim.maxDelayMs}
                  onChange={(e) => set({ maxDelayMs: Math.max(0, Number(e.target.value)) })}
                />
                ms
              </>
            )}
          </span>
        </Field>
        <Field
          label="Seed"
          hint="The agents' random choices follow the seed. At 0 s a run with the same seed and settings repeats exactly. Empty = drawn at random when the session is created (and logged)."
        >
          <input
            type="text"
            maxLength={40}
            value={sim.seed ?? ""}
            onChange={(e) => set({ seed: e.target.value.trim() || null })}
            placeholder="random"
          />
        </Field>
        <details>
          <summary className="small upper">Policy parameters (JSON)</summary>
          <textarea
            rows={4}
            aria-label="Policy parameters (JSON)"
            style={{ width: "100%", marginTop: 6 }}
            value={d.simParamsText}
            onChange={(e) => upd({ simParamsText: e.target.value })}
            placeholder={'{ "random": { "proposeBias": 0.7 } }'}
          />
          {!paramsOk && <span className="small t-danger">Not valid JSON.</span>}
          <table className="grid">
            <tbody>
              {used.flatMap((id) => {
                const p = getPolicy(id);
                const rows = p ? policyParamRows(p) : [];
                return rows.length === 0
                  ? [
                      <tr key={id}>
                        <td className="mono small">{id}</td>
                        <td colSpan={2} className="faint small">
                          no parameters
                        </td>
                      </tr>,
                    ]
                  : rows.map((r) => (
                      <tr key={`${id}.${r.name}`}>
                        <td className="mono small">
                          {id}.{r.name}
                        </td>
                        <td className="mono small">
                          {r.defaultValue === undefined ? "" : JSON.stringify(r.defaultValue)}
                        </td>
                        <td className="small">{r.description}</td>
                      </tr>
                    ));
              })}
            </tbody>
          </table>
        </details>
      </div>
    </div>
  );
}

export function PlayersStep({ d, upd }: { d: Draft; upd: Upd }) {
  const c = d.config;
  const simulated = c.players === "simulated";
  const vis = (patch: Partial<SessionConfig["visibility"]>) =>
    setCfg(d, upd, { visibility: { ...c.visibility, ...patch } });
  return (
    <div className="col" style={{ gap: "var(--s3)" }}>
      <PlayerModeChoice d={d} upd={upd} />
      {simulated && <SimulationSettings d={d} upd={upd} />}
      <div className="grid-2" style={{ alignItems: "start" }}>
        <div className="col">
          <h3>Seats &amp; labels</h3>
          <Field label="Seats" hint="4 for real sessions; fewer for pilots.">
            <input
              type="number"
              min={1}
              max={4}
              value={c.seatCount}
              onChange={(e) =>
                setCfg(d, upd, { seatCount: Math.min(4, Math.max(1, Number(e.target.value))) })
              }
            />
          </Field>
          <Field label="Map view per seat">
            <select
              value={c.viewAssignment}
              onChange={(e) =>
                setCfg(d, upd, { viewAssignment: e.target.value as SessionConfig["viewAssignment"] })
              }
            >
              <option value="byKnowledgeType">follows the K label (Ka → view Ka)</option>
              <option value="manual">chosen per seat</option>
            </select>
          </Field>
          <span className="hint">
            K and P labels are assigned in step 08: each K once, P follows from the pairing (aligned or fully
            dissociated D1–D6).
          </span>
          <h3 style={{ marginTop: 8 }}>What players see</h3>
          <Check
            label="Which seat proposed / decided"
            checked={c.visibility.showActorToPlayers}
            onChange={(v) => vis({ showActorToPlayers: v })}
          />
          <Check
            label="Their own K/P labels"
            checked={c.visibility.showOwnLabels}
            onChange={(v) => vis({ showOwnLabels: v })}
          />
          <Check
            label="Other seats' K/P labels"
            checked={c.visibility.showOtherLabelsToPlayers}
            onChange={(v) => vis({ showOtherLabelsToPlayers: v })}
          />
          <Check
            label="Other seats' quota progress"
            checked={c.visibility.showOthersProgress}
            onChange={(v) => vis({ showOthersProgress: v })}
          />
          <Check
            label="Clear highlights at the start of each round"
            checked={c.clearHighlightsEachRound}
            onChange={(v) => setCfg(d, upd, { clearHighlightsEachRound: v })}
          />
          {!simulated && (
            <Check
              label="Pause automatically when a player disconnects"
              checked={c.pauseOnDisconnect}
              onChange={(v) => setCfg(d, upd, { pauseOnDisconnect: v })}
            />
          )}
        </div>
        <div className="col">
          {simulated ? (
            <>
              <h3>What agents see</h3>
              <Callout icon="agent">
                An agent sees exactly what a player of its seat would see: its own map view, the highlights
                and what the settings on the left allow. Its actions go through the same rules and quotas and
                are logged like a player's.
              </Callout>
            </>
          ) : (
            <>
              <h3>Player screens</h3>
              <Callout icon="display">
                Display settings are <strong>each participant's own choice</strong>, made on their screen with
                the <strong>DISPLAY</strong> button (bottom right): colours (Latte, Mocha, High contrast),
                font (JetBrains Mono, OpenDyslexic, System font), text size (Small, Large) and animations
                (on/off).
              </Callout>
              <span className="hint">
                They are accessibility settings, so they stay on that PC and are never sent to the server or
                recorded. Animations are always off when the PC's OS asks for reduced motion.
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── 04 ONBOARDING ─── */

export function OnboardingStep({ d, upd }: { d: Draft; upd: Upd }) {
  const confirm = useConfirm();
  const o = d.config.onboarding;
  if (d.config.players === "simulated") {
    return (
      <Callout icon="agent">
        Simulated players skip onboarding: there is no consent, demographics or briefing for agents. These
        settings apply to sessions with real participants (step 03).
      </Callout>
    );
  }
  const set = (patch: Partial<SessionConfig["onboarding"]>) =>
    setCfg(d, upd, { onboarding: { ...o, ...patch } });
  return (
    <div className="col">
      <span className="hint">
        What every participant goes through before round 1 (texts in <code>config/</code>).
      </span>
      <Check
        label={
          <>
            <Icon name="consent" /> Consent screen
          </>
        }
        hint={
          o.consent
            ? "Shows config/consent.md and the consent statements; nothing is recorded before consent."
            : undefined
        }
        checked={o.consent}
        onChange={async (v) => {
          if (v) return set({ consent: true });
          const ok = await confirm({
            title: "Disable consent?",
            message: (
              <>
                <p>Only for tests without real participants.</p>
                <p className="muted">
                  Without the consent screen, data is collected without a consent record.
                </p>
              </>
            ),
            confirmLabel: "Disable consent",
            danger: true,
          });
          if (ok) set({ consent: false });
        }}
      />
      <Check
        label={
          <>
            <Icon name="demographics" /> Demographics questionnaire
          </>
        }
        checked={o.demographics}
        onChange={(v) => set({ demographics: v })}
      />
      <Check
        label={
          <>
            <Icon name="onboarding" /> Briefing / instructions
          </>
        }
        checked={o.briefing}
        onChange={(v) => set({ briefing: v })}
      />
      {!o.consent && (
        <Callout tone="danger" icon="warning">
          Consent is disabled — do not use this session with real participants.
        </Callout>
      )}
    </div>
  );
}

/* ─── 05 TAGS & NOTES ─── */

export function TagsStep({ d, upd }: { d: Draft; upd: Upd }) {
  const tags = normaliseTags(d.tagsText);
  const rawCount = d.tagsText.split(",").filter((t) => t.trim()).length;
  const tooLong = d.tagsText.split(",").some((t) => t.trim().length > MAX_TAG_LENGTH);
  return (
    <div className="col">
      <Field
        label="Tags"
        hint={
          <>
            Comma-separated, e.g. <code>pilot, condition-A, group 2</code>. Used to filter and describe
            sessions in the dataset.
          </>
        }
      >
        <input
          type="text"
          value={d.tagsText}
          onChange={(e) => upd({ tagsText: e.target.value })}
          placeholder="pilot, condition-A"
        />
      </Field>
      <div className="row">
        {tags.length === 0 ? (
          <span className="faint small">No tags.</span>
        ) : (
          tags.map((t) => (
            <Chip key={t}>
              <Icon name="tag" />
              {t}
            </Chip>
          ))
        )}
      </div>
      {(rawCount > MAX_TAGS || tooLong || rawCount !== tags.length) && (
        <Callout tone="warn" icon="warning">
          {rawCount > MAX_TAGS && `Only the first ${MAX_TAGS} tags are kept. `}
          {tooLong && `Tags are shortened to ${MAX_TAG_LENGTH} characters. `}
          {rawCount !== tags.length && rawCount <= MAX_TAGS && "Duplicates (ignoring case) are merged."}
        </Callout>
      )}
      <Field label="Notes" hint="Stored with the session. Never type participants' names.">
        <textarea
          rows={3}
          maxLength={1000}
          value={d.notes}
          onChange={(e) => upd({ notes: e.target.value })}
        />
      </Field>
    </div>
  );
}

/* ─── 06 REVIEW ─── */

export function ReviewStep({
  d,
  scenarios,
  config,
  error,
  goTo,
}: {
  d: Draft;
  scenarios: ScenarioInfo[];
  config: SessionConfig | null;
  error: string | null;
  goTo: (i: number) => void;
}) {
  const sc = scenarios.find((s) => s.id === d.scenarioId);
  const c = config ?? d.config;
  const r = c.defaultRound;
  const simulated = c.players === "simulated";
  const yes = (b: boolean) => (b ? "yes" : "no");
  const rows: Array<[number, string, string]> = [
    [0, "Scenario", sc ? `${sc.title} (${sc.id} v${sc.version})` : "— not chosen —"],
    [
      1,
      "Rounds",
      `${c.roundCount} × ${r.rule === "quota" ? "ends when quotas are used" : "ends by facilitator"}`,
    ],
    [
      1,
      "Quotas per player",
      `propose ${r.quota.propose ?? "∞"} · decide ${r.quota.decide ?? "∞"}${r.timeLimitSec ? ` · limit ${r.timeLimitSec}s` : ""}`,
    ],
    [
      1,
      "Next round",
      c.roundAdvance === "auto" ? `auto after ${c.autoAdvanceDelaySec}s` : "facilitator starts it",
    ],
    [
      1,
      "Overrides",
      Object.keys(c.roundOverrides).length ? `rounds ${Object.keys(c.roundOverrides).join(", ")}` : "none",
    ],
    [
      2,
      "Players",
      simulated
        ? `simulated · ${policySummary(c.simulation, c.seatCount)} · pause ${paceText(c.simulation)} · seed ${c.simulation.seed ?? "random (logged)"}`
        : "real participants",
    ],
    [
      2,
      "Database",
      simulated
        ? "simulation database (data/wkwa-sim.db), session id SIM-…"
        : "participant database (data/wkwa.db)",
    ],
    [2, "Seats", `${c.seatCount} · view ${c.viewAssignment === "byKnowledgeType" ? "follows K" : "manual"}`],
    [
      2,
      "Players see",
      `actors ${yes(c.visibility.showActorToPlayers)} · own labels ${yes(c.visibility.showOwnLabels)} · others' labels ${yes(c.visibility.showOtherLabelsToPlayers)} · others' progress ${yes(c.visibility.showOthersProgress)}`,
    ],
    [2, "Highlights", c.clearHighlightsEachRound ? "cleared each round" : "kept across rounds"],
    ...(simulated
      ? []
      : ([
          [2, "Disconnect", c.pauseOnDisconnect ? "auto-pause" : "keep playing"],
          [2, "Player screens", "display settings: each player's own choice (not recorded)"],
        ] as Array<[number, string, string]>)),
    [
      3,
      "Onboarding",
      simulated
        ? "none (simulated players)"
        : [
            c.onboarding.consent && "consent",
            c.onboarding.demographics && "demographics",
            c.onboarding.briefing && "briefing",
          ]
            .filter(Boolean)
            .join(" → ") || "none",
    ],
    [4, "Tags", c.tags.length ? c.tags.join(", ") : "none"],
    [4, "Notes", d.notes || "—"],
  ];
  return (
    <div className="col">
      <table className="grid">
        <tbody>
          {rows.map(([step, k, v]) => (
            <tr key={k}>
              <td className="muted upper small" style={{ width: 160 }}>
                {k}
              </td>
              <td>{v}</td>
              <td style={{ width: 60, textAlign: "right" }}>
                <Button size="sm" variant="ghost" onClick={() => goTo(step)}>
                  Edit
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!simulated && !c.onboarding.consent && (
        <StatusTag tone="danger" icon="warning">
          consent disabled
        </StatusTag>
      )}
      {simulated && <StatusTag icon="simulation">simulated players · simulation database</StatusTag>}
      {error ? (
        <Callout tone="danger" icon="error">
          {error}
        </Callout>
      ) : (
        <Callout icon="info">
          Creating the session writes these settings into its first event (<code>SessionCreated</code>). They
          cannot be changed afterwards — steps 01–06 are then locked.
        </Callout>
      )}
    </div>
  );
}
