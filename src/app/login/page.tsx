import type { Metadata } from "next";
import { Suspense } from "react";
import { ClubLogo } from "@/components/ClubLogo";
import { CARD_CLASS_NAME } from "@/components/controlStyles";
import { LoginPanel } from "./LoginPanel";

export const metadata: Metadata = {
  title: "Sign in · Pickleball Social Manager",
  robots: { index: false },
};

export default function LoginPage() {
  return (
    <main className="flex flex-1 items-center justify-center px-5 py-10">
      <div className="flex w-full max-w-[440px] flex-col gap-6">
        <div className="flex items-center gap-3">
          <ClubLogo />
          <span className="text-[19px] font-bold">
            Pickleball Social Manager
          </span>
        </div>
        <section
          aria-labelledby="login-heading"
          className={`${CARD_CLASS_NAME} flex flex-col gap-5`}
        >
          <Suspense
            fallback={
              <p id="login-heading" className="text-muted" aria-live="polite">
                Loading…
              </p>
            }
          >
            <LoginPanel />
          </Suspense>
        </section>
      </div>
    </main>
  );
}
