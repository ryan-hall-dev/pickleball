import type { ReactNode } from "react";
import { CARD_CLASS_NAME } from "@/components/controlStyles";

/** DESIGN.md section card: numbered badge + h2 on the left, actions on the right. */
export function SetupSection({
  stepNumber,
  headingId,
  heading,
  actions,
  children,
}: {
  stepNumber: number;
  headingId: string;
  heading: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={headingId} className={CARD_CLASS_NAME}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 compact:mb-3 compact:gap-2">
        <div className="flex items-center gap-3 compact:gap-2.5">
          <span
            aria-hidden="true"
            className="flex size-8 items-center justify-center rounded-[10px] bg-inner-border font-extrabold compact:size-7 compact:rounded-lg compact:text-sm"
          >
            {stepNumber}
          </span>
          <h2 id={headingId} className="text-xl font-bold compact:text-base">
            {heading}
          </h2>
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}
