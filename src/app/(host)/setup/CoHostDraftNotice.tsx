"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { useMessages } from "@/i18n/LocaleProvider";
import { translateMessage } from "@/i18n/messages";

// "Start a new session" can open the draft a co-host already started. The
// button that learns this is replaced by the editor when the page re-renders,
// so the notice lives in a provider above both (its state survives the
// re-render) until the host leaves Setup.

interface CoHostDraftNoticeState {
  notice: string | null;
  showNotice: (notice: string | null) => void;
}

const CoHostDraftNoticeContext = createContext<CoHostDraftNoticeState>({
  notice: null,
  showNotice: () => {},
});

export function CoHostDraftNoticeProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [notice, showNotice] = useState<string | null>(null);
  return (
    <CoHostDraftNoticeContext value={{ notice, showNotice }}>
      {children}
    </CoHostDraftNoticeContext>
  );
}

/** Lets the start button hand its notice to the editor. */
export function useShowCoHostDraftNotice() {
  return useContext(CoHostDraftNoticeContext).showNotice;
}

/** DESIGN.md info banner (lime); nothing without a notice. */
export function CoHostDraftNotice() {
  const { notice } = useContext(CoHostDraftNoticeContext);
  const messages = useMessages();
  if (!notice) return null;
  return (
    <p
      role="status"
      className="rounded-2xl border border-lime-edge bg-lime-surface px-4 py-2.5 text-lime-soft"
    >
      {translateMessage(notice, messages)}
    </p>
  );
}
