import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { z } from "zod";
import {
  CARD_CLASS_NAME,
  OUTLINE_BUTTON_CLASS_NAME,
  SECONDARY_BUTTON_CLASS_NAME,
} from "@/components/controlStyles";
import { readHostAccess } from "@/server/auth/currentHost";
import {
  countMembersByStatus,
  getMember,
  listMembers,
} from "@/server/members/memberDirectory";
import {
  buildMemberDirectoryHref,
  DEFAULT_MEMBER_DIRECTORY_QUERY,
  MEMBER_DIRECTORY_PAGE_SIZE,
  parseMemberDirectoryQuery,
  SKILL_LEVEL_LABELS,
  type MemberDirectoryQuery,
} from "@/server/members/memberSearch";
import { MemberCard } from "./MemberCard";
import { MemberDirectoryFilters } from "./MemberDirectoryFilters";
import { SavedMemberNotice } from "./SavedMemberNotice";

export const metadata: Metadata = {
  title: "Members · Pickleball Social Manager",
};

type MembersSearchParams = PageProps<"/members">["searchParams"];

export default function MembersPage({ searchParams }: PageProps<"/members">) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <h1 className="text-[32px] font-extrabold tracking-[-0.01em]">
          Members
        </h1>
        {/* Per-user data streams in behind its own boundaries (cacheComponents). */}
        <Suspense fallback={null}>
          <MemberStatusCounts />
        </Suspense>
        <Link
          href="/members/new"
          className={`${SECONDARY_BUTTON_CLASS_NAME} ml-auto`}
        >
          Add member
        </Link>
      </div>
      <Suspense
        fallback={
          <p className="text-muted" aria-live="polite">
            Loading members…
          </p>
        }
      >
        <MemberDirectory searchParams={searchParams} />
      </Suspense>
    </>
  );
}

function CountChip({ count, label }: { count: number; label: string }) {
  return (
    <span className="rounded-[14px] bg-inner px-3.5 py-2 text-sm">
      <b className="text-lg tabular-nums">{count}</b>{" "}
      <span className="text-muted">{label}</span>
    </span>
  );
}

async function MemberStatusCounts() {
  const hostAccess = await readHostAccess();
  if (hostAccess.status !== "host") return null;
  const { activeMemberCount, deactivatedMemberCount } =
    await countMembersByStatus();
  return (
    <p className="flex flex-wrap gap-2">
      <CountChip count={activeMemberCount} label="active" />
      <CountChip count={deactivatedMemberCount} label="deactivated" />
    </p>
  );
}

function firstSearchParam(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

async function MemberDirectory({
  searchParams,
}: {
  searchParams: MembersSearchParams;
}) {
  const hostAccess = await readHostAccess();
  // Fails closed: only hosts see members (RLS also returns nothing otherwise).
  if (hostAccess.status !== "host") return null;

  const resolvedSearchParams = await searchParams;
  const query = parseMemberDirectoryQuery(resolvedSearchParams);
  const savedMemberIdParam = z
    .uuid()
    .safeParse(firstSearchParam(resolvedSearchParams.saved));
  const [directoryPage, statusCounts, savedMember] = await Promise.all([
    listMembers(query),
    countMembersByStatus(),
    savedMemberIdParam.success ? getMember(savedMemberIdParam.data) : null,
  ]);
  const now = new Date();
  const { members, matchingMemberCount } = directoryPage;
  const hasNoMembersAtAll =
    statusCounts.activeMemberCount + statusCounts.deactivatedMemberCount === 0;

  return (
    <>
      {savedMember && (
        <SavedMemberNotice
          fullName={`${savedMember.firstName} ${savedMember.lastName}`}
        />
      )}
      <section
        aria-label="Member directory"
        className={`${CARD_CLASS_NAME} flex flex-col gap-4`}
      >
        {hasNoMembersAtAll ? (
          <NoMembersYet />
        ) : (
          <>
            <MemberDirectoryFilters query={query} />
            {/* The live region announces results; with no matches the heading below says it on screen. */}
            <p
              aria-live="polite"
              className={`text-sm text-muted tabular-nums ${
                matchingMemberCount === 0 ? "sr-only" : ""
              }`}
            >
              {matchingMemberCount === 0
                ? "No matching members"
                : `Showing ${members.length} of ${matchingMemberCount} ${
                    query.status === "active" ? "active" : "deactivated"
                  } ${matchingMemberCount === 1 ? "member" : "members"}`}
            </p>
            {members.length === 0 ? (
              <NoMatchingMembers query={query} />
            ) : (
              <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(300px,100%),1fr))] gap-2">
                {members.map((member) => (
                  <MemberCard key={member.id} member={member} now={now} />
                ))}
              </ul>
            )}
            {members.length < matchingMemberCount && (
              <Link
                href={buildMemberDirectoryHref({
                  ...query,
                  pageCount: query.pageCount + 1,
                })}
                scroll={false}
                replace
                className={`${OUTLINE_BUTTON_CLASS_NAME} self-center`}
              >
                <span className="tabular-nums">
                  Show{" "}
                  {Math.min(
                    MEMBER_DIRECTORY_PAGE_SIZE,
                    matchingMemberCount - members.length,
                  )}{" "}
                  more
                </span>
              </Link>
            )}
          </>
        )}
      </section>
    </>
  );
}

function NoMembersYet() {
  return (
    <div className="flex flex-col items-start gap-3 py-6">
      <h2 className="text-xl font-bold">No members yet</h2>
      <p className="text-muted">
        Add your first member, or they appear here after their first check-in.
      </p>
      <Link href="/members/new" className={SECONDARY_BUTTON_CLASS_NAME}>
        Add your first member
      </Link>
    </div>
  );
}

function NoMatchingMembers({ query }: { query: MemberDirectoryQuery }) {
  const hasFilters = Boolean(query.searchText || query.skillLevel);
  // e.g. "No active advanced members match “kim”"
  const heading = [
    `No ${query.status === "active" ? "active" : "deactivated"}`,
    query.skillLevel && SKILL_LEVEL_LABELS[query.skillLevel].toLowerCase(),
    "members",
    query.searchText && `match “${query.searchText}”`,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="flex flex-col items-start gap-2 py-6">
      <h2 className="text-xl font-bold">{heading}</h2>
      {hasFilters ? (
        <Link
          href={buildMemberDirectoryHref({
            ...DEFAULT_MEMBER_DIRECTORY_QUERY,
            status: query.status,
          })}
          className="inline-flex min-h-11 items-center font-semibold text-link hover:text-link-hover"
        >
          Clear search and filters
        </Link>
      ) : (
        <p className="text-muted">
          {query.status === "active"
            ? "Everyone is deactivated. Reactivate members from the Deactivated list."
            : "Deactivated members appear here. Nobody is deactivated."}
        </p>
      )}
    </div>
  );
}
