import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { CARD_CLASS_NAME } from "@/components/controlStyles";
import { getMessages, hostPageTitle } from "@/i18n/getLocale";
import { HostLoading } from "../HostLoading";
import { readHostAccess } from "@/server/auth/currentHost";
import { readSocialOpenSession } from "@/server/setup/setupDraft";
import { CoHostDraftNoticeProvider } from "./CoHostDraftNotice";
import { SessionSetupEditor } from "./SessionSetupEditor";
import { SetupPageHeader } from "./SetupPageHeader";
import { StartSessionDraftButton } from "./StartSessionDraftButton";

export async function generateMetadata(): Promise<Metadata> {
  return { title: await hostPageTitle("setup") };
}

export default function SessionSetupPage() {
  return (
    // The design's setup page ends 56px down; the host layout gives 48px.
    <div className="flex flex-col gap-4 pb-2">
      {/* Per-user data streams in behind its own boundary (cacheComponents). */}
      <CoHostDraftNoticeProvider>
        <Suspense
          fallback={
            <>
              <SetupPageHeader />
              <HostLoading page="setup" />
            </>
          }
        >
          <SessionSetupContent />
        </Suspense>
      </CoHostDraftNoticeProvider>
    </div>
  );
}

async function SessionSetupContent() {
  const [hostAccess, messages] = await Promise.all([
    readHostAccess(),
    getMessages(),
  ]);
  const text = messages.host.setup;
  // Fails closed: only hosts see setup (RLS also returns nothing otherwise).
  if (hostAccess.status !== "host") return null;
  const openSession = await readSocialOpenSession(hostAccess.host.socialId);

  if (openSession.status === "draft") {
    return (
      <SessionSetupEditor
        // A new draft remounts the editor with fresh state.
        key={openSession.draft.sessionId}
        draft={openSession.draft}
        socialName={hostAccess.host.socialName}
      />
    );
  }

  return (
    <>
      <SetupPageHeader />
      <section
        aria-labelledby="no-draft-heading"
        className={`${CARD_CLASS_NAME} flex max-w-[640px] flex-col items-start gap-3`}
      >
        {openSession.status === "live" ? (
          <>
            <h2
              id="no-draft-heading"
              className="text-xl font-bold compact:text-base"
            >
              {text.isLive(openSession.name)}
            </h2>
            <p className="text-muted">{text.setUpNextAfterEnd}</p>
            <Link
              href="/live"
              className="inline-flex min-h-11 items-center font-semibold text-link"
            >
              {text.openLiveSession}
            </Link>
          </>
        ) : (
          <>
            <h2
              id="no-draft-heading"
              className="text-xl font-bold compact:text-base"
            >
              {text.noSession}
            </h2>
            <p className="text-muted">{text.noSessionText}</p>
            <StartSessionDraftButton />
          </>
        )}
      </section>
    </>
  );
}
