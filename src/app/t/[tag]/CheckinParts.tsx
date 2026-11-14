import type { ReactNode } from "react";
import { ClubLogo } from "@/components/ClubLogo";
import {
  SKILL_LEVEL_LABELS,
  SKILL_LEVELS,
  type SkillLevel,
} from "@/server/skillLevels";
import {
  INFO_NOTICE_CLASS_NAME,
  SELECTED_LEVEL_OPTION_CLASS_NAME,
  UNSELECTED_LEVEL_OPTION_CLASS_NAME,
} from "./checkinStyles";

/** P11 shows the app's name: an inactive link reveals no social. */
export const APP_NAME = "Pickleball Social Manager";

/** Logo plus the social's name (or the app's name on P11). */
export function BrandLine({ name }: { name: string }) {
  return (
    <div className="flex min-h-11 items-center gap-3">
      <ClubLogo />
      <span className="min-w-0 text-[17px] font-bold break-words">{name}</span>
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

export const HOST_APPROVES_NOTE =
  "A host approves each check-in before you're added to today's players.";

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
            {SKILL_LEVEL_LABELS[skillLevel]}
          </button>
        );
      })}
    </div>
  );
}
