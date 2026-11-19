import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import { getLocale } from "@/i18n/getLocale";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { MESSAGES } from "@/i18n/messages";
import { loadCheckinPage } from "@/server/checkin/checkinPage";
import { CheckinApp } from "./CheckinApp";

// The public player check-in page, opened by the social's NFC sticker or QR
// code. No login and no host chrome: it lives outside the (host) group, and
// proxy.ts skips /t/ entirely. Its only server code is the check-in reads and
// actions in src/server/checkin (acceptance criteria 16-18).

export async function generateMetadata(): Promise<Metadata> {
  const messages = MESSAGES[await getLocale()];
  return {
    title: `${messages.checkin.pageTitle} · ${messages.appName}`,
    robots: { index: false, follow: false },
  };
}

// Lets the pinned button sit above the phone's home indicator (safe-area insets).
export const viewport: Viewport = { viewportFit: "cover" };

export default function CheckinPage({ params }: PageProps<"/t/[tag]">) {
  return (
    <main className="mx-auto flex w-full max-w-[440px] flex-1 flex-col gap-4 px-5 pt-5">
      {/* The read depends on this phone's cookie, so it streams in (cacheComponents). */}
      <Suspense
        fallback={
          // Before the language is known: both, briefly.
          <p className="text-muted" aria-live="polite">
            Loading… · <span lang="vi">Đang tải…</span>
          </p>
        }
      >
        <CheckinPageContent params={params} />
      </Suspense>
    </main>
  );
}

async function CheckinPageContent({
  params,
}: {
  params: PageProps<"/t/[tag]">["params"];
}) {
  // Resolve the current session at request time, before the first database read.
  await connection();
  const { tag } = await params;
  const [initialPageRead, locale] = await Promise.all([
    loadCheckinPage(tag),
    getLocale(),
  ]);
  return (
    <LocaleProvider initialLocale={locale}>
      <CheckinApp checkinTag={tag} initialPageRead={initialPageRead} />
    </LocaleProvider>
  );
}
