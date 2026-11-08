"use client";

import { useEffect } from "react";

/**
 * "Saved <name>." after an add or edit. Shown once: `?saved=` is removed from
 * the address straight away, so a refresh or a shared link doesn't repeat it.
 */
export function SavedMemberNotice({ fullName }: { fullName: string }) {
  useEffect(() => {
    const currentUrl = new URL(window.location.href);
    if (!currentUrl.searchParams.has("saved")) return;
    currentUrl.searchParams.delete("saved");
    // Integrates with the Next.js router without a new request.
    window.history.replaceState(null, "", currentUrl);
  }, []);

  return (
    <p
      role="status"
      className="rounded-2xl border border-lime-edge bg-lime-surface px-4 py-2.5 text-lime-soft"
    >
      Saved {fullName}.
    </p>
  );
}
