"use client";

import type { ReactNode } from "react";
import { useMessages } from "@/i18n/LocaleProvider";
import { ClubLogo } from "@/components/ClubLogo";
import { LanguageSwitch } from "@/components/LanguageSwitch";
import { SKILL_LEVELS, type SkillLevel } from "@/server/skillLevels";
import {
  INFO_NOTICE_CLASS_NAME,
  SELECTED_LEVEL_OPTION_CLASS_NAME,
  UNSELECTED_LEVEL_OPTION_CLASS_NAME,
} from "./checkinStyles";

/** Logo plus the social's name (or the app's name on P11), and the language switch. */
export function BrandLine({ name }: { name: string }) {
  return (
    <div className="flex min-h-11 items-center gap-3">
      <ClubLogo />
      <span className="min-w-0 flex-1 text-[17px] font-bold break-words">
        {name}
      </span>
      <LanguageSwitch />
    </div>
  );
}

/** Grey "i" notice, e.g. "A host approves each check-in…". */
export function InfoNotice({
  id,
  role,
  children,
}: {
  id?: string;
  role?: "status";
  children: ReactNode;
}) {
  return (
    <div id={id} role={role} className={INFO_NOTICE_CLASS_NAME}>
      <span
        aria-hidden="true"
        className="mt-px flex size-5 shrink-0 items-center justify-center rounded-full bg-inner-border text-xs font-extrabold text-text"
      >
        i
      </span>
      <span>{children}</span>
    </div>
  );
}

/**
 * Beginner / Intermediate / Advanced as pressable buttons (aria-pressed),
 * three across. `isInvalid` adds the 2px orange outline (form).
 */
export function SkillLevelOptions({
  id,
  selectedSkillLevel,
  onSkillLevelPressed,
  labelledById,
  describedById,
  isInvalid = false,
  isDisabled = false,
}: {
  id?: string;
  selectedSkillLevel: SkillLevel | null;
  onSkillLevelPressed: (skillLevel: SkillLevel) => void;
  labelledById: string;
  describedById?: string;
  isInvalid?: boolean;
  isDisabled?: boolean;
}) {
  const messages = useMessages();
  return (
    <div
      id={id}
      role="group"
      aria-labelledby={labelledById}
      aria-describedby={describedById}
      className={`grid grid-cols-3 gap-2 rounded-[14px] ${
        isInvalid ? "outline-2 outline-offset-4 outline-orange" : ""
      }`}
    >
      {SKILL_LEVELS.map((skillLevel) => {
        const isSelected = skillLevel === selectedSkillLevel;
        return (
          <button
            key={skillLevel}
            type="button"
            aria-pressed={isSelected}
            disabled={isDisabled}
            onClick={() => onSkillLevelPressed(skillLevel)}
            className={
              isSelected
                ? SELECTED_LEVEL_OPTION_CLASS_NAME
                : UNSELECTED_LEVEL_OPTION_CLASS_NAME
            }
          >
            {messages.levels[skillLevel]}
          </button>
        );
      })}
    </div>
  );
}
