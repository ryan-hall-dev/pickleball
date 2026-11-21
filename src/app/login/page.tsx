import type { Metadata } from "next";
import { Suspense } from "react";
import { ClubLogo } from "@/components/ClubLogo";
import { CARD_CLASS_NAME } from "@/components/controlStyles";
import { LanguageSwitch } from "@/components/LanguageSwitch";
import { ThemeSwitch } from "@/components/ThemeSwitch";
import { getLocale, hostPageTitle } from "@/i18n/getLocale";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { LoginPanel } from "./LoginPanel";

export async function generateMetadata(): Promise<Metadata> {
  return { title: await hostPageTitle("signIn"), robots: { index: false } };
}

export default function LoginPage() {
  return (
    <main className="host-compact flex flex-1 items-center justify-center px-5 py-10">
      <div className="flex w-full max-w-[440px] flex-col gap-6">
        {/* The language comes from the request, so it streams in. */}
        <Suspense
          fallback={
            <p className="text-muted" aria-live="polite">
              Loading… · <span lang="vi">Đang tải…</span>
            </p>
          }
        >
          <LoginContent />
        </Suspense>
      </div>
    </main>
  );
}

async function LoginContent() {
  return (
    <LocaleProvider initialLocale={await getLocale()}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <ClubLogo />
          <span className="text-[19px] font-bold">
            Pickleball Social Manager
          </span>
        </div>
        <div className="flex items-center gap-2">
          <ThemeSwitch />
          <LanguageSwitch />
        </div>
      </div>
      <section
        aria-labelledby="login-heading"
        className={`${CARD_CLASS_NAME} flex flex-col gap-5`}
      >
        <LoginPanel />
      </section>
    </LocaleProvider>
  );
}
