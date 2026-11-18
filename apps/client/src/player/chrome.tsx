import type { PlayerView } from "@wkwa/shared";
import type { ReactNode } from "react";
import { type IconName, Panel, type StepDef, Stepper } from "../ui";

/** Onboarding wayfinding: the steps this session uses, plus READY. */
const STEP_LABEL = {
  consent: "Consent",
  mic_check: "Mic check",
  demographics: "About you",
  briefing: "Briefing",
} as const;
export function onboardingSteps(v: PlayerView): StepDef[] {
  return [
    ...v.onboardingSteps.map((k) => ({ key: k, label: STEP_LABEL[k] })),
    { key: "ready", label: "Ready" },
  ];
}

export function OnboardingStepper({ v, current }: { v: PlayerView; current: string }) {
  const steps = onboardingSteps(v);
  const idx = Math.max(
    0,
    steps.findIndex((s) => s.key === current),
  );
  return <Stepper steps={steps} current={idx} completed={(i) => i < idx} />;
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
