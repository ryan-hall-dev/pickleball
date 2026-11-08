import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { z } from "zod";
import { CARD_CLASS_NAME } from "@/components/controlStyles";
import { readHostAccess } from "@/server/auth/currentHost";
import { getMember } from "@/server/members/memberDirectory";
import { formatLastCheckedIn } from "../formatLastCheckedIn";
import { MemberForm } from "../MemberForm";
import { MemberActiveToggle } from "./MemberActiveToggle";

export const metadata: Metadata = {
  title: "Edit member · Pickleball Social Manager",
};

export default function EditMemberPage({
  params,
}: PageProps<"/members/[memberId]">) {
  return (
    <>
      <Link
        href="/members"
        className="inline-flex min-h-11 items-center self-start font-semibold text-link hover:text-link-hover"
      >
        ← Members
      </Link>
      {/* The member is per-user data (RLS), so it streams in behind its own boundary. */}
      <Suspense
        fallback={
          <p className="text-muted" aria-live="polite">
            Loading member…
          </p>
        }
      >
        <EditMember params={params} />
      </Suspense>
    </>
  );
}

async function EditMember({
  params,
}: {
  params: PageProps<"/members/[memberId]">["params"];
}) {
  const hostAccess = await readHostAccess();
  if (hostAccess.status !== "host") return null;
  const { memberId } = await params;
  if (!z.uuid().safeParse(memberId).success) notFound();
  const member = await getMember(memberId);
  if (!member) notFound();
  const fullName = `${member.firstName} ${member.lastName}`;

  return (
    <>
      <h1 className="text-[32px] font-extrabold tracking-[-0.01em]">
        Edit {fullName}
      </h1>
      <div className="flex flex-wrap items-start gap-4">
        <section
          aria-labelledby="member-details-heading"
          className={`${CARD_CLASS_NAME} flex flex-[999_1_480px] flex-col gap-4`}
        >
          <h2 id="member-details-heading" className="text-xl font-bold">
            Details
          </h2>
          <MemberForm member={member} />
        </section>
        <section
          aria-labelledby="member-status-heading"
          className={`${CARD_CLASS_NAME} flex flex-[1_1_320px] flex-col gap-3`}
        >
          <h2 id="member-status-heading" className="text-xl font-bold">
            Status
          </h2>
          <p>
            <span
              className={`rounded-full px-2.5 py-1 text-xs font-bold ${
                member.isActive
                  ? "bg-lime-surface text-lime-soft"
                  : "bg-inner-border text-text-soft"
              }`}
            >
              {member.isActive ? "ACTIVE" : "DEACTIVATED"}
            </span>
          </p>
          <p className="text-sm text-muted">
            {formatLastCheckedIn(member.lastCheckedInAt, new Date())}.
          </p>
          <p className="text-sm text-muted">
            {member.isActive
              ? "Deactivating hides them from check-in search and the active list. Their session history is kept, and you can reactivate them at any time."
              : "Deactivated: hidden from check-in search and the active list. Reactivate to bring them back."}
          </p>
          <MemberActiveToggle memberId={member.id} isActive={member.isActive} />
        </section>
      </div>
    </>
  );
}
