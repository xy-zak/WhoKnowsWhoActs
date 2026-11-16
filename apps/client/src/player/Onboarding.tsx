import type { PlayerView } from "@wkwa/shared";
import { useRef, useState } from "react";
import { Markdown } from "../common/Markdown";
import type { PlayerConnection } from "./connection";

function Page({ title, children, step }: { title: string; step: string; children: React.ReactNode }) {
  return (
    <div style={{ maxWidth: 820, margin: "0 auto", padding: "2rem 1.2rem 4rem" }}>
      <p className="muted small" style={{ marginBottom: 4 }}>
        {step}
      </p>
      <h1>{title}</h1>
      <div className="panel">{children}</div>
    </div>
  );
}

function useOpenedAt() {
  return useRef(performance.now()).current;
}

export function ConsentScreen({ conn, view }: { conn: PlayerConnection; view: PlayerView }) {
  const c = view.onboarding!.consent;
  const study = view.onboarding!.study;
  const openedAt = useOpenedAt();
  const [answers, setAnswers] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [confirmDecline, setConfirmDecline] = useState(false);
  const allRequired = c.items.every((i) => !i.required || answers[i.id]);

  const submit = async (decline: boolean) => {
    setBusy(true);
    try {
      const final = decline ? Object.fromEntries(c.items.map((i) => [i.id, false])) : answers;
      await conn.request("consent:submit", {
        formVersion: c.version,
        textSha256: c.sha256,
        answers: Object.fromEntries(c.items.map((i) => [i.id, final[i.id] === true])),
        durationMs: Math.round(performance.now() - openedAt),
        clientTs: conn.clock.now(),
      });
    } catch (e) {
      conn.showToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page title="Consent" step="Step 1 of 3">
      <Markdown text={c.markdown} />
      <div className="panel" style={{ background: "var(--panel-2)", boxShadow: "none", margin: "1rem 0" }}>
        <strong>{study.title}</strong>
        <div className="small">
          {study.researcher}
          {study.institution && ` · ${study.institution}`}
          {study.supervisor && ` · supervisor: ${study.supervisor}`}
        </div>
        <div className="small">Contact: {study.contactEmail}</div>
        <div className="small muted">{study.retention}</div>
      </div>
      <div className="col" style={{ gap: "0.7rem" }}>
        {c.items.map((item) => (
          <label key={item.id} className="row" style={{ alignItems: "flex-start", flexWrap: "nowrap" }}>
            <input
              type="checkbox"
              style={{ marginTop: 4, width: 18, height: 18 }}
              checked={answers[item.id] === true}
              onChange={(e) => setAnswers((a) => ({ ...a, [item.id]: e.target.checked }))}
            />
            <span>
              {item.text} {item.required && <span style={{ color: "var(--danger)" }}>*</span>}
            </span>
          </label>
        ))}
      </div>
      <p className="small muted">* required to take part · consent form version {c.version}</p>
      <div className="row" style={{ marginTop: "1rem" }}>
        <button
          type="button"
          className="primary big"
          disabled={!allRequired || busy}
          onClick={() => submit(false)}
        >
          I agree — continue
        </button>
        <span className="spacer" />
        {!confirmDecline ? (
          <button type="button" disabled={busy} onClick={() => setConfirmDecline(true)}>
            I do not want to take part
          </button>
        ) : (
          <span className="row">
            <span className="small">Are you sure?</span>
            <button type="button" className="danger" disabled={busy} onClick={() => submit(true)}>
              Yes, I decline
            </button>
            <button type="button" onClick={() => setConfirmDecline(false)}>
              Back
            </button>
          </span>
        )}
      </div>
    </Page>
  );
}

export function DeclinedScreen() {
  return (
    <div style={{ minHeight: "100%", display: "grid", placeItems: "center", padding: "2rem" }}>
      <div className="panel" style={{ maxWidth: 560, textAlign: "center" }}>
        <h1>Thank you</h1>
        <p>You chose not to take part. No game data will be collected from you.</p>
        <p className="muted">Please let the facilitator know.</p>
      </div>
    </div>
  );
}

export function DemographicsScreen({ conn, view }: { conn: PlayerConnection; view: PlayerView }) {
  const form = view.onboarding!.demographics;
  const openedAt = useOpenedAt();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const complete = form.questions.every((q) => answers[q.id]);

  const submit = async () => {
    setBusy(true);
    try {
      await conn.request("demographics:submit", {
        formVersion: form.version,
        answers,
        durationMs: Math.round(performance.now() - openedAt),
        clientTs: conn.clock.now(),
      });
    } catch (e) {
      conn.showToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page title="About you" step="Step 2 of 3">
      {form.intro && <p className="muted">{form.intro}</p>}
      <div className="col" style={{ gap: "1.2rem" }}>
        {form.questions.map((q) => (
          <fieldset key={q.id} style={{ border: "none", padding: 0, margin: 0 }}>
            <legend style={{ fontWeight: 600, marginBottom: 6 }}>{q.text}</legend>
            <div className="row" style={{ gap: "0.4rem 1.2rem" }}>
              {q.options.map((o) => (
                <label key={o.value} className="row" style={{ gap: 6 }}>
                  <input
                    type="radio"
                    name={q.id}
                    checked={answers[q.id] === o.value}
                    onChange={() => setAnswers((a) => ({ ...a, [q.id]: o.value }))}
                  />
                  {o.label}
                </label>
              ))}
            </div>
          </fieldset>
        ))}
      </div>
      <div className="row" style={{ marginTop: "1.5rem" }}>
        <button type="button" className="primary big" disabled={!complete || busy} onClick={submit}>
          Continue
        </button>
      </div>
    </Page>
  );
}

export function BriefingScreen({ conn, view }: { conn: PlayerConnection; view: PlayerView }) {
  const b = view.onboarding!.briefing;
  const openedAt = useOpenedAt();
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await conn.request("briefing:ack", {
        textSha256: b.sha256,
        durationMs: Math.round(performance.now() - openedAt),
        clientTs: conn.clock.now(),
      });
    } catch (e) {
      conn.showToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Page title="Briefing" step="Step 3 of 3">
      <Markdown text={b.markdown} />
      {(view.me.k || view.me.p) && (
        <p>
          Your roles: <span className="pill">{view.me.k}</span> <span className="pill">{view.me.p}</span>
          {view.me.viewName && <span className="muted"> · your information source: {view.me.viewName}</span>}
        </p>
      )}
      <div className="row" style={{ marginTop: "1rem" }}>
        <button type="button" className="primary big" disabled={busy} onClick={submit}>
          I'm ready
        </button>
      </div>
    </Page>
  );
}
