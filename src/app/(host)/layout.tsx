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
          <div className="ml-auto flex flex-wrap items-center gap-3">
            <LanguageSwitch />
            <InitialsAvatar name={host.displayName} />
            <span className="text-sm text-muted">
              {host.role === "manager" ? text.socialManager : text.host} ·{" "}
              <span className="font-semibold text-text">
                {host.displayName}
              </span>
            </span>
            <form action={signOut}>
              <button type="submit" className={OUTLINE_BUTTON_CLASS_NAME}>
                {text.signOut}
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-[1440px] flex-1 flex-col gap-4 px-7 pt-6 pb-12">
        {children}
      </main>
    </LocaleProvider>
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
          className="text-[32px] font-extrabold tracking-[-0.01em]"
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
