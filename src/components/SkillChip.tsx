import {
  SKILL_LEVEL_LABELS,
  type SkillLevel,
} from "@/server/members/memberSearch";

/** A member's skill level as a small grey chip ("No level" when unknown). */
export function SkillChip({ skillLevel }: { skillLevel: SkillLevel | null }) {
  return skillLevel ? (
    <span className="shrink-0 rounded-full bg-inner-border px-2 py-[3px] text-xs font-semibold text-text-soft">
      {SKILL_LEVEL_LABELS[skillLevel]}
    </span>
  ) : (
    <span className="shrink-0 rounded-full border border-inner-border px-2 py-[3px] text-xs font-semibold text-muted">
      No level
    </span>
  );
}
