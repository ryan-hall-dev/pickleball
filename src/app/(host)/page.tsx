import Link from "next/link";
import { Suspense } from "react";
import { CARD_CLASS_NAME } from "@/components/controlStyles";
import { readHostAccess } from "@/server/auth/currentHost";

export default function HostHomePage() {
  return (
    <section
      aria-labelledby="host-home-heading"
      className={`${CARD_CLASS_NAME} flex flex-col gap-2`}
    >
      <h1
        id="host-home-heading"
        className="text-[32px] font-extrabold tracking-[-0.01em]"
      >
        {/* The name is per-user, so it streams in behind its own boundary. */}
        <Suspense fallback="Welcome">
          <WelcomeHeadingText />
        </Suspense>
      </h1>
      <p className="text-muted">
        Session setup and live courts arrive in the next milestones. Manage who
        can host on the{" "}
        <Link href="/hosts" className="text-link hover:text-link-hover">
          Hosts
        </Link>{" "}
        page.
      </p>
    </section>
  );
}

async function WelcomeHeadingText() {
  const hostAccess = await readHostAccess();
  return hostAccess.status === "host"
    ? `Welcome, ${hostAccess.host.displayName}`
    : "Welcome";
}
