import type { Metadata } from "next";
import { Suspense } from "react";
import { CARD_CLASS_NAME } from "@/components/controlStyles";
import { readHostAccess } from "@/server/auth/currentHost";
import { listHosts } from "@/server/hosts/hostDirectory";
import { InviteHostForm } from "./InviteHostForm";
import { RemoveHostButton } from "./RemoveHostButton";

export const metadata: Metadata = {
  title: "Hosts · Pickleball Social Manager",
};

export default function HostsPage() {
  return (
    <>
      <h1 className="text-[32px] font-extrabold tracking-[-0.01em]">Hosts</h1>
      {/* Per-user data streams in behind its own boundary: on a client
          navigation the layout's boundary is already mounted and can't cover it. */}
      <Suspense
        fallback={
          <p className="text-muted" aria-live="polite">
            Loading hosts…
          </p>
        }
      >
        <HostsManagement />
      </Suspense>
    </>
  );
}

async function HostsManagement() {
  const hostAccess = await readHostAccess();
  // Fails closed: only hosts see the list (RLS also returns nothing otherwise).
  if (hostAccess.status !== "host") return null;
  const currentHost = hostAccess.host;
  const isAdmin = currentHost.role === "admin";
  const hosts = await listHosts();

  return (
    <div className="flex flex-wrap items-start gap-4">
      <section
        aria-labelledby="hosts-list-heading"
        className={`${CARD_CLASS_NAME} flex flex-[999_1_480px] flex-col gap-4`}
      >
        <h2 id="hosts-list-heading" className="text-xl font-bold">
          Who can host
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
                    <span className="font-normal text-muted"> (you)</span>
                  )}
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-bold ${
                    host.role === "admin"
                      ? "bg-lime text-on-lime"
                      : "bg-inner-border text-text"
                  }`}
                >
                  {host.role === "admin" ? "ADMIN" : "HOST"}
                </span>
                {isAdmin && !isCurrentHost && (
                  <RemoveHostButton
                    hostUserId={host.userId}
                    hostDisplayName={host.displayName}
                  />
                )}
              </li>
            );
          })}
        </ul>
        {!isAdmin && (
          <p className="text-sm text-muted">
            Only admins can invite or remove hosts.
          </p>
        )}
      </section>
      {isAdmin && (
        <section
          aria-labelledby="invite-host-heading"
          className={`${CARD_CLASS_NAME} flex flex-[1_1_360px] flex-col gap-4`}
        >
          <h2 id="invite-host-heading" className="text-xl font-bold">
            Invite a host
          </h2>
          <InviteHostForm />
        </section>
      )}
    </div>
  );
}
