import { z } from "zod";
import { normalizeMemberSearchText, SKILL_LEVELS } from "./memberSearch";

/** Mirrors the `person_name` domain: trimmed, 1-50 characters, no control characters. */
export const MEMBER_NAME_MAX_LENGTH = 50;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function personNameSchema(emptyMessage: string) {
  return (
    z
      .string()
      // Collapsing runs of spaces (tabs, newlines) keeps "Anne  Marie" and
      // "Anne Marie" the same person for search and duplicate checks.
      .transform((name) => name.replace(/\s+/g, " ").trim())
      .pipe(
        z
          .string()
          .min(1, { error: emptyMessage })
          .max(MEMBER_NAME_MAX_LENGTH, {
            error: `Use at most ${MEMBER_NAME_MAX_LENGTH} characters.`,
          })
          .refine((name) => !CONTROL_CHARACTERS.test(name), {
            error: "Remove special characters.",
          }),
      )
  );
}

/** Add and edit share one form. Skill is optional (members.skill_level is nullable). */
export const memberInputSchema = z.object({
  firstName: personNameSchema("Enter a first name."),
  lastName: personNameSchema("Enter a last name."),
  // "" is the form's "Not set" option.
  skillLevel: z
    .string()
    .transform((skillLevel) => (skillLevel === "" ? null : skillLevel))
    .pipe(
      z
        .enum(SKILL_LEVELS, { error: "Choose a skill level from the list." })
        .nullable(),
    ),
});

export type MemberInput = z.infer<typeof memberInputSchema>;

interface FullName {
  firstName: string;
  lastName: string;
}

/**
 * The full name folded like `members.search_name` (case, accents and spacing
 * ignored), so "Zoë  Núñez" and "zoe nunez" are the same name.
 */
export function memberFullNameKey({ firstName, lastName }: FullName): string {
  return normalizeMemberSearchText(`${firstName} ${lastName}`);
}

/** Whether two names are the same once case, accents and spacing are ignored. */
export function isSameFullName(first: FullName, second: FullName): boolean {
  return memberFullNameKey(first) === memberFullNameKey(second);
}

/**
 * Hidden form field set by "Save anyway" after a duplicate-name warning. Its
 * value is the warned name's key, so it confirms that name only.
 */
export const CONFIRM_DUPLICATE_NAME_FIELD = "confirmDuplicateName";

export function duplicateNameWarning(fullName: string): string {
  return `An active member is already called ${fullName}. Save anyway only if this is a different person.`;
}
