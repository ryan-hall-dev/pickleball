import Link from "next/link";
import { InitialsAvatar } from "@/components/InitialsAvatar";
import type { MemberListEntry } from "@/server/members/memberDirectory";
import { SKILL_LEVEL_LABELS } from "@/server/members/memberSearch";
import { formatLastCheckedIn } from "./formatLastCheckedIn";

/** One directory card (the setup design's member row); opens the edit page. */
export function MemberCard({
  member,
  now,
}: {
  member: MemberListEntry;
  now: Date;
}) {
  const fullName = `${member.firstName} ${member.lastName}`;
  const lastCheckedIn = formatLastCheckedIn(member.lastCheckedInAt, now);
  return (
    <li>
      <Link
        href={`/members/${member.id}`}
        className={`flex min-h-[60px] items-center gap-2.5 rounded-2xl border bg-inner px-3 py-2 hover:border-outline ${
          member.isActive
            ? "border-inner-border"
            : "border-dashed border-outline"
        }`}
      >
        <InitialsAvatar name={fullName} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[15px] font-semibold">{fullName}</span>
          {/* One line keeps every card the same height; "Deactivated" comes first so it's never cut off. */}
          <span className="truncate text-xs text-muted">
            {/* Status in words, never colour alone. */}
            {member.isActive ? lastCheckedIn : `Deactivated · ${lastCheckedIn}`}
          </span>
        </span>
        {member.skillLevel ? (
          <span className="shrink-0 rounded-full bg-inner-border px-2 py-[3px] text-xs font-semibold text-text-soft">
            {SKILL_LEVEL_LABELS[member.skillLevel]}
          </span>
        ) : (
          <span className="shrink-0 rounded-full border border-inner-border px-2 py-[3px] text-xs font-semibold text-muted">
            No level
          </span>
        )}
      </Link>
    </li>
  );
}
