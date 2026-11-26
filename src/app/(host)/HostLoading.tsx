"use client";

import { useMessages } from "@/i18n/LocaleProvider";

/** A host page's loading line, in the chosen language (Suspense fallbacks). */
export function HostLoading({
  page,
}: {
  page: "setup" | "arrivals" | "live" | "hosts" | "stickerAndQr";
}) {
  const host = useMessages().host;
  const text = {
    setup: host.setup.loading,
    arrivals: host.arrivals.loading,
    live: host.live.loading,
    hosts: host.hosts.loading,
    stickerAndQr: host.stickerAndQr.loading,
  }[page];
  return (
    <p className="text-muted" role="status">
      {text}
    </p>
  );
}
