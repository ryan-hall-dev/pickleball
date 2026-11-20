import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { OUTLINE_BUTTON_CLASS_NAME } from "@/components/controlStyles";
import { readHostAccess } from "@/server/auth/currentHost";
import {
  checkinQrCodeSvg,
  readCheckinLink,
} from "@/server/checkin/checkinLink";
import { CheckinQrCode } from "@/app/(host)/checkin-link/CheckinQrCode";
import { STICKER_AND_QR_PAGE_PATH } from "@/app/(host)/checkin-link/checkinLinkPaths";
import { PrintStickersButton } from "./PrintStickersButton";
import { getLocale, hostPageTitle } from "@/i18n/getLocale";
import { MESSAGES } from "@/i18n/messages";

// The A4 sticker sheet (S03). It sits outside the (host) group so the host
// header and nav don't print, and checks host access itself: any host of
// the social may print its stickers (decision #25).

export async function generateMetadata(): Promise<Metadata> {
  return { title: await hostPageTitle("printStickers") };
}

/** 3 × 4 stickers per A4 page, about 63 × 69 mm each (decision #28). */
const STICKERS_PER_PAGE = 12;

// A4, no browser margins: the sheet's own 10 mm padding is the margin.
const PRINT_PAGE_CSS =
  "@page { size: A4; margin: 0; } @media print { body { background: white; } }";

export default function PrintStickersPage() {
  return (
    <Suspense
      fallback={
        <p className="p-7 text-muted" aria-live="polite">
          Loading… · <span lang="vi">Đang tải…</span>
        </p>
      }
    >
      <PrintStickersContent />
    </Suspense>
  );
}

async function PrintStickersContent() {
  const [hostAccess, locale] = await Promise.all([
    readHostAccess(),
    getLocale(),
  ]);
  const text = MESSAGES[locale].host.print;
  const scanToCheckIn = MESSAGES[locale].host.stickerAndQr.scanToCheckIn;
  if (hostAccess.status === "signed_out") redirect("/login");
  // Session setup shows a signed-in non-host why they can't get in.
  if (hostAccess.status === "not_a_host") redirect("/setup");
  const { socialId, socialName } = hostAccess.host;
  const { link, shortLink } = await readCheckinLink(socialId);
  const qrCodeSvg = checkinQrCodeSvg(link);

  return (
    // The print page has no host layout: it sets its own language.
    <div lang={locale} className={locale === "vi" ? "font-vietnamese" : ""}>
      <style>{PRINT_PAGE_CSS}</style>
      <div className="flex flex-wrap items-center gap-3 border-b border-card-border bg-bg-header px-7 py-4 print:hidden">
        <Link
          href={STICKER_AND_QR_PAGE_PATH}
          className={OUTLINE_BUTTON_CLASS_NAME}
        >
          {text.back}
        </Link>
        <p className="flex-[1_1_300px] text-sm text-muted">{text.intro}</p>
        <PrintStickersButton label={text.print} />
      </div>
      <main className="overflow-x-auto bg-inner-border p-7 print:overflow-visible print:bg-white print:p-0">
        <h1 className="sr-only">{text.heading(socialName)}</h1>
        <ul
          aria-label={text.stickers}
          className="mx-auto grid h-[297mm] w-[210mm] grid-cols-3 grid-rows-4 overflow-hidden bg-white p-[10mm] text-black"
        >
          {Array.from({ length: STICKERS_PER_PAGE }, (_, stickerIndex) => (
            <li
              key={stickerIndex}
              className="flex min-w-0 flex-col items-center justify-center gap-[1.5mm] overflow-hidden border border-dashed border-placeholder p-[3mm] text-center"
            >
              <CheckinQrCode
                qrCodeSvg={qrCodeSvg}
                label={MESSAGES[locale].host.stickerAndQr.qrCodeLabel(
                  shortLink,
                )}
                className="size-[40mm] shrink-0"
              />
              <p className="line-clamp-2 text-[15px] leading-tight font-extrabold break-words">
                {socialName}
              </p>
              <p className="text-[13px] font-semibold">{scanToCheckIn}</p>
              <p className="text-[11px] break-all text-outline">{shortLink}</p>
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}
