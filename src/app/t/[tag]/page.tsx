import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import { connection } from "next/server";
import { loadCheckinPage } from "@/server/checkin/checkinPage";
import { CheckinApp } from "./CheckinApp";

// The public player check-in page, opened by the social's NFC sticker or QR
// code. No login and no host chrome: it lives outside the (host) group, and
// proxy.ts skips /t/ entirely. Its only server code is the check-in reads and
// actions in src/server/checkin (acceptance criteria 16-18).

export const metadata: Metadata = {
  title: "Check in · Pickleball Social Manager",
  robots: { index: false, follow: false },
};

// Lets the pinned button sit above the phone's home indicator (safe-area insets).
export const viewport: Viewport = { viewportFit: "cover" };

export default function CheckinPage({ params }: PageProps<"/t/[tag]">) {
  return (
    <main className="mx-auto flex w-full max-w-[440px] flex-1 flex-col gap-4 px-5 pt-5">
      {/* The read depends on this phone's cookie, so it streams in (cacheComponents). */}
      <Suspense
        fallback={
          <p className="text-muted" aria-live="polite">
            Loading check-in…
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
  const initialPageRead = await loadCheckinPage(tag);
  return <CheckinApp checkinTag={tag} initialPageRead={initialPageRead} />;
}
