import { type RoundSpec, type SessionConfig, SessionConfigSchema } from "@wkwa/shared";
import { useEffect, useState } from "react";
import type { FacilitatorConnection } from "./connection";

interface ScenarioInfo {
  id: string;
  title: string;
  version: string;
  description: string;
  regionCount: number;
  viewIds: string[];
  error?: string;
}

function Check({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  return (
    <label className="row" style={{ alignItems: "flex-start", flexWrap: "nowrap" }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ marginTop: 4 }}
      />
      <span>
        {label}
        {hint && <div className="small muted">{hint}</div>}
      </span>
    </label>
  );
}

function QuotaInput({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  return (
    <span className="row" style={{ gap: 4 }}>
      <input
        type="number"
        min={0}
        style={{ width: 70 }}
        value={value ?? ""}
        disabled={value === null}
        onChange={(e) => onChange(Math.max(0, Number(e.target.value)))}
      />
      <label className="small row" style={{ gap: 3 }}>
        <input
          type="checkbox"
          checked={value === null}
          onChange={(e) => onChange(e.target.checked ? null : 5)}
        />{" "}
        unlimited
      </label>
    </span>
  );
}

export function Setup({
  conn,
  onCreated,
  hasLiveSession,
}: {
  conn: FacilitatorConnection;
  onCreated: () => void;
  hasLiveSession: boolean;
}) {
  const [scenarios, setScenarios] = useState<ScenarioInfo[]>([]);
  const [scenarioId, setScenarioId] = useState("");
  const [cfg, setCfg] = useState<SessionConfig>(SessionConfigSchema.parse({}));
  const [notes, setNotes] = useState("");
  const [overrides, setOverrides] = useState("{}");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    conn.api<ScenarioInfo[]>("/api/scenarios").then(
      (list) => {
        setScenarios(list);
        setScenarioId((cur) => cur || list.find((s) => !s.error)?.id || "");
      },
      () => {},
    );
    conn.api<SessionConfig>("/api/config/session-defaults").then(
      (d) => {
        setCfg(d);
        setOverrides(JSON.stringify(d.roundOverrides, null, 2));
      },
      () => {},
    );
  }, [conn]);

  const set = <K extends keyof SessionConfig>(k: K, v: SessionConfig[K]) => setCfg((c) => ({ ...c, [k]: v }));
  const setRound = (patch: Partial<RoundSpec>) =>
    setCfg((c) => ({ ...c, defaultRound: { ...c.defaultRound, ...patch } }));
  const r = cfg.defaultRound;
  const sc = scenarios.find((s) => s.id === scenarioId);

  const create = async () => {
    let roundOverrides: SessionConfig["roundOverrides"];
    try {
      roundOverrides = JSON.parse(overrides || "{}");
    } catch {
      conn.toast("Per-round overrides: invalid JSON", "error");
      return;
    }
    const parsed = SessionConfigSchema.safeParse({ ...cfg, roundOverrides });
    if (!parsed.success) {
      conn.toast(
        `Invalid configuration: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`,
        "error",
      );
      return;
    }
    setBusy(true);
    try {
      await conn.cmd("session:create", { scenarioId, config: parsed.data, notes }, "Session created");
      onCreated();
    } catch {
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="col" style={{ maxWidth: 1100, gap: 10 }}>
      {hasLiveSession && (
        <div className="banner">
          A session is currently running. Creating a new one detaches it (its data is kept; you can resume it
          from the Data tab).
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, alignItems: "start" }}>
        <div className="panel col">
          <h2>Scenario</h2>
          <select value={scenarioId} onChange={(e) => setScenarioId(e.target.value)}>
            {scenarios.map((s) => (
              <option key={s.id} value={s.id} disabled={Boolean(s.error)}>
                {s.title} ({s.id} v{s.version}){s.error ? " — ERROR" : ""}
              </option>
            ))}
          </select>
          {sc && (
            <p className="small muted" style={{ margin: 0 }}>
              {sc.description} · {sc.regionCount} regions · views {sc.viewIds.join(", ")}
            </p>
          )}
          {scenarios
            .filter((s) => s.error)
            .map((s) => (
              <p key={s.id} className="small" style={{ color: "var(--danger)", margin: 0 }}>
                {s.id}: {s.error}
              </p>
            ))}
          <h2 style={{ marginTop: 12 }}>Rounds</h2>
          <div className="row">
            <label>
              Number of rounds{" "}
              <input
                type="number"
                min={1}
                max={20}
                style={{ width: 60 }}
                value={cfg.roundCount}
                onChange={(e) => set("roundCount", Number(e.target.value))}
              />
            </label>
            <label>
              Seats{" "}
              <input
                type="number"
                min={1}
                max={4}
                style={{ width: 50 }}
                value={cfg.seatCount}
                onChange={(e) => set("seatCount", Number(e.target.value))}
              />
            </label>
          </div>
          <label className="row">
            A round ends when
            <select value={r.rule} onChange={(e) => setRound({ rule: e.target.value as RoundSpec["rule"] })}>
              <option value="quota">every player has used all quotas</option>
              <option value="manual">the facilitator ends it (quotas still cap actions)</option>
            </select>
          </label>
          <div className="row">
            Proposals per player{" "}
            <QuotaInput
              value={r.quota.propose}
              onChange={(v) => setRound({ quota: { ...r.quota, propose: v } })}
            />
          </div>
          <div className="row">
            Decisions per player{" "}
            <QuotaInput
              value={r.quota.decide}
              onChange={(v) => setRound({ quota: { ...r.quota, decide: v } })}
            />
          </div>
          <label className="row">
            Time limit (s, empty = none)
            <input
              type="number"
              min={1}
              style={{ width: 90 }}
              value={r.timeLimitSec ?? ""}
              onChange={(e) => setRound({ timeLimitSec: e.target.value ? Number(e.target.value) : null })}
            />
          </label>
          <label className="row">
            Next round starts
            <select
              value={cfg.roundAdvance}
              onChange={(e) => set("roundAdvance", e.target.value as SessionConfig["roundAdvance"])}
            >
              <option value="facilitator">when the facilitator clicks</option>
              <option value="auto">automatically after</option>
            </select>
            {cfg.roundAdvance === "auto" && (
              <>
                <input
                  type="number"
                  min={0}
                  style={{ width: 60 }}
                  value={cfg.autoAdvanceDelaySec}
                  onChange={(e) => set("autoAdvanceDelaySec", Number(e.target.value))}
                />{" "}
                s
              </>
            )}
          </label>
          <details>
            <summary className="small">Per-round overrides (JSON)</summary>
            <textarea
              rows={5}
              style={{ width: "100%", fontFamily: "var(--mono)", fontSize: 12 }}
              value={overrides}
              onChange={(e) => setOverrides(e.target.value)}
              placeholder={
                '{ "3": { "rule": "quota", "quota": { "propose": 2, "decide": 2 }, "timeLimitSec": 300 } }'
              }
            />
          </details>
        </div>

        <div className="panel col">
          <h2>Players &amp; visibility</h2>
          <label className="row">
            Map view per seat
            <select
              value={cfg.viewAssignment}
              onChange={(e) => set("viewAssignment", e.target.value as SessionConfig["viewAssignment"])}
            >
              <option value="byKnowledgeType">follows the K label (Ka → view Ka)</option>
              <option value="manual">chosen manually per seat</option>
            </select>
          </label>
          <Check
            label="Allow two seats to share a K or P label"
            checked={cfg.allowDuplicateLabels}
            onChange={(v) => set("allowDuplicateLabels", v)}
          />
          <Check
            label="Players see which seat proposed/decided"
            checked={cfg.visibility.showActorToPlayers}
            onChange={(v) => set("visibility", { ...cfg.visibility, showActorToPlayers: v })}
          />
          <Check
            label="Players see their own K/P labels"
            checked={cfg.visibility.showOwnLabels}
            onChange={(v) => set("visibility", { ...cfg.visibility, showOwnLabels: v })}
          />
          <Check
            label="Players see other seats' K/P labels"
            checked={cfg.visibility.showOtherLabelsToPlayers}
            onChange={(v) => set("visibility", { ...cfg.visibility, showOtherLabelsToPlayers: v })}
          />
          <Check
            label="Players see other seats' progress"
            checked={cfg.visibility.showOthersProgress}
            onChange={(v) => set("visibility", { ...cfg.visibility, showOthersProgress: v })}
          />
          <Check
            label="Clear highlights at the start of each round"
            checked={cfg.clearHighlightsEachRound}
            onChange={(v) => set("clearHighlightsEachRound", v)}
          />
          <Check
            label="Pause automatically when a player disconnects"
            checked={cfg.pauseOnDisconnect}
            onChange={(v) => set("pauseOnDisconnect", v)}
          />
          <h2 style={{ marginTop: 12 }}>Onboarding</h2>
          <Check
            label="Consent screen"
            checked={cfg.onboarding.consent}
            onChange={(v) => set("onboarding", { ...cfg.onboarding, consent: v })}
            hint={
              cfg.onboarding.consent
                ? undefined
                : "⚠ Only for tests without real participants: data is then collected without a consent record."
            }
          />
          <Check
            label="Demographics questionnaire"
            checked={cfg.onboarding.demographics}
            onChange={(v) => set("onboarding", { ...cfg.onboarding, demographics: v })}
          />
          <Check
            label="Briefing screen"
            checked={cfg.onboarding.briefing}
            onChange={(v) => set("onboarding", { ...cfg.onboarding, briefing: v })}
          />
          <h2 style={{ marginTop: 12 }}>Labels for the dataset</h2>
          <label className="col" style={{ gap: 2 }}>
            Condition <span className="small muted">e.g. "A" or "pilot" — never personal data</span>
            <input
              type="text"
              maxLength={100}
              value={cfg.condition}
              onChange={(e) => set("condition", e.target.value)}
            />
          </label>
          <label className="col" style={{ gap: 2 }}>
            Notes
            <textarea rows={2} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </label>
        </div>
      </div>
      <div className="row">
        <button type="button" className="primary big" disabled={!scenarioId || busy} onClick={create}>
          Create session
        </button>
        <span className="small muted">
          Settings are stored verbatim in the session's first event (SessionCreated).
        </span>
      </div>
    </div>
  );
}
