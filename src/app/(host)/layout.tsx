import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { ClubLogo } from "@/components/ClubLogo";
import { InitialsAvatar } from "@/components/InitialsAvatar";
import {
  CARD_CLASS_NAME,
  OUTLINE_BUTTON_CLASS_NAME,
} from "@/components/controlStyles";
import { readHostAccess } from "@/server/auth/currentHost";
import { signOut } from "@/server/auth/loginActions";
import { HostNav } from "./HostNav";

/**
 * The host area. Pages here only render for hosts; proxy.ts redirects signed-out
 * visitors earlier, but this check (verified with the Auth server) is the gate.
 */
export default function HostLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<HostAreaLoading />}>
      <HostGate>{children}</HostGate>
    </Suspense>
  );
}

function HostAreaLoading() {
  return (
    <main className="flex flex-1 items-center justify-center px-5 py-10">
      <p className="text-muted" aria-live="polite">
        Loading…
      </p>
    </main>
  );
}

/** The gate reads the session, so it sits behind Suspense (cacheComponents). */
async function HostGate({ children }: { children: ReactNode }) {
  const hostAccess = await readHostAccess();
  if (hostAccess.status === "signed_out") redirect("/login");
  if (hostAccess.status === "not_a_host") {
    return <NotAHostNotice email={hostAccess.email} />;
  }
  const { host } = hostAccess;

  return (
    <>
      <header className="border-b border-card-border bg-bg-header">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-x-6 gap-y-3 px-7 py-3">
          <Link
            href="/setup"
            className="flex min-h-11 items-center gap-3 rounded-xl"
          >
            <ClubLogo />
            {/* The social's own name (decision D1); the app name stays on
                /login and in tab titles. */}
            <span className="text-[19px] font-bold">{host.socialName}</span>
          </Link>
          <HostNav />
          <div className="ml-auto flex items-center gap-3">
            <InitialsAvatar name={host.displayName} />
            <span className="text-sm text-muted">
              {host.role === "manager" ? "Social manager" : "Host"} ·{" "}
              <span className="font-semibold text-text">
                {host.displayName}
              </span>
            </span>
            <form action={signOut}>
              <button type="submit" className={OUTLINE_BUTTON_CLASS_NAME}>
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-[1440px] flex-1 flex-col gap-4 px-7 pt-6 pb-12">
        {children}
      </main>
    </>
  );
}

function NotAHostNotice({ email }: { email: string | null }) {
  return (
    <main className="flex flex-1 items-center justify-center px-5 py-10">
      <section
        aria-labelledby="not-a-host-heading"
        className={`${CARD_CLASS_NAME} flex w-full max-w-[440px] flex-col gap-4`}
      >
        <ClubLogo />
        <h1
          id="not-a-host-heading"
          className="text-[32px] font-extrabold tracking-[-0.01em]"
        >
          You&apos;re not a host here
        </h1>
        <p className="text-muted">
          {email ? (
            <>
              You&apos;re signed in as{" "}
              <strong className="font-semibold text-text">{email}</strong>,
              which isn&apos;t on the hosts list.
            </>
          ) : (
            "This account isn't on the hosts list."
          )}{" "}
          Ask your social manager for an invite.
        </p>
        <form action={signOut}>
          <button
            type="submit"
            className={`${OUTLINE_BUTTON_CLASS_NAME} w-full`}
          >
            Sign out
          </button>
        </form>
      </section>
    </main>
  );
}
