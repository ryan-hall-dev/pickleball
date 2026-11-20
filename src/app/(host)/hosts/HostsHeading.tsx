"use client";

import { useMessages } from "@/i18n/LocaleProvider";

/** Outside the page's Suspense boundary, so it reads the language on the client. */
export function HostsHeading() {
  return (
    <h1 className="text-[32px] font-extrabold tracking-[-0.01em] max-sm:text-[17px] max-sm:font-bold max-sm:tracking-normal">
      {useMessages().host.titles.hosts}
    </h1>
  );
}
