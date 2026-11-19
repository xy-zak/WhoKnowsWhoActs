import { consentSections, type PlayerView } from "@wkwa/shared";
import { type ReactNode, useMemo, useRef, useState } from "react";
import { Markdown } from "../common/Markdown";
import { ActSwatch, Button, Callout, Check, type IconName, LabelTag, Panel, StatusTag } from "../ui";
import { Centered, OnboardingStepper } from "./chrome";
import type { PlayerConnection } from "./connection";

export function Page({
  view,
  step,
  title,
  icon,
  children,
  footer,
}: {
  view: PlayerView;
  step: string;
  title: string;
  icon: IconName;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <div style={{ maxWidth: 860, margin: "0 auto", padding: "var(--s5) var(--s4)" }} className="col">
      <OnboardingStepper v={view} current={step} />
      <Panel title={title} icon={icon}>
        <div className="col gap-3">
          {children}
          <div className="row" style={{ borderTop: "1px dashed var(--frame)", paddingTop: "var(--s3)" }}>
            {footer}
          </div>
        </div>
      </Panel>
    </div>
  );
}

export function useOpenedAt() {
  return useRef(performance.now()).current;
}

type ConsentItemView = NonNullable<PlayerView["onboarding"]>["consent"]["items"][number];

/**
 * The consent text as accordion sub-sections, one per `## ` section, each with the one statement
 * that confirms it (consentSections). Null when the text cannot be split so (it is checked when
 * the session is created, so only for an old form): the screen then shows it in one piece.
 */
function useConsentSections(markdown: string, items: readonly ConsentItemView[]) {
  return useMemo(() => {
    try {
      return consentSections(markdown, items);
    } catch {
      return null;
    }
  }, [markdown, items]);
}

export function ConsentScreen({ conn, view }: { conn: PlayerConnection; view: PlayerView }) {
  const c = view.onboarding!.consent;
  const study = view.onboarding!.study;
  const openedAt = useOpenedAt();
  const [answers, setAnswers] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [confirmDecline, setConfirmDecline] = useState(false);
  const split = useConsentSections(c.markdown, c.items);
  const sections = split?.sections ?? [];
  /** The sub-section open now (one at a time), and how far the participant has come. */
  const [open, setOpen] = useState(0);
  const [passed, setPassed] = useState<ReadonlySet<number>>(new Set());
  const allRequired = c.items.every((i) => !i.required || answers[i.id]);
  const allPassed = !split || sections.every((_, i) => passed.has(i));
  const canAgree = allRequired && allPassed;
  const sectionRefs = useRef<Array<HTMLElement | null>>([]);

  const pass = (i: number) => {
    setPassed((p) => new Set(p).add(i));
    const next = i + 1 < sections.length ? i + 1 : -1;
    setOpen(next);
    if (next >= 0)
      requestAnimationFrame(() => sectionRefs.current[next]?.scrollIntoView({ block: "nearest" }));
  };
  const tick = (i: number, item: ConsentItemView, v: boolean) => {
    setAnswers((a) => ({ ...a, [item.id]: v }));
    // ticking confirms the sub-section: it closes and the next one opens
    if (v) pass(i);
    else
      setPassed((p) => {
        const n = new Set(p);
        if (item.required) n.delete(i);
        return n;
      });
  };

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

  const statement = (item: ConsentItemView, onChange: (v: boolean) => void) => (
    <Check
      label={
        <>
          {item.text} {item.required && <span className="t-danger">*</span>}
        </>
      }
      checked={answers[item.id] === true}
      onChange={onChange}
    />
  );

  return (
    <Page
      view={view}
      step="consent"
      title="Information and consent"
      icon="consent"
      footer={
        <>
          {!confirmDecline ? (
            <Button
              icon="close"
              disabled={busy}
              onClick={() => setConfirmDecline(true)}
              tip="You can decline without giving a reason; you will be asked to confirm"
            >
              I do not want to take part
            </Button>
          ) : (
            <span className="row">
              <span className="small t-danger">Are you sure?</span>
              <Button
                variant="danger"
                icon="warning"
                disabled={busy}
                onClick={() => submit(true)}
                tip="You will not play and no game or interaction data will be collected from you"
              >
                Yes, I decline
              </Button>
              <Button disabled={busy} onClick={() => setConfirmDecline(false)}>
                Back
              </Button>
            </span>
          )}
          <span className="spacer" />
          <Button
            variant="primary"
            size="lg"
            icon="ok"
            disabled={!canAgree || busy}
            onClick={() => submit(false)}
            tip={
              canAgree
                ? "Give consent and go on to a few short questions"
                : "Go through every section and tick every required box first"
            }
          >
            I agree — continue
          </Button>
        </>
      }
    >
      {split ? split.intro && <Markdown text={split.intro} /> : <Markdown text={c.markdown} />}
      <Callout icon="info">
        <strong>{study.title}</strong>
        <br />
        {study.researcher}
        {study.institution && ` · ${study.institution}`}
        {study.supervisor && ` · supervisor: ${study.supervisor}`}
        <br />
        Contact: {study.contactEmail}
        <br />
        <span className="muted">{study.retention}</span>
      </Callout>
      {split ? (
        <div className="accordion">
          {sections.map((sec, i) => {
            const isOpen = i === open;
            const done = passed.has(i);
            const reachable = i === 0 || passed.has(i - 1) || done;
            const ticked = answers[sec.item.id] === true;
            return (
              <section
                key={sec.title}
                ref={(el) => {
                  sectionRefs.current[i] = el;
                }}
                className={`acc-step ${isOpen ? "current" : done ? "done" : "upcoming"}`}
              >
                <button
                  type="button"
                  className="acc-head"
                  aria-expanded={isOpen}
                  disabled={isOpen || !reachable}
                  onClick={() => setOpen(i)}
                >
                  <span className="glyph">{isOpen ? "▶" : done ? "✓" : "·"}</span>
                  <span className="num">{String(i + 1).padStart(2, "0")}</span>
                  <span className="title">{sec.title}</span>
                  <span className="summary">
                    {isOpen ? "" : done ? (ticked ? "confirmed" : "not given (optional)") : ""}
                  </span>
                  {!sec.item.required && <StatusTag>optional</StatusTag>}
                </button>
                {isOpen && (
                  <div className="acc-body">
                    <Markdown text={sec.markdown} />
                    <div className="acc-foot">
                      {statement(sec.item, (v) => tick(i, sec.item, v))}
                      <span className="spacer" />
                      {!sec.item.required && !ticked && (
                        <Button
                          icon="next"
                          onClick={() => pass(i)}
                          tip="Go on without this optional permission"
                        >
                          Continue without
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </section>
            );
          })}
        </div>
      ) : (
        <div className="col">
          {c.items.map((item) => (
            <div key={item.id}>{statement(item, (v) => setAnswers((a) => ({ ...a, [item.id]: v })))}</div>
          ))}
        </div>
      )}
      <span className="hint">
        {split && "Tick the box of each section to confirm it; you can reopen a section. "}* required to take
        part · consent form version {c.version}
      </span>
    </Page>
  );
}

export function DeclinedScreen() {
  return (
    <Centered title="Thank you" icon="info">
      <h1>You chose not to take part</h1>
      <p>No game or interaction data will be collected from you.</p>
      <p className="muted cursor">Please let the facilitator know</p>
    </Centered>
  );
}

export function DemographicsScreen({ conn, view }: { conn: PlayerConnection; view: PlayerView }) {
  const form = view.onboarding!.demographics;
  const openedAt = useOpenedAt();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const complete = form.questions.every((q) => answers[q.id]);
  const answered = form.questions.filter((q) => answers[q.id]).length;

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
    <Page
      view={view}
      step="demographics"
      title="About you"
      icon="demographics"
      footer={
        <>
          <StatusTag tone={complete ? "live" : "neutral"}>
            {answered}/{form.questions.length} answered
          </StatusTag>
          <span className="spacer" />
          <Button
            variant="primary"
            size="lg"
            icon="next"
            disabled={!complete || busy}
            onClick={submit}
            tip={complete ? "Save your answers and go on to the briefing" : "Answer every question first"}
          >
            Continue
          </Button>
        </>
      }
    >
      {form.intro && <p className="muted">{form.intro}</p>}
      <div className="col gap-4">
        {form.questions.map((q, qi) => (
          <fieldset key={q.id} style={{ border: "none", padding: 0, margin: 0 }}>
            <legend className="strong" style={{ marginBottom: "var(--s2)" }}>
              <span className="faint">{String(qi + 1).padStart(2, "0")} </span>
              {q.text}
            </legend>
            <div className="row" style={{ gap: "var(--s1) var(--s4)" }}>
              {q.options.map((o) => (
                <label key={o.value} className="check" style={{ alignItems: "center" }}>
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
    <Page
      view={view}
      step="briefing"
      title="Briefing"
      icon="onboarding"
      footer={
        <>
          <span className="spacer" />
          <Button
            variant="primary"
            size="lg"
            icon="ok"
            disabled={busy}
            onClick={submit}
            tip={
              view.audio.enabled
                ? "Tell the facilitator you are ready; next, once everyone is, the mic check and calibration"
                : "Tell the facilitator you are ready; the game starts when every player is"
            }
          >
            I'm ready
          </Button>
        </>
      }
    >
      <Markdown text={b.markdown} />
      {(view.me.k || view.me.p) && (
        <Callout icon="labels">
          <span className="row" style={{ gap: 6 }}>
            Your roles:
            {view.me.k && (
              <LabelTag
                label={view.me.k}
                tip="Your knowledge type: on the map you see the scores of these sub-squares"
              />
            )}
            {view.me.p && (
              <LabelTag
                label={view.me.p}
                filled
                tip="Your power type: your proposals and decisions land on the sub-squares of this letter"
              />
            )}
            {view.me.viewName && (
              <>
                · you see the <strong>{view.me.viewName}</strong> scores
                {view.me.knows ? ` (${view.me.knows} sub-squares)` : ""}
              </>
            )}
            {view.me.actsOn.decide && <> · you act on the {view.me.actsOn.decide} sub-squares</>}
          </span>
        </Callout>
      )}
      <p className="hint row" style={{ gap: 6 }}>
        <ActSwatch kind="propose" /> Propose marks a sub-square (hatched) for everyone ·{" "}
        <ActSwatch kind="decide" /> Decide fills it and changes the scores · keys <kbd>P</kbd> <kbd>D</kbd>{" "}
        <kbd>Enter</kbd> <kbd>Esc</kbd>
      </p>
    </Page>
  );
}
