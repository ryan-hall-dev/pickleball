"use client";

import { useMessages } from "@/i18n/LocaleProvider";

/** Outside the page's Suspense boundary, so it reads the language on the client. */
export function HostsHeading() {
  return (
    <h1 className="text-[32px] font-extrabold tracking-[-0.01em] compact:text-[17px] compact:font-bold compact:tracking-normal">
      {useMessages().host.titles.hosts}
    </h1>
  );
}
