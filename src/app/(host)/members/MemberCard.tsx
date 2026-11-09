import Link from "next/link";
import { InitialsAvatar } from "@/components/InitialsAvatar";
import { SkillChip } from "@/components/SkillChip";
import type { MemberListEntry } from "@/server/members/memberDirectory";
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
        <SkillChip skillLevel={member.skillLevel} />
      </Link>
    </li>
  );
}
