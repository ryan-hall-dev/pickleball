import type { Metadata } from "next";
import { Suspense } from "react";
import { CARD_CLASS_NAME } from "@/components/controlStyles";
import { readHostAccess } from "@/server/auth/currentHost";
import {
  listActiveClubCourts,
  listSocialSavedSetupsUnderRls,
  readSocialOpenSession,
} from "@/server/setup/setupDraft";
import { CoHostDraftNoticeProvider } from "./CoHostDraftNotice";
import { SessionSetupEditor } from "./SessionSetupEditor";
import { SetupPageHeader } from "./SetupPageHeader";
import { StartSessionDraftButton } from "./StartSessionDraftButton";

export const metadata: Metadata = {
  title: "Session setup · Pickleball Social Manager",
};

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
              <p className="text-muted" aria-live="polite">
                Loading your session…
              </p>
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
  const hostAccess = await readHostAccess();
  // Fails closed: only hosts see setup (RLS also returns nothing otherwise).
  if (hostAccess.status !== "host") return null;
  const openSession = await readSocialOpenSession(hostAccess.host.socialId);

  if (openSession.status === "draft") {
    const [clubCourts, savedSetups] = await Promise.all([
      listActiveClubCourts(),
      listSocialSavedSetupsUnderRls(hostAccess.host.socialId),
    ]);
    return (
      <SessionSetupEditor
        // A new draft remounts the editor with fresh state.
        key={openSession.draft.sessionId}
        draft={openSession.draft}
        initialClubCourts={clubCourts}
        canAddCourts={hostAccess.host.role === "manager"}
        initialSavedSetups={savedSetups}
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
            <h2 id="no-draft-heading" className="text-xl font-bold">
              {openSession.name} is live
            </h2>
            <p className="text-muted">
              You can set up your next session once this one has ended.
            </p>
          </>
        ) : (
          <>
            <h2 id="no-draft-heading" className="text-xl font-bold">
              No session in progress
            </h2>
            <p className="text-muted">
              Start a new session to choose its time, courts and players. It
              stays a draft until you start it.
            </p>
            <StartSessionDraftButton />
          </>
        )}
      </section>
    </>
  );
}
