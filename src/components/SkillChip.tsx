"use client";

import { useMessages } from "@/i18n/LocaleProvider";
import type { SkillLevel } from "@/server/skillLevels";

/** A member's skill level as a small grey chip ("No level" when unknown). */
export function SkillChip({ skillLevel }: { skillLevel: SkillLevel | null }) {
  const messages = useMessages();
  return skillLevel ? (
    <span className="shrink-0 rounded-full bg-inner-border px-2 py-[3px] text-xs font-semibold text-text-soft">
      {messages.levels[skillLevel]}
    </span>
  ) : (
    <span className="shrink-0 rounded-full border border-inner-border px-2 py-[3px] text-xs font-semibold text-muted">
      {messages.host.skillChip.noLevel}
    </span>
  );
}
