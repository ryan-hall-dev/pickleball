import type { ReactNode } from "react";

/** "Set up a session" heading row; `actions` sit on the right (DESIGN.md Setup). */
export function SetupPageHeader({ actions }: { actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-[32px] font-extrabold tracking-[-0.01em]">
          Set up a session
        </h1>
        <p className="mt-1 text-muted">
          Fill in the details and courts, check the players, then start.
        </p>
      </div>
      {actions && (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      )}
    </div>
  );
}
