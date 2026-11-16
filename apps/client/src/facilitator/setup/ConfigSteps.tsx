import {
  MAX_TAG_LENGTH,
  MAX_TAGS,
  normaliseTags,
  type RoundSpec,
  type Scenario,
  type SessionConfig,
} from "@wkwa/shared";
import { useEffect, useMemo, useState } from "react";
import { MapView } from "../../map/MapView";
import { Button, Callout, Check, Chip, Field, Icon, StatusTag, THEME_LABEL, useConfirm } from "../../ui";
import type { FacilitatorConnection } from "../connection";
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

export function PlayersStep({ d, upd }: { d: Draft; upd: Upd }) {
  const c = d.config;
  const vis = (patch: Partial<SessionConfig["visibility"]>) =>
    setCfg(d, upd, { visibility: { ...c.visibility, ...patch } });
  const app = (patch: Partial<SessionConfig["appearance"]>) =>
    setCfg(d, upd, { appearance: { ...c.appearance, ...patch } });
  return (
    <div className="grid-2" style={{ alignItems: "start" }}>
      <div className="col">
        <h3>Seats &amp; labels</h3>
        <Field label="Seats" hint="4 for real sessions; fewer for pilots.">
          <input
            type="number"
            min={1}
            max={4}
            value={c.seatCount}
            onChange={(e) => setCfg(d, upd, { seatCount: Math.min(4, Math.max(1, Number(e.target.value))) })}
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
        <Check
          label="Pause automatically when a player disconnects"
          checked={c.pauseOnDisconnect}
          onChange={(v) => setCfg(d, upd, { pauseOnDisconnect: v })}
        />
      </div>
      <div className="col">
        <h3>Player screen appearance</h3>
        <span className="hint">
          Identical on every player PC and recorded with the session (part of the experimental condition).
        </span>
        <div className="row">
          {(["mocha", "latte", "contrast"] as const).map((t) => (
            <label key={t} className="check" style={{ alignItems: "center" }}>
              <input
                type="radio"
                name="playerTheme"
                checked={c.appearance.playerTheme === t}
                onChange={() => app({ playerTheme: t })}
              />
              <span
                data-theme={t}
                style={{
                  display: "inline-flex",
                  gap: 6,
                  alignItems: "center",
                  padding: "6px 10px",
                  border: "1px solid var(--control)",
                  background: "var(--panel)",
                  color: "var(--text)",
                }}
              >
                <Icon name={t === "mocha" ? "themeDark" : t === "latte" ? "themeLight" : "themeContrast"} />
                {THEME_LABEL[t].toUpperCase()}
              </span>
            </label>
          ))}
        </div>
        <Check
          label="Animations on player screens"
          hint="Screen-switch, popup and connect/disconnect animations. No scanlines or glow. Always off for players whose OS requests reduced motion."
          checked={c.appearance.playerAnimations}
          onChange={(v) => app({ playerAnimations: v })}
        />
      </div>
    </div>
  );
}

/* ─── 04 ONBOARDING ─── */

export function OnboardingStep({ d, upd }: { d: Draft; upd: Upd }) {
  const confirm = useConfirm();
  const o = d.config.onboarding;
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
    [2, "Seats", `${c.seatCount} · view ${c.viewAssignment === "byKnowledgeType" ? "follows K" : "manual"}`],
    [
      2,
      "Players see",
      `actors ${yes(c.visibility.showActorToPlayers)} · own labels ${yes(c.visibility.showOwnLabels)} · others' labels ${yes(c.visibility.showOtherLabelsToPlayers)} · others' progress ${yes(c.visibility.showOthersProgress)}`,
    ],
    [2, "Highlights", c.clearHighlightsEachRound ? "cleared each round" : "kept across rounds"],
    [2, "Disconnect", c.pauseOnDisconnect ? "auto-pause" : "keep playing"],
    [
      2,
      "Player screens",
      `${c.appearance.playerTheme.toUpperCase()} · animations ${c.appearance.playerAnimations ? "on" : "off"}`,
    ],
    [
      3,
      "Onboarding",
      [
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
      {!c.onboarding.consent && (
        <StatusTag tone="danger" icon="warning">
          consent disabled
        </StatusTag>
      )}
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
