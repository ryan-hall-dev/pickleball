import type { Metadata } from "next";
import { Suspense } from "react";
import { CARD_CLASS_NAME } from "@/components/controlStyles";
import { readHostAccess } from "@/server/auth/currentHost";
import type { SignedInHost } from "@/server/auth/hostAccess";
import { readCheckinLink } from "@/server/checkin/checkinLink";
import { listHosts } from "@/server/hosts/hostDirectory";
import { CheckinLinkCard, type CheckinLinkCardLink } from "./CheckinLinkCard";
import { InviteHostForm } from "./InviteHostForm";
import { RemoveHostButton } from "./RemoveHostButton";
import { SocialNameForm } from "./SocialNameForm";
import { getMessages, hostPageTitle } from "@/i18n/getLocale";
import { HostLoading } from "../HostLoading";
import { HostsHeading } from "./HostsHeading";

export async function generateMetadata(): Promise<Metadata> {
  return { title: await hostPageTitle("hosts") };
}

export default function HostsPage() {
  return (
    <>
      <HostsHeading />
      {/* Per-user data streams in behind its own boundary: on a client
          navigation the layout's boundary is already mounted and can't cover it. */}
      <Suspense fallback={<HostLoading page="hosts" />}>
        <HostsManagement />
      </Suspense>
    </>
  );
}

async function HostsManagement() {
  const [hostAccess, messages] = await Promise.all([
    readHostAccess(),
    getMessages(),
  ]);
  const text = messages.host.hosts;
  // Fails closed: only hosts see the list (RLS also returns nothing otherwise).
  if (hostAccess.status !== "host") return null;
  const currentHost = hostAccess.host;
  const isManager = currentHost.role === "manager";
  const hosts = await listHosts();

  return (
    <div className="flex flex-wrap items-start gap-4">
      <section
        aria-labelledby="hosts-list-heading"
        className={`${CARD_CLASS_NAME} flex flex-[999_1_480px] flex-col gap-4`}
      >
        <h2
          id="hosts-list-heading"
          className="text-xl font-bold max-sm:text-base"
        >
          {text.whoCanHost}
        </h2>
        <ul className="flex flex-col gap-2">
          {hosts.map((host) => {
            const isCurrentHost = host.userId === currentHost.userId;
            return (
              <li
                key={host.userId}
                className="flex flex-wrap items-center gap-3 rounded-2xl border border-inner-border bg-inner px-3 py-2.5"
              >
                <span className="flex-1 font-semibold">
                  {host.displayName}
                  {isCurrentHost && (
                    <span className="font-normal text-muted">{text.you}</span>
                  )}
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-bold ${
                    host.role === "manager"
                      ? "bg-lime text-on-lime"
                      : "bg-inner-border text-text"
                  }`}
                >
                  {host.role === "manager" ? text.managerBadge : text.hostBadge}
                </span>
                {isManager && !isCurrentHost && (
                  <RemoveHostButton
                    hostUserId={host.userId}
                    hostDisplayName={host.displayName}
                  />
                )}
              </li>
            );
          })}
        </ul>
        {!isManager && (
          <p className="text-sm text-muted">{text.onlyManagerInvites}</p>
        )}
      </section>
      <div className="flex min-w-0 flex-[1_1_360px] flex-col gap-4">
        {/* Its own boundary: a failed link read takes out only this card. */}
        <Suspense
          fallback={
            <CheckinLinkCard
              checkinLink={{ status: "loading" }}
              socialName={currentHost.socialName}
              canIssueNewLink={isManager}
            />
          }
        >
          <LoadedCheckinLinkCard host={currentHost} />
        </Suspense>
        {isManager && (
          <>
            <section
              aria-labelledby="invite-host-heading"
              className={`${CARD_CLASS_NAME} flex flex-col gap-4`}
            >
              <h2
                id="invite-host-heading"
                className="text-xl font-bold max-sm:text-base"
              >
                {text.inviteHeading}
              </h2>
              <InviteHostForm />
            </section>
            <section
              aria-labelledby="social-name-heading"
              className={`${CARD_CLASS_NAME} flex flex-col gap-4`}
            >
              <h2
                id="social-name-heading"
                className="text-xl font-bold max-sm:text-base"
              >
                {text.socialNameHeading}
              </h2>
              <SocialNameForm socialName={currentHost.socialName} />
            </section>
          </>
        )}
      </div>
    </div>
  );
}

async function LoadedCheckinLinkCard({ host }: { host: SignedInHost }) {
  let checkinLink: CheckinLinkCardLink;
  try {
    const { shortLink } = await readCheckinLink(host.socialId);
    checkinLink = { status: "loaded", shortLink };
  } catch (error) {
    console.error("Reading the check-in link for the Hosts page failed", {
      actorUserId: host.userId,
      cause: error instanceof Error ? error.message : String(error),
    });
    checkinLink = { status: "failed" };
  }
  return (
    <CheckinLinkCard
      checkinLink={checkinLink}
      socialName={host.socialName}
      canIssueNewLink={host.role === "manager"}
    />
  );
}
