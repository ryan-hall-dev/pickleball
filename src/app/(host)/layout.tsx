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
import { LanguageSwitch } from "@/components/LanguageSwitch";
import { getLocale } from "@/i18n/getLocale";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { MESSAGES, type Messages } from "@/i18n/messages";
import { HostMenu } from "./HostMenu";
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
      {/* Before the language is known: both. */}
      <p className="text-muted" aria-live="polite">
        Loading… · <span lang="vi">Đang tải…</span>
      </p>
    </main>
  );
}

/** The gate reads the session, so it sits behind Suspense (cacheComponents). */
async function HostGate({ children }: { children: ReactNode }) {
  const [hostAccess, locale] = await Promise.all([
    readHostAccess(),
    getLocale(),
  ]);
  if (hostAccess.status === "signed_out") redirect("/login");
  const messages = MESSAGES[locale];
  if (hostAccess.status === "not_a_host") {
    return (
      <LocaleProvider initialLocale={locale}>
        <NotAHostNotice email={hostAccess.email} messages={messages} />
      </LocaleProvider>
    );
  }
  const { host } = hostAccess;
  const text = messages.host.header;

  return (
    <LocaleProvider initialLocale={locale}>
      {/* Below 1024px: compact sizes and a 52px sticky bar with the ☰ menu
          (docs/plans/mobile-compact-ui.md). */}
      <div className="host-compact flex flex-1 flex-col">
        <header className="border-b border-card-border bg-bg-header compact:sticky compact:top-0 compact:z-20">
          <div className="relative mx-auto flex max-w-[1440px] flex-wrap items-center gap-x-6 gap-y-3 px-7 py-3 compact:h-[52px] compact:flex-nowrap compact:gap-2 compact:py-0 compact:pr-2 compact:pl-3.5">
            <Link
              href="/setup"
              className="flex min-h-11 min-w-0 items-center gap-3 rounded-xl compact:flex-1 compact:gap-2.5"
            >
              <ClubLogo className="compact:size-7" />
              {/* The social's own name (decision D1); the app name stays on
                /login and in tab titles. */}
              <span className="text-[19px] font-bold compact:truncate compact:text-base">
                {host.socialName}
              </span>
            </Link>
            <div className="compact:hidden">
              <HostNav />
            </div>
            <div className="ml-auto flex flex-wrap items-center gap-3 compact:flex-nowrap compact:gap-1">
              <LanguageSwitch compactBelowDesktop />
              <div className="contents compact:hidden">
                <HostIdentity
                  displayName={host.displayName}
                  roleLabel={
                    host.role === "manager" ? text.socialManager : text.host
                  }
                />
                <form action={signOut}>
                  <button type="submit" className={OUTLINE_BUTTON_CLASS_NAME}>
                    {text.signOut}
                  </button>
                </form>
              </div>
              <HostMenu>
                <HostNav layout="column" />
                <div className="flex items-center gap-3 border-t border-card-border px-1 pt-3">
                  <HostIdentity
                    displayName={host.displayName}
                    roleLabel={
                      host.role === "manager" ? text.socialManager : text.host
                    }
                  />
                </div>
                <form action={signOut}>
                  <button
                    type="submit"
                    className={`${OUTLINE_BUTTON_CLASS_NAME} w-full`}
                  >
                    {text.signOut}
                  </button>
                </form>
              </HostMenu>
            </div>
          </div>
        </header>
        <main className="mx-auto flex w-full max-w-[1440px] flex-1 flex-col gap-4 px-7 pt-6 pb-12 compact:gap-2.5 compact:px-3 compact:pt-3 compact:pb-8">
          {children}
        </main>
      </div>
    </LocaleProvider>
  );
}

function HostIdentity({
  displayName,
  roleLabel,
}: {
  displayName: string;
  roleLabel: string;
}) {
  return (
    <>
      <InitialsAvatar name={displayName} />
      <span className="text-sm text-muted">
        {roleLabel} ·{" "}
        <span className="font-semibold text-text">{displayName}</span>
      </span>
    </>
  );
}

function NotAHostNotice({
  email,
  messages,
}: {
  email: string | null;
  messages: Messages;
}) {
  const text = messages.host.notAHost;
  return (
    <main className="flex flex-1 items-center justify-center px-5 py-10">
      <section
        aria-labelledby="not-a-host-heading"
        className={`${CARD_CLASS_NAME} flex w-full max-w-[440px] flex-col gap-4`}
      >
        <ClubLogo />
        <h1
          id="not-a-host-heading"
          className="text-[32px] font-extrabold tracking-[-0.01em] compact:text-[17px] compact:font-bold compact:tracking-normal"
        >
          {text.title}
        </h1>
        <p className="text-muted">
          {email ? (
            <>
              {text.signedInAsBefore}{" "}
              <strong className="font-semibold text-text">{email}</strong>
              {text.signedInAsAfter}
            </>
          ) : (
            text.accountNotListed
          )}{" "}
          {text.askForInvite}
        </p>
        <form action={signOut}>
          <button
            type="submit"
            className={`${OUTLINE_BUTTON_CLASS_NAME} w-full`}
          >
            {messages.host.header.signOut}
          </button>
        </form>
      </section>
    </main>
  );
}
