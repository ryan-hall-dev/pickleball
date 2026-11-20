"use client";

import type { ReactNode } from "react";
import { useMessages } from "@/i18n/LocaleProvider";

/** "Set up a session" heading row; `actions` sit on the right (DESIGN.md Setup). */
export function SetupPageHeader({ actions }: { actions?: ReactNode }) {
  const text = useMessages().host.setup;
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-[32px] font-extrabold tracking-[-0.01em] max-sm:text-[17px] max-sm:font-bold max-sm:tracking-normal">
          {text.title}
        </h1>
        <p className="mt-1 text-muted">{text.intro}</p>
      </div>
      {actions && (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      )}
    </div>
  );
}
