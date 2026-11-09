import type { Metadata } from "next";
import { Suspense } from "react";
import { CARD_CLASS_NAME } from "@/components/controlStyles";
import { readHostAccess } from "@/server/auth/currentHost";
import { listAllActiveMembers } from "@/server/members/memberDirectory";
import {
  listActiveClubCourts,
  listOwnSavedSetups,
  readHostOpenSession,
} from "@/server/setup/setupDraft";
import { SessionSetupEditor } from "./SessionSetupEditor";
import { SetupPageHeader } from "./SetupPageHeader";
import { StartSessionDraftButton } from "./StartSessionDraftButton";

export const metadata: Metadata = {
  title: "Session setup · Pickleball Social Manager",
};

export default function SessionSetupPage() {
  return (
    // Per-user data streams in behind its own boundary (cacheComponents).
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
  );
}

async function SessionSetupContent() {
  const hostAccess = await readHostAccess();
  // Fails closed: only hosts see setup (RLS also returns nothing otherwise).
  if (hostAccess.status !== "host") return null;
  const openSession = await readHostOpenSession(hostAccess.host.userId);

  if (openSession.status === "draft") {
    const [clubCourts, activeMembers, savedSetups] = await Promise.all([
      listActiveClubCourts(),
      listAllActiveMembers(),
      listOwnSavedSetups(hostAccess.host.userId),
    ]);
    return (
      <SessionSetupEditor
        // A new draft remounts the editor with fresh state.
        key={openSession.draft.sessionId}
        draft={openSession.draft}
        initialClubCourts={clubCourts}
        activeMembers={activeMembers}
        canAddCourts={hostAccess.host.role === "admin"}
        initialSavedSetups={savedSetups}
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
