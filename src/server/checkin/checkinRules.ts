import { z } from "zod";
import { personNameSchema } from "@/server/members/memberRules";
import {
  normalizeMemberSearchText,
  SKILL_LEVELS,
  type SkillLevel,
} from "@/server/members/memberSearch";

// Pure input rules for the public check-in page (/t/<tag>). Shared by the
// server actions (the real check) and the browser (the guest form's inline
// errors), so no server-only imports.

/** Same pattern as `socials.checkin_tag`; anything else is an inactive link. */
export const checkinTagSchema = z.string().regex(/^[a-z0-9_-]{16,64}$/);

/** search_checkin_names lists nothing for fewer letters (plan: privacy). */
export const MIN_SEARCH_LETTERS = 2;
/** search_checkin_names returns at most this many names. */
export const MAX_SEARCH_MATCHES = 5;
/** search_checkin_names refuses longer queries once folded. */
const MAX_SEARCH_QUERY_LENGTH = 50;

/**
 * Whether a typed query is long enough to search: at least 2 characters once
 * case, accents and spacing are folded (as the database folds it).
 */
export function isSearchableQuery(nameQuery: string): boolean {
  return normalizeMemberSearchText(nameQuery).length >= MIN_SEARCH_LETTERS;
}

export const searchQuerySchema = z
  .string()
  .max(MAX_SEARCH_QUERY_LENGTH * 2)
  .refine(
    (nameQuery) =>
      normalizeMemberSearchText(nameQuery).length <= MAX_SEARCH_QUERY_LENGTH,
  );

const skillLevelSchema = z.enum(SKILL_LEVELS, { error: "Choose your level" });

/** A guest (first-timer): all three fields required (acceptance criterion 6). */
export const guestCheckinInputSchema = z.object({
  kind: z.literal("guest"),
  firstName: personNameSchema("Enter your first name"),
  lastName: personNameSchema("Enter your last name"),
  skillLevel: skillLevelSchema,
});

/**
 * A member picked from search or recognised on this phone. The names are the
 * ones the page was given for that member (submit_checkin needs them and
 * checks the member id belongs to the social). `updatedSkillLevel` is the
 * optional "Update your level" choice; null keeps the saved level.
 */
export const memberCheckinInputSchema = z.object({
  kind: z.literal("member"),
  memberId: z.uuid(),
  firstName: personNameSchema("Enter your first name"),
  lastName: personNameSchema("Enter your last name"),
  updatedSkillLevel: z.enum(SKILL_LEVELS).nullable(),
});

export const checkinSubmitInputSchema = z.discriminatedUnion("kind", [
  guestCheckinInputSchema,
  memberCheckinInputSchema,
]);

export type CheckinSubmitInput = z.input<typeof checkinSubmitInputSchema>;
export type GuestCheckinInput = z.output<typeof guestCheckinInputSchema>;

export interface GuestFormValues {
  firstName: string;
  lastName: string;
  skillLevel: SkillLevel | null;
}

export type GuestFormField = keyof GuestFormValues;
export type GuestFormFieldErrors = Partial<Record<GuestFormField, string>>;

export type GuestFormValidation =
  | { isValid: true; input: GuestCheckinInput }
  | { isValid: false; fieldErrors: GuestFormFieldErrors };

/** The guest form's check, with the copy deck's messages per field. */
export function validateGuestForm(
  values: GuestFormValues,
): GuestFormValidation {
  const parsed = guestCheckinInputSchema.safeParse({
    kind: "guest",
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
    },
  };
}
