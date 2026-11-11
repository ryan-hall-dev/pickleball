"use client";

import { useId, useRef, type ReactNode } from "react";
import {
  ICON_BUTTON_CLASS_NAME,
  SECONDARY_BUTTON_CLASS_NAME,
} from "@/components/controlStyles";
import { FullScreenIcon } from "./CheckinLinkIcons";
import { CheckinQrCode } from "./CheckinQrCode";

/**
 * "Show full screen" and the full-screen QR (S02): a host turns the screen
 * to a player. A native modal <dialog> filling the viewport; Esc or the 44px
 * close button returns to the page. `clubLogo` is rendered on the server:
 * its dot positions are floats that the browser can compute a last digit
 * differently, which would break hydration.
 */
export function FullScreenQrButton({
  qrCodeSvg,
  shortLink,
  socialName,
  clubLogo,
}: {
  qrCodeSvg: string;
  shortLink: string;
  socialName: string;
  clubLogo: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  function openFullScreen() {
    const dialog = dialogRef.current;
    if (!dialog) throw new Error("The full-screen QR dialog isn't mounted.");
    if (!dialog.open) dialog.showModal();
    // React's autoFocus runs at mount, not when the dialog opens.
    closeButtonRef.current?.focus();
  }

  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={openFullScreen}
        className={`${SECONDARY_BUTTON_CLASS_NAME} gap-2 whitespace-nowrap`}
      >
        <FullScreenIcon />
        Show full screen
      </button>
      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        className="m-0 h-dvh max-h-none w-dvw max-w-none bg-bg p-0 text-text backdrop:bg-bg"
      >
        <div className="relative flex min-h-full flex-col items-center justify-center gap-6 px-5 py-16 text-center sm:px-10">
          <button
            ref={closeButtonRef}
            type="button"
            aria-label="Close full screen"
            onClick={() => dialogRef.current?.close()}
            className={`${ICON_BUTTON_CLASS_NAME} absolute top-5 right-5`}
          >
            ×
          </button>
          <p className="flex items-center gap-3.5 text-2xl font-bold break-words">
            {clubLogo}
            {socialName}
          </p>
          <h2
            id={titleId}
            className="text-[34px] font-extrabold tracking-[-0.01em] sm:text-[44px]"
          >
            Scan to check in
          </h2>
          <div className="rounded-[28px] bg-white p-4 sm:p-7">
            <CheckinQrCode
              qrCodeSvg={qrCodeSvg}
              shortLink={shortLink}
              className="size-[max(160px,min(520px,calc(100dvh-340px),calc(100vw-80px)))]"
            />
          </div>
          <p className="text-xl font-medium break-all text-muted">
            {shortLink}
          </p>
        </div>
      </dialog>
    </>
  );
}
