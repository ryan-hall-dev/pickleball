"use client";

import { useMessages } from "@/i18n/LocaleProvider";

/** Outside the page's Suspense boundary, so it reads the language on the client. */
export function BackToSetupText() {
  return <>{useMessages().host.stickerAndQr.backToSetup}</>;
}
