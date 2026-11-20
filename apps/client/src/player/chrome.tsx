import { type PlayerView, STEP_LABEL } from "@wkwa/shared";
import { type ReactNode, useState } from "react";
import { type IconName, Panel, type StepDef, Stepper } from "../ui";
import type { PlayerConnection } from "./connection";

/** Onboarding wayfinding: the steps this session uses, plus READY. */
export function OnboardingStepper({ v, current }: { v: PlayerView; current: string }) {
  const steps: StepDef[] = [
    ...v.onboardingSteps.map((k) => ({ key: k, label: STEP_LABEL[k] })),
    { key: "ready", label: "Ready" },
  ];
  const idx = Math.max(
    0,
    steps.findIndex((s) => s.key === current),
  );
  return <Stepper steps={steps} current={idx} completed={(i) => i < idx} />;
}

/**
 * READY: onboarding done, waiting for the other players and for `waitingFor` (round 1, or the
 * facilitator's calibration). `children` (e.g. what comes next) goes under the heading.
 */
export function ReadyScreen({
  view,
  waitingFor,
  width,
  children,
}: {
  view: PlayerView;
  waitingFor: string;
  width?: number;
  children?: ReactNode;
}) {
  const ready = view.others.filter((o) => o.ready).length + 1;
  const total = view.others.length + 1;
  return (
    <Centered title="Ready" icon="ok" width={width}>
      <OnboardingStepper v={view} current="ready" />
      <h1>You're all set</h1>
      {children}
      <p className="muted cursor">
        Waiting for the other players ({ready}/{total} ready) and for {waitingFor}
      </p>
    </Centered>
  );
}

export function Centered({
  title,
  icon,
  children,
  width = 640,
}: {
  title: string;
  icon?: IconName;
  children: ReactNode;
  width?: number;
}) {
  return (
    <div className="screen-center">
      <Panel title={title} icon={icon} style={{ maxWidth: width, width: "100%", padding: "var(--s5)" }}>
        <div className="col" style={{ alignItems: "center", textAlign: "center", gap: "var(--s3)" }}>
          {children}
        </div>
      </Panel>
    </div>
  );
}

/** `[busy, submit]`: `submit(fn)` runs `fn` with `busy` set and shows a thrown error as a toast. */
export function useSubmit(conn: PlayerConnection) {
  const [busy, setBusy] = useState(false);
  const submit = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      conn.showToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return [busy, submit] as const;
}
