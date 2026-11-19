import { z } from "zod";
import { en } from "@/i18n/messages/en";

/** Mirrors the `person_name` domain: trimmed, 1-50 characters, no control characters. */
export const PERSON_NAME_MAX_LENGTH = 50;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export function personNameSchema(emptyMessage: string) {
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
          .max(PERSON_NAME_MAX_LENGTH, {
            error: en.validation.nameTooLong(PERSON_NAME_MAX_LENGTH),
          })
          .refine((name) => !CONTROL_CHARACTERS.test(name), {
            error: en.validation.nameHasControlCharacters,
          }),
      )
  );
}

export const GENDERS = ["male", "female"] as const;
export type Gender = (typeof GENDERS)[number];
export const GENDER_LABELS: Record<Gender, string> = {
  male: "Male",
  female: "Female",
};
export const genderSchema = z.enum(GENDERS, {
  error: en.validation.genderRequired,
});
