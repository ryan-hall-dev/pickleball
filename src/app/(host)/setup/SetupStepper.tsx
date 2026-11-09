import { CheckIcon } from "./CheckIcon";
import type { SetupStep, SetupStepState } from "./setupReadiness";

/** Words for each state, so status is never the colour or icon alone. */
const STATE_WORDS: Readonly<Record<SetupStepState, string>> = {
  done: "done",
  attention: "needs attention",
  notStarted: "not started",
  ready: "ready",
};

/** DESIGN.md stepper: Details, Courts, Players, Rotation, Review & start. */
export function SetupStepper({ steps }: { steps: SetupStep[] }) {
  return (
    <ol aria-label="Setup steps" className="flex flex-wrap gap-2">
      {steps.map((step, index) => (
        <li
          key={step.key}
          className={`flex items-center gap-2 rounded-full py-2 pr-3.5 pl-2 text-sm font-semibold ${
            step.state === "attention"
              ? "border border-orange-edge bg-orange-surface-strong text-orange-text"
              : step.state === "notStarted"
                ? "bg-inner text-muted"
                : "bg-inner text-text"
          }`}
        >
          <StepMarker state={step.state} stepNumber={index + 1} />
          <span>
            {step.label}
            {step.state === "attention" && ` · ${step.issueCount} to fix`}
            <span className="sr-only">, {STATE_WORDS[step.state]}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function StepMarker({
  state,
  stepNumber,
}: {
  state: SetupStepState;
  stepNumber: number;
}) {
  const markerClassName =
    "flex size-6 shrink-0 items-center justify-center rounded-full";
  switch (state) {
    case "done":
      return (
        <span className={`${markerClassName} bg-lime text-on-lime`}>
          <CheckIcon sizePx={14} />
        </span>
      );
    case "attention":
      return (
        <span
          aria-hidden="true"
          className={`${markerClassName} bg-orange text-[13px] font-extrabold text-on-orange`}
        >
          !
        </span>
      );
    case "notStarted":
    case "ready":
      return (
        <span
          aria-hidden="true"
          className={`${markerClassName} border-2 text-xs tabular-nums ${
            state === "ready" ? "border-lime text-text" : "border-outline"
          }`}
        >
          {stepNumber}
        </span>
      );
  }
}
