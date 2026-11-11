import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ClubLogo } from "@/components/ClubLogo";
import {
  CARD_CLASS_NAME,
  LINK_BUTTON_CLASS_NAME,
  OUTLINE_BUTTON_CLASS_NAME,
} from "@/components/controlStyles";
import { readHostAccess } from "@/server/auth/currentHost";
import {
  checkinQrCodeSvg,
  readCheckinLink,
} from "@/server/checkin/checkinLink";
import { BackChevronIcon, PrintIcon } from "./CheckinLinkIcons";
import { PRINT_STICKERS_PAGE_PATH } from "./checkinLinkPaths";
import { CheckinQrCode } from "./CheckinQrCode";
import { CopyCheckinLinkField } from "./CopyCheckinLinkField";
import { FullScreenQrButton } from "./FullScreenQrButton";

export const metadata: Metadata = {
  title: "Sticker and QR · Pickleball Social Manager",
};

export default function StickerAndQrPage() {
  return (
    <>
      <Link
        href="/setup"
        className={`${LINK_BUTTON_CLASS_NAME} gap-1.5 self-start`}
      >
        <BackChevronIcon />
        Back to session setup
      </Link>
      {/* Per-user data streams in behind its own boundary (cacheComponents). */}
      <Suspense
        fallback={
          <>
            <h1 className="text-[32px] font-extrabold tracking-[-0.01em]">
              Sticker and QR
            </h1>
            <p className="text-muted" aria-live="polite">
              Loading the check-in link…
            </p>
          </>
        }
      >
        <StickerAndQrContent />
      </Suspense>
    </>
  );
}

async function StickerAndQrContent() {
  const hostAccess = await readHostAccess();
  // Fails closed: only hosts of the social see its link (any role, #25).
  if (hostAccess.status !== "host") return null;
  const { socialId, socialName } = hostAccess.host;
  const { link, shortLink } = await readCheckinLink(socialId);
  const qrCodeSvg = checkinQrCodeSvg(link);

  return (
    <>
      <div>
        <h1 className="text-[32px] font-extrabold tracking-[-0.01em]">
          Sticker and QR
        </h1>
        <p className="mt-1 max-w-[720px] text-muted">
          One check-in link for {socialName}. Players scan the QR code or tap a
          sticker to check in to whichever session is open. It stays the same
          for every session.
        </p>
      </div>
      <div className="flex flex-wrap items-start gap-[18px]">
        <section
          aria-labelledby="checkin-link-heading"
          className={`${CARD_CLASS_NAME} flex min-w-0 flex-[999_1_520px] flex-col gap-4`}
        >
          <h2 id="checkin-link-heading" className="text-xl font-bold">
            Check-in link
          </h2>
          <CopyCheckinLinkField link={link} />
          <p className="flex items-start gap-2.5 rounded-2xl border border-inner-border bg-inner px-3.5 py-3 text-sm text-text-soft">
            <span
              aria-hidden="true"
              className="flex size-5 shrink-0 items-center justify-center rounded-full bg-inner-border text-xs font-extrabold text-text"
            >
              i
            </span>
            <span>
              NFC stickers: write this same link to the sticker. Every sticker
              and QR code for this social uses it.
            </span>
          </p>
          <div className="flex flex-wrap gap-2">
            <FullScreenQrButton
              qrCodeSvg={qrCodeSvg}
              shortLink={shortLink}
              socialName={socialName}
              clubLogo={<ClubLogo />}
            />
            <Link
              href={PRINT_STICKERS_PAGE_PATH}
              className={`${OUTLINE_BUTTON_CLASS_NAME} gap-2 whitespace-nowrap`}
            >
              <PrintIcon />
              Print stickers
            </Link>
          </div>
          <p className="text-sm text-muted">
            Only a manager can issue a new link (Hosts page). When they do, this
            link, the QR code and printed stickers stop working.
          </p>
        </section>
        <section
          aria-labelledby="qr-code-heading"
          className={`${CARD_CLASS_NAME} flex min-w-0 flex-[1_1_300px] flex-col items-center gap-4`}
        >
          <h2 id="qr-code-heading" className="self-start text-xl font-bold">
            QR code
          </h2>
          <div className="rounded-[20px] bg-white p-[18px]">
            <CheckinQrCode
              qrCodeSvg={qrCodeSvg}
              shortLink={shortLink}
              className="size-[min(260px,calc(100vw-140px))]"
            />
          </div>
          <p className="text-center text-sm break-all text-muted">
            Scan to check in · {shortLink}
          </p>
        </section>
      </div>
    </>
  );
}
