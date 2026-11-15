import { z } from "zod";
import {
  genderSchema,
  type Gender,
  personNameSchema,
} from "@/server/participantRules";
import { SKILL_LEVELS, type SkillLevel } from "@/server/skillLevels";

// Pure input rules for the public check-in page (/t/<tag>). Shared by the
// server actions (the real check) and the browser (the form's inline
// errors), so no server-only imports.

/** Same pattern as `socials.checkin_tag`; anything else is an inactive link. */
export const checkinTagSchema = z.string().regex(/^[a-z0-9_-]{16,64}$/);

const skillLevelSchema = z.enum(SKILL_LEVELS, { error: "Choose your level" });

/** Every participant: all four fields required (acceptance criterion 6). */
export const participantCheckinInputSchema = z.object({
  firstName: personNameSchema("Enter your first name"),
  lastName: personNameSchema("Enter your last name"),
  skillLevel: skillLevelSchema,
  gender: genderSchema,
});

export const checkinSubmitInputSchema = participantCheckinInputSchema.extend({
  sessionId: z.uuid(),
});

export type CheckinSubmitInput = z.input<typeof participantCheckinInputSchema>;
export type ParticipantCheckinInput = z.output<
  typeof participantCheckinInputSchema
>;

export interface CheckinFormValues {
  firstName: string;
  lastName: string;
  skillLevel: SkillLevel | null;
  gender: Gender | null;
}

export type CheckinFormField = keyof CheckinFormValues;
export type CheckinFormFieldErrors = Partial<Record<CheckinFormField, string>>;

export type CheckinFormValidation =
  | { isValid: true; input: ParticipantCheckinInput }
  | { isValid: false; fieldErrors: CheckinFormFieldErrors };

/** The form's check, with the copy deck's messages per field. */
export function validateCheckinForm(
  values: CheckinFormValues,
): CheckinFormValidation {
  const parsed = participantCheckinInputSchema.safeParse({
    ...values,
  });
  if (parsed.success) return { isValid: true, input: parsed.data };
  const fieldErrors = z.flattenError(parsed.error).fieldErrors;
  return {
    isValid: false,
    fieldErrors: {
      firstName: fieldErrors.firstName?.[0],
      lastName: fieldErrors.lastName?.[0],
      skillLevel: fieldErrors.skillLevel?.[0],
      gender: fieldErrors.gender?.[0],
    },
  };
}
